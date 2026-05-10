package gateway

import (
	"errors"
	"fmt"
	"log"
	"regexp"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/dashboards"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// builtinPluginGrafanaName matches the seed entry's Name field. Used as
// the dispatch key for plugin-specific spec rewrites (e.g. baking the
// dashboards we ship into Grafana's values payload).
const builtinPluginGrafanaName = "grafana"

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
			plugin, err := store.GetPluginByName(cp.Plugin.Name)
			if err != nil {
				continue
			}
			cmd := &proto.PluginCommand{
				Action:  "disable",
				CrdName: plugin.Name,
			}
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay disable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			log.Printf("[gateway] replay disable: cluster=%s plugin=%s",
				clusterID, plugin.Name)
		case store.PluginPhasePending,
			store.PluginPhaseInstalling,
			store.PluginPhaseUpgrading,
			store.PluginPhaseFailed:
			if !cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd, err := g.BuildEnableCommand(plugin, cp)
			if err != nil {
				log.Printf("[gateway] replay enable build failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay enable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			log.Printf("[gateway] replay enable: cluster=%s plugin=%s phase=%s",
				clusterID, plugin.Name, cp.Phase)
		}
	}
}

// kpilotPlaceholderRE matches ${KPILOT_<NAME>} where <NAME> is uppercase
// letters / digits / underscores. The narrow charset is intentional —
// Helm values can carry literal `$` (templating, env-var refs); requiring
// the exact KPILOT_ prefix + caps avoids matching real Helm syntax.
var kpilotPlaceholderRE = regexp.MustCompile(`\$\{KPILOT_([A-Z0-9_]+)\}`)

// expandKPilotVars resolves every ${KPILOT_X} token in the values YAML
// against the provided variable map. Unknown tokens are left literal and
// logged (per occurrence) — silent leave-as-is matches shell behavior for
// undefined vars; the log line surfaces typos in the chart's
// default_values so they get noticed.
//
// Adding a new placeholder is one line in the caller's `vars` map.
//
// Caution: substituted values land inside YAML — they MUST NOT contain
// chars that would break parsing (newlines, unbalanced quotes). Today's
// vars (cluster_id = UUID, cluster_domain = DNS name) are all safe by
// construction; future vars carrying user input would need escaping.
func expandKPilotVars(values string, vars map[string]string) string {
	return kpilotPlaceholderRE.ReplaceAllStringFunc(values, func(match string) string {
		name := kpilotPlaceholderRE.FindStringSubmatch(match)[1]
		if v, ok := vars[name]; ok {
			return v
		}
		log.Printf("[plugin] unknown placeholder ${KPILOT_%s} in values, left as-is", name)
		return match
	})
}

// BuildEnableCommand merges the registry plugin's defaults with the per-
// cluster overrides on cp and produces a PluginCommand suitable for
// sending to the Worker. Used by both the EnablePlugin HTTP handler and
// the worker-reconnect replay path; centralizing here ensures the
// placeholder expansion + chart blob lookup happen once with the same
// rules from both call sites.
//
// For local-chart plugins the .tgz blob bytes are inlined — the Worker
// writes them to its chart cache by sha256 so subsequent commands can
// omit `blob`.
//
// Looks up the connected worker's cluster_domain from the gateway map
// rather than taking it as a parameter, so callers don't have to plumb
// it through. Falls back to "cluster.local" when the worker is gone.
func (g *GatewayServer) BuildEnableCommand(p *store.Plugin, cp *store.ClusterPlugin) (*proto.PluginCommand, error) {
	values := cp.ValuesOverride
	if values == "" {
		values = p.DefaultValues
	}

	// Resolve well-known ${KPILOT_*} placeholders before sending. To
	// register a new variable: add one entry below. The names are
	// documented for chart authors:
	//
	//   CLUSTER_ID     — cluster UUID. Used by reverse-proxied plugins
	//                    (Grafana root_url, etc.) so generated links
	//                    route back through /proxy/<plugin>/.
	//   CLUSTER_DOMAIN — K8s DNS suffix reported by the worker. Used by
	//                    chart defaults that hard-code in-cluster Service
	//                    FQDNs. Falls back to "cluster.local" when the
	//                    worker registered without reporting it.
	//
	// Keep tokens ALL_CAPS_WITH_UNDERSCORES so they stay greppable and
	// match the regex's charset.
	workerDomain := "cluster.local"
	if w, ok := g.GetWorker(cp.ClusterID); ok && w.ClusterDomain != "" {
		workerDomain = w.ClusterDomain
	}
	values = expandKPilotVars(values, map[string]string{
		"CLUSTER_ID":     cp.ClusterID,
		"CLUSTER_DOMAIN": workerDomain,
	})

	// Plugin-specific spec rewrites. Today only Grafana — its 700 KB of
	// builtin dashboards are too large to live in the registry row's
	// default_values (would freeze the EnableDrawer YAML editor), so we
	// overlay them here right before the PluginCommand goes out. User
	// values take precedence in deep-merge — they can override or remove
	// any dashboard / provider entry by writing their own.
	if p.Name == builtinPluginGrafanaName {
		merged, err := dashboards.MergeGrafanaExtras(values)
		if err != nil {
			// Don't refuse the install — log and continue with the unmerged
			// values so a YAML parse failure in either source doesn't bring
			// the whole plugin pipeline down. The dashboards just won't be
			// pre-provisioned this time; the user can disable + fix the
			// values + re-enable.
			log.Printf("[gateway] grafana dashboards overlay failed: plugin=%s err=%v", p.Name, err)
		} else {
			values = merged
		}
	}

	version := cp.VersionOverride
	if version == "" {
		version = p.DefaultVersion
	}
	releaseNS := p.DefaultReleaseNamespace
	chart := &proto.ChartSource{
		Type:    string(p.ChartType),
		Name:    p.ChartName,
		Version: version,
	}
	switch p.ChartType {
	case store.ChartTypeRepo, store.ChartTypeOCI:
		// OCI plugins reuse chart_repo for the full oci:// URL.
		chart.Repo = p.ChartRepo
	case store.ChartTypeLocal:
		if p.ChartBlobID == nil {
			return nil, errors.New("local chart has no blob")
		}
		blob, err := store.GetPluginBlobByID(*p.ChartBlobID)
		if err != nil {
			return nil, err
		}
		chart.Sha256 = blob.SHA256
		chart.Blob = blob.Content
	}
	return &proto.PluginCommand{
		Action:  "enable",
		CrdName: p.Name,
		Spec: &proto.PluginSpec{
			PluginId:         fmt.Sprintf("%d", p.ID),
			DisplayName:      p.DisplayName,
			Chart:            chart,
			ReleaseName:      p.Name,
			ReleaseNamespace: releaseNS,
			Values:           values,
		},
	}, nil
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
		if _, err := store.DeleteDisabledClusterPlugin(w.ClusterID, plugin.ID); err != nil {
			log.Printf("[gateway] delete disabled cluster plugin: cluster=%s plugin=%s err=%v",
				w.ClusterID, st.CrdName, err)
		}
		return
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

	// Upsert (not just Update) self-heals the rare path where the Enable
	// handler successfully pushed to the Worker but the subsequent
	// ClusterPlugin row write failed. Without this the Worker would
	// reconcile happily while Server kept reporting "Disabled" and the
	// AttemptHash gate blocked any retry.
	if err := store.UpsertClusterPluginStatus(w.ClusterID, plugin.ID, phase, updates); err != nil {
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
