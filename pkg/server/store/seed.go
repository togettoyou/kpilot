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
		Name:        "hami",
		DisplayName: "HAMi",
		Description: "GPU virtualization & vGPU scheduling. NOTE: before enabling, set scheduler.kubeScheduler.image.tag to your cluster's Kubernetes version (e.g. v1.30.0) — HAMi runs a sidecar kube-scheduler that needs the matching image.",
		Category:    PluginCategoryGPU,
		IsBuiltin:   true,
		SortOrder:   10,
		IconURL:     "",
		ChartType:   ChartTypeRepo,
		ChartRepo:   "https://project-hami.github.io/HAMi/",
		ChartName:   "hami",
		// Pin chart 2.8.1 (app v2.8.1).
		DefaultVersion: "2.8.1",
		// Three image groups expose registry/repo so private-mirror
		// users have ready hooks. The kube-scheduler tag is left empty
		// on purpose — it MUST match the cluster's K8s version (e.g.
		// v1.30.0), and there's no sensible cluster-agnostic default;
		// the comment in the YAML guides the operator. Without a real
		// value here the chart falls back to AppVersion which pulls
		// kube-scheduler:2.8.1 (doesn't exist) and the install fails.
		DefaultValues: `scheduler:
  kubeScheduler:
    image:
      registry: registry.cn-hangzhou.aliyuncs.com
      repository: google_containers/kube-scheduler
      # REQUIRED: set to match your cluster's Kubernetes version,
      # e.g. v1.30.0. Run "kubectl version" to find it.
      tag: ""
devicePlugin:
  image:
    registry: docker.io
    repository: projecthami/hami
  monitor:
    image:
      registry: docker.io
      repository: projecthami/hami
`,
		DefaultReleaseNamespace: "kpilot-gpu",
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
		DefaultReleaseNamespace: "kpilot-monitoring",
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
		DefaultReleaseNamespace: "kpilot-monitoring",
	},
	{
		Name:        "envoy-gateway",
		DisplayName: "Envoy Gateway",
		Description: "K8s Gateway API implementation built on Envoy. Pulled from Docker Hub's OCI registry — first builtin to use ChartType=oci, which is also how most modern projects (Cilium, Karmada, Tanzu, etc.) ship their charts these days.",
		Category:    PluginCategoryNetworking,
		IsBuiltin:   true,
		SortOrder:   10,
		ChartType:   ChartTypeOCI,
		// Full oci:// URL; ChartName is unused for OCI references.
		// docker.io public mirror; matches the upstream README example
		// `helm install eg oci://docker.io/envoyproxy/gateway-helm \
		//   --version v1.7.2 -n envoy-gateway-system --create-namespace`.
		ChartRepo:      "oci://docker.io/envoyproxy/gateway-helm",
		DefaultVersion: "v1.7.2",
		// Two override hooks pre-filled in the form so private-mirror
		// users have somewhere obvious to land:
		//
		// 1. deployment.envoyGateway.image.repository: full registry+path
		//    (the chart doesn't split it into registry/repository the way
		//    HAMi/VM do — it's one field). Swap to e.g.
		//    `your-mirror.example.com/envoyproxy/gateway` and you're done.
		//
		// 2. tag empty → chart uses its appVersion, matching --version
		//    exactly. Leaving it blank avoids the "tag must match k8s
		//    version" foot-gun HAMi has.
		//
		// Resource requests are sized for a small dev cluster; envoy
		// gateway's controller is a thin Go process so defaults are
		// modest. Keep limits soft (memory only, no CPU limit) — Envoy's
		// reconcile loops can briefly burst.
		DefaultValues: `deployment:
  replicas: 1
  envoyGateway:
    image:
      repository: docker.io/envoyproxy/gateway
      tag: ""
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        memory: 1Gi
`,
		// kpilot-networking matches the kpilot-* convention all other
		// builtins use (kpilot-gpu / kpilot-monitoring / kpilot-logging).
		// Workload page treats kpilot-* as read-only so users can't
		// accidentally `kubectl delete deployment` an Envoy controller
		// pod from the list. The chart respects --namespace, so we're
		// not bound to upstream's "envoy-gateway-system" suggestion.
		DefaultReleaseNamespace: "kpilot-networking",
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
		DefaultReleaseNamespace: "kpilot-logging",
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
