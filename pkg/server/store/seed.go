package store

import (
	"errors"

	"gorm.io/gorm"
)

// builtin lists the plugins we ship out of the box. They are seeded on
// startup if absent and refreshed on every boot if the row exists, since
// `is_builtin=true` plugins are immutable from the user's perspective —
// they shouldn't drift from the values defined here.
//
// Adding a new builtin: append to this slice. Removing one: leave it here
// (deletion is intentional and rare; if you really mean it, do it with a
// migration).
var builtinPlugins = []Plugin{
	{
		Name:                    "hami",
		DisplayName:             "HAMi",
		Description:             "GPU virtualization & vGPU scheduling for Kubernetes.",
		Category:                PluginCategoryGPU,
		IsBuiltin:               true,
		SortOrder:               10,
		IconURL:                 "",
		ChartType:               ChartTypeRepo,
		ChartRepo:               "https://project-hami.github.io/HAMi/",
		ChartName:               "hami",
		DefaultVersion:          "",
		DefaultValues:           "",
		DefaultReleaseNamespace: "kube-system",
	},
	{
		Name:        "victoria-metrics",
		DisplayName: "VictoriaMetrics",
		Description: "Single-node TSDB for cluster metrics — long-term storage with a built-in Web UI. Pair with the victoria-metrics-agent plugin to scrape Kubernetes targets.",
		Category:    PluginCategoryMonitoring,
		IsBuiltin:   true,
		// Primary metrics backend — show ahead of its supporting
		// node-exporter companion within the monitoring category.
		SortOrder: 10,
		ChartType:   ChartTypeRepo,
		ChartRepo:   "https://victoriametrics.github.io/helm-charts/",
		// victoria-metrics-single is the lightweight option (one
		// vmsingle pod). The previous victoria-metrics-k8s-stack
		// umbrella shipped operator + Grafana + Alertmanager + a
		// dozen CRDs, which we found to be heavy for a default
		// install and prone to webhook race conditions on first
		// rollout. Users who want the full stack can add a custom
		// plugin row.
		ChartName: "victoria-metrics-single",
		// Pin a known-good chart version so an upstream release
		// can't break first-boot installs unexpectedly.
		DefaultVersion: "0.37.0",
		// Tighter PV + resource defaults so the install fits a
		// dev/small cluster out of the box. server.scrape.enabled=true
		// turns on vmsingle's built-in Prometheus-style scraping so
		// metrics start flowing immediately without needing a separate
		// vmagent — the chart's bundled scrape config covers
		// apiserver / nodes / pods. Users override per cluster via
		// the Enable drawer.
		//
		// image.registry / image.repository are spelled out (matching
		// the chart's defaults) so operators behind a private mirror
		// can swap them without having to dig the chart values.yaml
		// out — they're already in the form, ready to edit.
		DefaultValues: `server:
  image:
    registry: ""
    repository: victoriametrics/victoria-metrics
  retentionPeriod: "1"
  persistentVolume:
    size: 10Gi
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 2Gi
  scrape:
    enabled: true
`,
		DefaultReleaseNamespace: "monitoring",
	},
	{
		Name:        "node-exporter",
		DisplayName: "Node Exporter",
		Description: "Node-level hardware & OS metrics (CPU, memory, disk I/O, filesystem, network, load average). Required for the standard Grafana 'Node Exporter Full' dashboard and most node-focused monitoring queries — the kubelet/cadvisor stream alone doesn't cover this.",
		Category:    PluginCategoryMonitoring,
		IsBuiltin:   true,
		// Companion to VictoriaMetrics; render after it in the list.
		SortOrder: 20,
		ChartType:   ChartTypeRepo,
		ChartRepo:   "https://prometheus-community.github.io/helm-charts/",
		ChartName:   "prometheus-node-exporter",
		// Pin a known-good chart version (chart 4.55.0 → app v1.11.1).
		DefaultVersion: "4.55.0",
		// Two overrides on top of the chart defaults:
		//
		// 1. image.registry: the chart pulls from quay.io by default,
		//    which is unreliable from CN networks. Docker Hub mirrors
		//    the same official image at prom/node-exporter, identical
		//    binary, much more reliably reachable.
		//
		// 2. service.annotations.prometheus.io/port: the chart sets
		//    "prometheus.io/scrape: true" but not the port. Our
		//    bundled VM scrape config has a `keep_if_equal` relabel
		//    that requires the annotation port to match the container
		//    port; without an explicit "9100" the target gets dropped
		//    silently and node metrics never flow into VM.
		DefaultValues: `image:
  registry: docker.io
  repository: prom/node-exporter
service:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9100"
`,
		DefaultReleaseNamespace: "monitoring",
	},
	{
		Name:        "victoria-logs",
		DisplayName: "VictoriaLogs",
		Description: "Cluster log storage with a built-in Web UI; the bundled Vector DaemonSet collects every pod's logs and ships them via the Elasticsearch-compatible insert API. Out-of-box logging pipeline.",
		Category:    PluginCategoryLogging,
		IsBuiltin:   true,
		SortOrder:   10,
		ChartType:   ChartTypeRepo,
		ChartRepo:   "https://victoriametrics.github.io/helm-charts/",
		ChartName:   "victoria-logs-single",
		// Pin a known-good chart version so upstream re-tagging
		// can't break first-boot installs.
		DefaultVersion: "0.12.4",
		// Mirror the VM-single shape: image registry/repository spelled
		// out so operators behind a private mirror have a ready hook in
		// the Enable drawer; tighter PV + dev-friendly resource caps;
		// vector.enabled=true turns on the bundled log-shipping
		// DaemonSet — chart auto-points its elasticsearch sink at the
		// vlogs server URL. Disable per-cluster if a restricted Pod
		// Security profile rejects vector's hostPath /var/log mount.
		DefaultValues: `server:
  image:
    registry: ""
    repository: victoriametrics/victoria-logs
  retentionPeriod: "1"
  persistentVolume:
    size: 10Gi
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 2Gi
vector:
  enabled: true
`,
		DefaultReleaseNamespace: "logging",
	},
}

// SeedBuiltinPlugins upserts the builtin entries on startup. Built-ins are
// keyed by `name` (DNS-compatible, also doubles as the CRD metadata.name);
// existing rows are updated to match the latest hard-coded definition so
// fixes ship with the next deploy.
func SeedBuiltinPlugins(db *gorm.DB) error {
	for _, want := range builtinPlugins {
		var existing Plugin
		err := db.Where("name = ?", want.Name).First(&existing).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			if err := db.Create(&want).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			// Refresh fields that come from the binary (chart metadata,
			// description, default values) — never touch user-controlled
			// state, but built-ins don't really have any.
			updates := map[string]any{
				"display_name":              want.DisplayName,
				"description":               want.Description,
				"category":                  want.Category,
				"is_builtin":                true,
				"sort_order":                want.SortOrder,
				"icon_url":                  want.IconURL,
				"chart_type":                want.ChartType,
				"chart_repo":                want.ChartRepo,
				"chart_name":                want.ChartName,
				"default_version":           want.DefaultVersion,
				"default_values":            want.DefaultValues,
				"default_release_namespace": want.DefaultReleaseNamespace,
			}
			if err := db.Model(&existing).Updates(updates).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
