package gateway

import (
	"fmt"
	"log"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

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
		// PluginCommand has no per-instance request_id (state is keyed by
		// crd_name on the Worker side); leave it empty.
		Payload: &proto.ServerMessage_PluginCmd{PluginCmd: cmd},
	})
}

// handlePluginStatus persists a status push from the Worker. The Worker
// connection identifies the cluster, so we don't trust any cluster_id in
// the payload (there isn't one anyway).
func (g *GatewayServer) handlePluginStatus(w *ConnectedWorker, st *proto.PluginStatusPush) {
	plugin, err := store.GetPluginByName(st.CrdName)
	if err != nil {
		// Worker reported status for a plugin name we don't know — likely
		// a registry row got deleted while a CRD lingered. Log and drop.
		log.Printf("[gateway] plugin status for unknown plugin: cluster=%s crd=%s err=%v",
			w.ClusterID, st.CrdName, err)
		return
	}

	// Empty phase is the reconciler's "release uninstalled, CRD gone" beat;
	// translate to Disabled so the NOT NULL column constraint is satisfied
	// (DB defaults only fire on INSERT, not Updates).
	phase := store.PluginPhase(st.Phase)
	if phase == "" {
		phase = store.PluginPhaseDisabled
	}
	updates := map[string]any{
		"phase":                phase,
		"message":              capStatusMessage(st.Message),
		"observed_version":     st.ObservedVersion,
		"observed_values_hash": st.ObservedValuesHash,
		"helm_revision":        st.HelmRevision,
	}
	if st.InstalledAt > 0 {
		t := time.Unix(st.InstalledAt, 0)
		updates["installed_at"] = &t
	}

	if err := store.UpdateClusterPluginStatus(w.ClusterID, plugin.ID, updates); err != nil {
		log.Printf("[gateway] update cluster plugin status: cluster=%s plugin=%s err=%v",
			w.ClusterID, st.CrdName, err)
	}
}

// capStatusMessage trims very long Helm error messages — they can carry the
// full release manifest and bloat the DB row + every poll response from the
// per-cluster page. 4 KiB is plenty for the actual error text.
const maxStatusMessageBytes = 4096

func capStatusMessage(s string) string {
	if len(s) <= maxStatusMessageBytes {
		return s
	}
	return s[:maxStatusMessageBytes] + "\n…(truncated)"
}
