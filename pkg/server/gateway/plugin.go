package gateway

import (
	"fmt"
	"log"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/pluginservice"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// Plugin command building + status persistence moved to
// pkg/server/pluginservice — the gateway is the gRPC transport boundary
// and shouldn't be the place that knows how to merge Grafana
// dashboards or write ClusterPlugin rows. This file keeps the
// transport-side concerns: re-pushing pending commands on worker
// reconnect, the one-way SendPluginCommand wrapper, and the
// handlePluginStatus shim that delegates persistence.

// ClusterDomain implements pluginservice.ClusterDomainResolver by
// looking up the connected worker's reported DNS suffix. Returns
// empty when the worker is gone; pluginservice falls back to
// "cluster.local" in that case.
func (g *GatewayServer) ClusterDomain(clusterID string) string {
	if w, ok := g.GetWorker(clusterID); ok && w.ClusterDomain != "" {
		return w.ClusterDomain
	}
	return ""
}

// BuildEnableCommand keeps a method on the gateway for backward
// compatibility with existing handlers — it forwards to pluginservice
// with the gateway itself as the cluster-domain resolver. New code
// can call pluginservice.BuildEnableCommand directly.
func (g *GatewayServer) BuildEnableCommand(p *store.Plugin, cp *store.ClusterPlugin) (*proto.PluginCommand, error) {
	return pluginservice.BuildEnableCommand(p, cp, g)
}

// replayPendingPluginCommands re-pushes plugin commands for any
// (cluster, plugin) row whose state on Server suggests an action is in
// flight that the (just-reconnected) Worker may not know about.
//
// Triggered after Worker registration. Without it, a Disable click
// landing during a Worker restart got stranded — the command went out
// over the dying stream, the new Worker session had no record of it,
// the CRD on the cluster never saw a delete, and UI sat permanently at
// Uninstalling.
//
// What we replay:
//   - enabled=false && phase=Uninstalling           → re-push disable
//   - enabled=true && phase one of {Pending, Installing, Upgrading,
//     Failed} → re-push enable (rebuilt from current overrides)
//
// Skipped: phase=Running (steady state, nothing pending),
// phase=Disabled (no row would exist), and rows whose `enabled` flag
// disagrees with their phase (a Disable+Enable racing in quick
// succession can land enabled=true while phase still says Uninstalling
// — replaying the disable in that state would clobber the user's
// re-enable intent).
//
// Best-effort: errors are logged, not propagated; the next user action
// would push again anyway. A panic in this goroutine would otherwise
// crash the gateway process — recover so a malformed row can't take
// the whole server down.
func (g *GatewayServer) replayPendingPluginCommands(clusterID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[gateway] replay panic: cluster=%s panic=%v", clusterID, r)
		}
	}()
	rows, err := store.ListClusterPlugins(clusterID)
	if err != nil {
		log.Printf("[gateway] replay: list cluster plugins failed: cluster=%s err=%v",
			clusterID, err)
		return
	}
	// Throttle: sleep between actual sends so a worker reconnect with
	// N enabled plugins doesn't spike memory by pushing N × chart-blob
	// into the gRPC send buffer in a tight loop. Local-chart enable
	// commands carry the full .tgz bytes (up to ~5 MB each); 6 builtins
	// at once is 30 MB on the wire — manageable but worth spreading.
	// 100ms between sends keeps total replay under ~3s for any
	// realistic plugin count while leaving steady-state idle. The
	// `sent` flag means rows that early-`continue` don't burn the
	// pause budget.
	const replayPause = 100 * time.Millisecond
	sent := false
	maybePause := func() {
		if sent {
			time.Sleep(replayPause)
		}
	}
	for i := range rows {
		cp := &rows[i]
		switch cp.Phase {
		case store.PluginPhaseUninstalling:
			// Symmetric with the enable case below: only replay if the
			// row's `enabled` actually agrees that the user wants this
			// plugin gone. enabled=true with phase=Uninstalling means a
			// concurrent re-enable already overwrote the row; replaying
			// the disable would clobber that intent.
			if cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd := &proto.PluginCommand{
				Action:  "disable",
				CrdName: plugin.Name,
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay disable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			log.Printf("[gateway] replay disable: cluster=%s plugin=%s",
				clusterID, plugin.Name)
		case store.PluginPhasePending,
			store.PluginPhaseInstalling,
			store.PluginPhaseUpgrading:
			// Failed is intentionally NOT replayed: it's a terminal
			// "user must do something" state — re-pushing the same
			// PluginCommand wouldn't change the CRD generation, the
			// reconciler's predicate filters status-only events, so
			// nothing happens on the worker. The user fixes Failed by
			// editing values / version (which bumps the spec) or by
			// disable+re-enable.
			if !cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd, err := pluginservice.BuildEnableCommand(plugin, cp, g)
			if err != nil {
				log.Printf("[gateway] replay enable build failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay enable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			log.Printf("[gateway] replay enable: cluster=%s plugin=%s phase=%s",
				clusterID, plugin.Name, cp.Phase)
		}
	}
}

// SendPluginCommand pushes a one-way command (enable/disable) to the
// connected Worker. Plugins use a fire-and-forget pattern — the Worker
// reports back asynchronously via PluginStatusPush, so there's no
// pending-response channel here. Caller must rely on PluginStatusPush
// (or polling the ClusterPlugin row) to observe the outcome.
func (g *GatewayServer) SendPluginCommand(clusterID string, cmd *proto.PluginCommand) error {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return fmt.Errorf("cluster %s not connected", clusterID)
	}

	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	return w.Stream.Send(&proto.ServerMessage{
		// PluginCommand has no per-instance request_id (state is keyed
		// by crd_name on the Worker side); leave it empty.
		Payload: &proto.ServerMessage_PluginCmd{PluginCmd: cmd},
	})
}

// handlePluginStatus thinly forwards the worker's status push to
// pluginservice for persistence. The connected worker identifies the
// cluster (we don't trust any cluster_id from the wire). Errors are
// logged inside pluginservice + here for the gateway audit trail;
// status pushes are best-effort so we don't retry or propagate.
func (g *GatewayServer) handlePluginStatus(w *ConnectedWorker, st *proto.PluginStatusPush) {
	if err := pluginservice.PersistStatus(w.ClusterID, st); err != nil {
		log.Printf("[gateway] plugin status persist: cluster=%s crd=%s err=%v",
			w.ClusterID, st.CrdName, err)
	}
}
