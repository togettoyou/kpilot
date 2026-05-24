// Package gateway — plugin command transport + status push handling.
//
// v2 surface:
//   SendPluginCommand → opens STREAM_PLUGIN_COMMAND, writes the
//   PluginCommand frame, then the chart .tgz blob bytes (if any),
//   half-closes, reads back PluginCommandAck. Status updates flow
//   back asynchronously on worker-initiated STREAM_PLUGIN_STATUS_PUSH
//   streams (handled in dispatchInboundStream).
//
// pluginservice.Command (v1 proto types) gets converted to v2 at
// the wire boundary; the high-level service code is transport-
// agnostic.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/pluginservice"
	"github.com/togettoyou/kpilot/pkg/server/store"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var pluginLog = kplog.L("gateway")

// pluginCommandAckTimeout caps the wait for the worker's
// receipt-ack on a PluginCommand. Worker contract: ack
// IMMEDIATELY after parsing the frame + writing the chart
// blob to disk; the Helm install / uninstall runs async and
// posts its progress + final state via STREAM_PLUGIN_STATUS_PUSH
// frames. So this timeout only covers blob-write + a small
// validation pass — generous 60s tolerates a slow disk on the
// worker side (5 MiB chart blob with default fsync). v1 was
// fire-and-forget on the wire (no ack at all); v2 adds the ack
// so the HTTP handler can surface "worker didn't receive the
// command" instead of silently succeeding.
const pluginCommandAckTimeout = 60 * time.Second

// ClusterDomain implements ClusterDomainResolver (used by
// pluginservice when expanding ${KPILOT_CLUSTER_DOMAIN}
// placeholders in values YAML).
func (g *GatewayServer) ClusterDomain(clusterID string) string {
	if w, ok := g.GetWorker(clusterID); ok && w.ClusterDomain != "" {
		return w.ClusterDomain
	}
	return ""
}

// ErrPluginRejected is returned by SendPluginCommand when the worker
// receives the command but explicitly rejects it (Ack.Success=false)
// — e.g. blob sha256 mismatch, cache write failure. Distinct from
// transport-level errors (worker disconnect, stream open failure)
// so callers can map it to a different surface error code instead of
// the misleading CLUSTER_NOT_CONNECTED. Wrap with the worker's
// message via errors.Is + .Error() for the user-facing string.
var ErrPluginRejected = errors.New("plugin rejected")

// SendPluginCommand opens a STREAM_PLUGIN_COMMAND stream, ships
// the command + (for local-chart enables) the .tgz blob, then
// reads back PluginCommandAck. Returns when the worker confirms
// receipt — NOT when Helm finishes. Helm install / uninstall
// outcomes arrive asynchronously via STREAM_PLUGIN_STATUS_PUSH.
//
// Gzip is OFF — chart .tgz is already gzip-compressed and a
// second pass would just add CPU without saving bytes.
func (g *GatewayServer) SendPluginCommand(clusterID string, cmd *pluginservice.Command) error {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return fmt.Errorf("cluster %s not connected", clusterID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), pluginCommandAckTimeout)
	defer cancel()
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_PLUGIN_COMMAND, uuid.NewString(), false)
	if err != nil {
		return fmt.Errorf("open plugin stream: %w", err)
	}
	defer st.Close()
	applyCtxDeadline(ctx, st)

	wire := &pbv2.PluginCommand{
		Action:        cmd.Action,
		CrdName:       cmd.CrdName,
		Spec:          cmd.Spec,
		ChartBlobSize: int64(len(cmd.Blob)),
	}
	if err := st.WriteMsg(wire); err != nil {
		return fmt.Errorf("write plugin cmd: %w", err)
	}
	if len(cmd.Blob) > 0 {
		if _, err := st.Writer().Write(cmd.Blob); err != nil {
			return fmt.Errorf("write chart blob: %w", err)
		}
	}
	if err := st.CloseWrite(); err != nil {
		return fmt.Errorf("half-close plugin req: %w", err)
	}

	var ack pbv2.PluginCommandAck
	if err := st.ReadMsg(&ack); err != nil {
		return g.mapStreamErr(clusterID, err, "read plugin ack")
	}
	if !ack.GetSuccess() {
		return fmt.Errorf("%w: %s", ErrPluginRejected, ack.GetError())
	}
	return nil
}

// handlePluginStatus persists a status push. Called from
// dispatchInboundStream when a worker opens a
// STREAM_PLUGIN_STATUS_PUSH stream.
func (g *GatewayServer) handlePluginStatus(w *ConnectedWorker, st *pbv2.PluginStatusPush) {
	if err := pluginservice.PersistStatus(w.ClusterID, st); err != nil {
		pluginLog.Warnf("plugin status persist: cluster=%s crd=%s err=%v",
			w.ClusterID, st.GetCrdName(), err)
	}
}

// replayPendingPluginCommands re-pushes plugin commands after
// a worker reconnects. See the (preserved) v1 doc comment in
// the original implementation; logic unchanged, just the inner
// transport call is v2 now.
func (g *GatewayServer) replayPendingPluginCommands(clusterID string) {
	defer func() {
		if r := recover(); r != nil {
			pluginLog.Errorf("replay panic: cluster=%s panic=%v", clusterID, r)
		}
	}()
	rows, err := store.ListClusterPlugins(clusterID)
	if err != nil {
		pluginLog.Warnf("replay: list cluster plugins failed: cluster=%s err=%v",
			clusterID, err)
		return
	}
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
			if cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd := &pluginservice.Command{
				Action:  "disable",
				CrdName: plugin.Name,
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				pluginLog.Warnf("replay disable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			pluginLog.Infof("replay disable: cluster=%s plugin=%s",
				clusterID, plugin.Name)
		case store.PluginPhasePending,
			store.PluginPhaseInstalling,
			store.PluginPhaseUpgrading:
			if !cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd, err := pluginservice.BuildEnableCommand(plugin, cp, g)
			if err != nil {
				pluginLog.Warnf("replay enable build failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				pluginLog.Warnf("replay enable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			pluginLog.Infof("replay enable: cluster=%s plugin=%s phase=%s",
				clusterID, plugin.Name, cp.Phase)
		}
	}
}

