// Package dashboards bundles the dashboard JSONs that KPilot pre-provisions
// into the Grafana plugin on enable. Server-side only — Worker never sees
// these files; they're injected into the plugin's values payload by
// gateway.BuildEnableCommand before the PluginCommand goes out the wire.
//
// Why server-side overlay rather than baking into seed.go's default_values:
// the JSONs are ~700 KB combined, so including them in the registry row's
// default_values would make the EnableDrawer YAML editor unusable (huge
// scroll, slow CodeMirror parse, every keystroke re-tokenizes the blob).
// Keeping them out of default_values means users see clean tunable values
// in the UI; the dashboards land at install time as a transparent overlay.
package dashboards

import (
	_ "embed"
	"fmt"

	"sigs.k8s.io/yaml"
)

//go:embed builtin/node-exporter-full.json
var nodeExporterFullJSON string

//go:embed builtin/victoria-logs-explorer.json
var victoriaLogsExplorerJSON string

//go:embed builtin/nvidia-dcgm.json
var nvidiaDCGMJSON string

// dashboardKey is the chart's per-dashboard map key. Doubles as the
// auto-generated ConfigMap suffix; keep it DNS-1123 safe.
type dashboardKey string

const (
	keyNodeExporterFull   dashboardKey = "node-exporter-full"
	keyVictoriaLogsExplor dashboardKey = "victoria-logs-explorer"
	keyNVIDIADCGM         dashboardKey = "nvidia-dcgm"
)

// MergeGrafanaExtras takes the user-facing values YAML and overlays the
// dashboard provisioning blocks on top: the file-based provider config
// plus one dashboards.<provider>.<key> entry per builtin JSON. Returns
// the merged YAML.
//
// Merge rules: user keys win over extras when both are scalars or when
// types disagree; matching map subtrees are deep-merged. Concretely:
//   - User can override the provider config entirely by setting their own
//     dashboardProviders.dashboardproviders.yaml
//   - User can override individual dashboards by setting
//     dashboards.default.<key> with their own json/file
//   - Anything user didn't touch falls through from the overlay
func MergeGrafanaExtras(userValues string) (string, error) {
	user := map[string]any{}
	if userValues != "" {
		if err := yaml.Unmarshal([]byte(userValues), &user); err != nil {
			return "", fmt.Errorf("parse grafana values: %w", err)
		}
	}
	overlay := buildGrafanaOverlay()
	deepMerge(user, overlay)
	out, err := yaml.Marshal(user)
	if err != nil {
		return "", fmt.Errorf("marshal merged values: %w", err)
	}
	return string(out), nil
}

// buildGrafanaOverlay constructs the dashboard provisioning structure as
// a Go map so we get well-formed YAML out of yaml.Marshal — string-
// templating an entire YAML document with embedded JSON would be too
// fragile around indentation of the multiline block scalars.
func buildGrafanaOverlay() map[string]any {
	provider := map[string]any{
		"name":            "default",
		"orgId":           1,
		"folder":          "",
		"type":            "file",
		"disableDeletion": false,
		"editable":        true,
		"options": map[string]any{
			"path": "/var/lib/grafana/dashboards/default",
		},
	}
	return map[string]any{
		"dashboardProviders": map[string]any{
			"dashboardproviders.yaml": map[string]any{
				"apiVersion": 1,
				"providers":  []any{provider},
			},
		},
		"dashboards": map[string]any{
			"default": map[string]any{
				string(keyNodeExporterFull): map[string]any{
					"json": nodeExporterFullJSON,
				},
				string(keyVictoriaLogsExplor): map[string]any{
					"json": victoriaLogsExplorerJSON,
				},
				// NVIDIA DCGM Exporter dashboard (Grafana ID 12239,
				// UID Oxed_c6Wz). Pre-processed: __inputs / __requires
				// import-only blocks stripped and "${DS_PROMETHEUS}"
				// placeholders rewritten to the literal datasource name
				// "VictoriaMetrics" so the file-provisioned dashboard
				// loads without going through Grafana's import flow.
				string(keyNVIDIADCGM): map[string]any{
					"json": nvidiaDCGMJSON,
				},
			},
		},
	}
}

// deepMerge writes src's entries into dst, recursing into matching maps.
// User values (dst) win over overlay (src) for non-map collisions. Adapted
// for our specific shape: dashboards are maps all the way down, so we
// never hit list-merge ambiguities.
func deepMerge(dst, src map[string]any) {
	for k, sv := range src {
		dv, exists := dst[k]
		if !exists {
			dst[k] = sv
			continue
		}
		dvMap, dvIsMap := dv.(map[string]any)
		svMap, svIsMap := sv.(map[string]any)
		if dvIsMap && svIsMap {
			deepMerge(dvMap, svMap)
			continue
		}
		// User had a non-map value here — keep it, don't overwrite.
	}
}
