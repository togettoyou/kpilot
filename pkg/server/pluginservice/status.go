package pluginservice

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// PersistStatus persists a Worker → Server plugin status push into
// the cluster_plugins table. Previously inlined in the gateway; pulled
// here so the gateway can stay transport-only.
//
// The Worker connection identifies the cluster, so cluster_id is a
// caller-supplied arg, not something we trust from the wire payload
// (the push struct doesn't carry it anyway). Errors are logged here
// and returned for the caller's optional inspection; gateway swallows
// the error since plugin status is best-effort.
func PersistStatus(clusterID string, st *proto.PluginStatusPush) error {
	plugin, err := store.GetPluginByName(st.CrdName)
	if err != nil {
		// Worker reported status for a plugin name we don't know —
		// likely a registry row got deleted while a CRD lingered. Log
		// and drop; the worker will eventually stop emitting status
		// when its own reconciler GCs the CRD.
		log.Printf("[pluginservice] status for unknown plugin: cluster=%s crd=%s err=%v",
			clusterID, st.CrdName, err)
		return fmt.Errorf("unknown plugin %q: %w", st.CrdName, err)
	}

	// Empty phase is the reconciler's "release uninstalled, CRD gone"
	// beat. Disabled rows are deleted entirely (not kept around as
	// phase=Disabled) so a fresh re-enable starts with registry
	// defaults instead of inheriting the prior values_override.
	phase := store.PluginPhase(st.Phase)
	if phase == "" {
		phase = store.PluginPhaseDisabled
	}
	if phase == store.PluginPhaseDisabled {
		// Conditional delete: only if enabled=false. If the user
		// re-enabled while this uninstall was still in flight, the
		// new row has enabled=true and we must not wipe it.
		if _, err := store.DeleteDisabledClusterPlugin(clusterID, plugin.ID); err != nil {
			log.Printf("[pluginservice] delete disabled cluster plugin: cluster=%s plugin=%s err=%v",
				clusterID, st.CrdName, err)
			return err
		}
		return nil
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

	// PersistClusterPluginStatusIfActive does the "don't downgrade a
	// user-disabled row to a non-Uninstalling phase" predicate AND the
	// upsert inside a single DB transaction. Previously these were two
	// separate calls and a concurrent EnablePlugin (sets enabled=true)
	// landing between them could see its row clobbered back by a late
	// status echo from the worker's previous Disable. The transactional
	// variant closes that window. Upsert (not Update) self-heals the
	// rare path where Enable pushed to the Worker but the subsequent
	// row write failed — otherwise Server reports "Disabled" forever
	// and the AttemptHash gate blocks any retry.
	skipped, err := store.PersistClusterPluginStatusIfActive(clusterID, plugin.ID, phase, updates)
	if err != nil {
		log.Printf("[pluginservice] update cluster plugin status: cluster=%s plugin=%s err=%v",
			clusterID, st.CrdName, err)
		return err
	}
	if skipped {
		log.Printf("[pluginservice] late status echo ignored (user already disabled): cluster=%s plugin=%s phase=%s",
			clusterID, st.CrdName, phase)
	}
	return nil
}

// capStatusMessage trims very long Helm error messages — they can
// carry the full release manifest and bloat the DB row + every poll
// response from the per-cluster page. 4 KiB is plenty for the actual
// error text. Trim is UTF-8 safe so operator output with Chinese /
// non-ASCII doesn't render as � on the frontend.
const maxStatusMessageBytes = 4096

func capStatusMessage(s string) string {
	if len(s) <= maxStatusMessageBytes {
		return s
	}
	return strings.ToValidUTF8(s[:maxStatusMessageBytes], "") + "\n…(truncated)"
}
