// Package pluginservice owns the plugin command lifecycle that was
// previously baked into the gateway package. The gateway is supposed
// to be the gRPC transport boundary — but `BuildEnableCommand` reached
// into the dashboards / store packages to merge built-in Grafana
// dashboards and look up local-chart blobs, and `handlePluginStatus`
// wrote ClusterPlugin rows directly. Pulling those into pluginservice
// returns the gateway to pure transport and lets handlers + gateway
// share the same command-build / status-persist logic without
// duplicate code paths.
//
// Dependency direction: pluginservice → store, pluginservice →
// dashboards, gateway → pluginservice. Gateway is the consumer; it
// passes a ClusterDomainResolver so pluginservice can look up the
// connected worker's reported DNS suffix without depending on the
// gateway package (which would otherwise be circular).
package pluginservice

import (
	"errors"
	"fmt"
	"log"
	"regexp"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/dashboards"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// ClusterDomainResolver gives pluginservice a way to discover the
// connected worker's reported DNS suffix without taking a direct
// dependency on the gateway package. The gateway implements this with
// its existing GetWorker + ClusterDomain field; callers can pass nil
// for environments without a live worker (we fall back to
// "cluster.local").
type ClusterDomainResolver interface {
	ClusterDomain(clusterID string) string
}

// builtinPluginGrafanaName matches the seed entry's Name field. Used
// as the dispatch key for plugin-specific spec rewrites (e.g. baking
// the dashboards we ship into Grafana's values payload).
const builtinPluginGrafanaName = "grafana"

// kpilotPlaceholderRE matches ${KPILOT_<NAME>} where <NAME> is uppercase
// letters / digits / underscores. The narrow charset is intentional —
// Helm values can carry literal `$` (templating, env-var refs); requiring
// the exact KPILOT_ prefix + caps avoids matching real Helm syntax.
var kpilotPlaceholderRE = regexp.MustCompile(`\$\{KPILOT_([A-Z0-9_]+)\}`)

// expandKPilotVars resolves every ${KPILOT_X} token in the values YAML
// against the provided variable map. Unknown tokens are left literal
// and logged (per occurrence) — silent leave-as-is matches shell
// behavior for undefined vars; the log line surfaces typos in chart
// default_values so they get noticed.
//
// Caution: substituted values land inside YAML — they MUST NOT contain
// chars that would break parsing (newlines, unbalanced quotes). Today's
// vars (cluster_id = UUID, cluster_domain = DNS name) are safe by
// construction; future vars carrying user input would need escaping.
func expandKPilotVars(values string, vars map[string]string) string {
	return kpilotPlaceholderRE.ReplaceAllStringFunc(values, func(match string) string {
		name := kpilotPlaceholderRE.FindStringSubmatch(match)[1]
		if v, ok := vars[name]; ok {
			return v
		}
		log.Printf("[pluginservice] unknown placeholder ${KPILOT_%s} in values, left as-is", name)
		return match
	})
}

// BuildEnableCommand merges the registry plugin's defaults with the
// per-cluster overrides on cp and produces a PluginCommand suitable
// for sending to the Worker. Called by both the EnablePlugin HTTP
// handler and the gateway's worker-reconnect replay path; centralizing
// here ensures placeholder expansion + chart blob lookup happen once
// with the same rules from every call site.
//
// For local-chart plugins the .tgz blob bytes are inlined — the Worker
// writes them to its chart cache by sha256 so subsequent commands can
// omit `blob`.
//
// `resolver` provides the connected worker's cluster_domain so the
// ${KPILOT_CLUSTER_DOMAIN} placeholder can resolve. Nil resolver (or a
// resolver that returns "") falls back to "cluster.local".
func BuildEnableCommand(p *store.Plugin, cp *store.ClusterPlugin, resolver ClusterDomainResolver) (*proto.PluginCommand, error) {
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
	//                    resolver returns empty.
	//
	// Keep tokens ALL_CAPS_WITH_UNDERSCORES so they stay greppable and
	// match the regex's charset.
	workerDomain := "cluster.local"
	if resolver != nil {
		if d := resolver.ClusterDomain(cp.ClusterID); d != "" {
			workerDomain = d
		}
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
			log.Printf("[pluginservice] grafana dashboards overlay failed: plugin=%s err=%v", p.Name, err)
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
