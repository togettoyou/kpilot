package store

import (
	"errors"
	"fmt"

	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/server/plugins"
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
		Name:        "metrics-server",
		DisplayName: "Metrics Server",
		Description: "K8s Metrics API (metrics.k8s.io) implementation — powers kubectl top, HorizontalPodAutoscaler, VerticalPodAutoscaler, and KPilot's realtime CPU/memory readings on the node page. Different from kube-state-metrics: this exposes per-pod / per-node CPU + memory consumption (a snapshot) sourced from kubelet, while KSM exposes K8s object state (Deployment replicas, Pod phase, etc.) for Prometheus scraping.",
		Category:    PluginCategoryMonitoring,
		IsBuiltin:   true,
		// Foundational tier — most other monitoring builtins consume what
		// metrics-server provides (HPA targets, kubectl top, etc.), so
		// render it first in the monitoring category.
		SortOrder:      5,
		ChartType:      ChartTypeRepo,
		ChartRepo:      "https://kubernetes-sigs.github.io/metrics-server/",
		ChartName:      "metrics-server",
		DefaultVersion: "3.13.0",
		// args (separate from chart's defaultArgs which the chart appends
		// automatically) — `--kubelet-insecure-tls` is the dev-cluster
		// blocker. OrbStack, kind, k3s and most local clusters use a
		// self-signed kubelet cert; without this flag metrics-server
		// can't scrape /metrics/resource and `kubectl top` returns
		// "Metrics API not available". On managed clusters with proper
		// kubelet PKI the user can drop this in the Enable drawer.
		// Image registry/repository spelled out so private-mirror users
		// have a ready hook (matches the shape of every other monitoring
		// builtin).
		DefaultValues: `image:
  repository: registry.k8s.io/metrics-server/metrics-server
  pullPolicy: IfNotPresent
args:
  - --kubelet-insecure-tls
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    memory: 512Mi
`,
		DefaultReleaseNamespace: "kpilot-monitoring",
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
		Name:        "kube-state-metrics",
		DisplayName: "kube-state-metrics",
		Description: "Cluster-state metrics for K8s objects (Deployments, Pods, Nodes, PVCs, Jobs, etc.) — exposes counts, conditions, and timestamps as Prometheus metrics. Pairs with node-exporter (host metrics) and Volcano scheduler metrics for a complete picture.",
		Category:    PluginCategoryMonitoring,
		IsBuiltin:   true,
		// Slot between node-exporter (host metrics, 20) and Grafana
		// (visualization, 30) — visual order matches the data flow.
		SortOrder:      25,
		ChartType:      ChartTypeRepo,
		ChartRepo:      "https://prometheus-community.github.io/helm-charts/",
		ChartName:      "kube-state-metrics",
		DefaultVersion: "7.3.0",
		// image.registry / image.repository spelled out so private-mirror
		// users have a ready hook in the Enable drawer (matching the
		// pattern of every other monitoring builtin). prometheusScrape
		// is the chart's flag for adding the prometheus.io/scrape
		// annotation; we additionally pin prometheus.io/port=8080 so VM's
		// scrape config (which uses keep_if_equal on the port annotation,
		// same as node-exporter at 9100) doesn't silently drop the target.
		DefaultValues: `image:
  registry: registry.k8s.io
  repository: kube-state-metrics/kube-state-metrics
  pullPolicy: IfNotPresent
prometheusScrape: true
service:
  port: 8080
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    memory: 512Mi
`,
		DefaultReleaseNamespace: "kpilot-monitoring",
	},
	{
		Name:        "grafana",
		DisplayName: "Grafana",
		Description: "Dashboards & visualization for cluster metrics. Pre-wired for KPilot reverse-proxy embedding (auth.proxy + sub-path) and with VictoriaMetrics as the default Prometheus-compatible datasource — install victoria-metrics first so Grafana finds it on first launch. Login is via the embedded session — auth.proxy auto-creates Admin users from KPilot's logged-in user. The chart's auto-generated admin password is in Secret <release>-grafana for kubectl-port-forward debugging if you ever need it.",
		Category:    PluginCategoryMonitoring,
		IsBuiltin:   true,
		// Renders after VictoriaMetrics (10) and Node Exporter (20)
		// inside the monitoring category — Grafana sits on top of the
		// metrics pipeline so the visual order matches the data flow.
		SortOrder: 30,
		// OCI is the chart authors' preferred distribution channel
		// (per the README on artifacthub.io). Mirrors Envoy Gateway's
		// OCI setup so we keep coverage for both repo and OCI install
		// paths in the builtin set.
		ChartType: ChartTypeOCI,
		// ghcr.io is the official mirror; chart 12.3.0 → app v13.0.1.
		ChartRepo:      "oci://ghcr.io/grafana-community/helm-charts/grafana",
		DefaultVersion: "12.3.0",
		// Defaults below mirror the shape of other monitoring builtins:
		//
		// - image.registry / image.repository spelled out so private-
		//   mirror users have a ready hook in the Enable drawer.
		// - admin creds intentionally NOT set: chart auto-generates a
		//   random password into Secret <release>-grafana. KPilot's
		//   monitoring page logs users in via auth.proxy, so nobody
		//   inside KPilot ever needs the password — only kubectl-port-
		//   forward debugging would, and that path can read the Secret.
		// - persistence enabled with a 10Gi PVC — Grafana stores
		//   dashboards/datasources in SQLite by default, losing them on
		//   pod restart is a worse first-run experience than a small PV.
		// - resources sized for a small dev cluster, same shape as VM /
		//   VL (modest requests, soft memory limit, no CPU limit).
		// - defaultDashboardsEnabled=true pulls in the chart-bundled
		//   community dashboards (~10 starter panels) so monitoring
		//   isn't an empty page right after install.
		// - datasources pre-provisions the VictoriaMetrics datasource at
		//   the Service URL the victoria-metrics-single chart produces
		//   when installed via the "victoria-metrics" plugin name in
		//   namespace kpilot-monitoring (Service name pattern is
		//   <release>-victoria-metrics-single-server). If the user
		//   renames the VM plugin or reassigns the namespace, edit this
		//   URL in the Enable drawer accordingly.
		// - grafana.ini wires up the five ini sections KPilot's reverse-
		//   proxy embedding depends on:
		//   • [security] allow_embedding=true — Grafana sends X-Frame-
		//     Options:deny by default; without this, even same-origin
		//     iframes are blocked.
		//   • [auth.proxy] enabled=true + auto_sign_up=true — KPilot
		//     Server's reverse proxy injects X-WEBAUTH-USER:<kpilot user>
		//     and Grafana auto-creates a matching account on first hit.
		//     Means the user never sees a Grafana login page from inside
		//     KPilot.
		//   • [auth.anonymous] enabled=false — explicitly off so a
		//     missing X-WEBAUTH-USER header isn't silently accepted as
		//     "anonymous Viewer".
		//   • [users] auto_assign_org_role=Admin — controls the role
		//     the auth.proxy auto-created user gets. Grafana defaults to
		//     Viewer, which can't add datasources or edit dashboards;
		//     KPilot is a single-tenant admin tool, so Admin matches
		//     intent. Without this, a user logging in via KPilot would
		//     find Grafana mysteriously read-only.
		//   • [server] serve_from_sub_path=true + relative root_url with
		//     ${KPILOT_CLUSTER_ID} — the placeholder is replaced by the
		//     Server before the PluginCommand goes out (see
		//     buildEnableCommand). Grafana then knows its own URL prefix
		//     and rewrites every link/redirect to include it. Relative
		//     (path-only) URL is required here because the absolute form
		//     %(domain)s expands to Grafana's pod-internal name, which
		//     is wrong for a browser hitting KPilot's HTTP frontend.
		DefaultValues: `image:
  registry: docker.io
  repository: grafana/grafana
  tag: ""
# Bootstrap admin username — kept distinct from KPilot's own username
# space (default ADMIN_USERNAME=kpilot) so the auth.proxy login doesn't
# collide with the chart's bootstrap user. Without this rename, KPilot's
# "admin" user would map onto the chart's "admin" Admin, then auto_assign_
# org_role: Viewer would try to demote them and fail with "cannot remove
# last organization admin", surfacing as 401 on every dashboard load.
# The chart still auto-generates the password into Secret <release>-grafana
# for kubectl-port-forward debug.
adminUser: kpilot-grafana-admin
service:
  type: ClusterIP
  port: 80
persistence:
  type: pvc
  enabled: true
  size: 10Gi
  accessModes:
    - ReadWriteOnce
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: "1"
    memory: 1Gi
defaultDashboardsEnabled: true
# Grafana plugins fetched from grafana.com on install. Adding the
# VictoriaLogs datasource here makes the bundled VictoriaLogs Explorer
# dashboard work out of the box (its panels declare type=
# victoriametrics-logs-datasource which Grafana would otherwise refuse
# to render). Plugin is signed by the official catalog so no
# allow_loading_unsigned_plugins flag is needed.
plugins:
  - victoriametrics-logs-datasource
datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: VictoriaMetrics
        type: prometheus
        access: proxy
        url: http://victoria-metrics-victoria-metrics-single-server.kpilot-monitoring.svc.${KPILOT_CLUSTER_DOMAIN}:8428
        isDefault: true
        jsonData:
          httpMethod: POST
      # VictoriaLogs datasource — wired up so the bundled logging
      # dashboard works once the VictoriaLogs plugin is enabled. URL
      # follows the same pattern as VictoriaMetrics: the chart's
      # release name is the plugin name ("victoria-logs") and the
      # service suffix is "victoria-logs-single-server" (chart 0.12.4).
      # Falls into "no data" / connect-refused if VictoriaLogs isn't
      # enabled — that's fine, the logging page's dep check blocks
      # the iframe until both Grafana and VL are Running anyway.
      - name: VictoriaLogs
        type: victoriametrics-logs-datasource
        access: proxy
        url: http://victoria-logs-victoria-logs-single-server.kpilot-logging.svc.${KPILOT_CLUSTER_DOMAIN}:9428
grafana.ini:
  security:
    allow_embedding: true
  server:
    serve_from_sub_path: true
    root_url: "/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/"
  users:
    # Auto-created users from auth.proxy land as Viewer — they can open
    # bundled dashboards and panels but can't add datasources, edit
    # dashboards, or change Grafana settings. KPilot's own pages are
    # the supported way to manage configuration; the embedded Grafana
    # is for consumption only. If a user genuinely needs to author
    # dashboards, the chart-generated admin password in Secret
    # <release>-grafana is the escape hatch.
    auto_assign_org_role: Viewer
    # Follow the OS / browser dark-mode preference. "system" makes
    # Grafana watch prefers-color-scheme at runtime and flip its theme
    # without an iframe reload, so it tracks day/night automatically.
    # Only sets the DEFAULT for newly auto-created accounts; existing
    # users keep whatever they previously chose. Available since
    # Grafana v10.
    default_theme: system
  auth.anonymous:
    enabled: false
  auth.proxy:
    enabled: true
    header_name: X-WEBAUTH-USER
    header_property: username
    auto_sign_up: true
  live:
    # Grafana Live's WebSocket endpoint (used by realtime panels) checks
    # the browser's Origin header against the request's same-origin by
    # default. KPilot embeds Grafana in an iframe served from KPilot's
    # own domain, so the browser sends Origin=<kpilot-host> which never
    # matches Grafana's pod-internal address. "*" trusts the reverse
    # proxy fronting Grafana — safe here because KPilot's JWT
    # middleware is what actually authenticates the request before it
    # ever reaches the WS dial on Worker.
    allowed_origins: "*"
`,
		DefaultReleaseNamespace: "kpilot-monitoring",
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
	{
		Name:        "volcano",
		DisplayName: "Volcano",
		Description: "Batch scheduler for Kubernetes — gang scheduling, queue-based fair share (DRF), priority & preemption. Foundation for AI/ML training and HPC workloads where a job's pods must all start together or none at all.",
		Category:    PluginCategoryScheduling,
		IsBuiltin:   true,
		SortOrder:   10,
		// Volcano publishes through a Helm repo (helm-charts.volcano.sh).
		// Chart version 1.14.2 ships app v1.14.2 — keep them in lockstep
		// since Volcano releases the chart and binary together.
		ChartType:      ChartTypeRepo,
		ChartRepo:      "https://volcano-sh.github.io/helm-charts",
		ChartName:      "volcano",
		DefaultVersion: "1.14.2",
		// The chart's upstream `image_tag_version` is "latest" which would
		// pull a moving target on first install — pin to v1.14.2 so the
		// app version matches the chart pin above. image_registry +
		// per-component image names are spelled out so private-mirror
		// users have a ready hook (same shape as the other monitoring
		// builtins). image_pull_policy
		// flipped from chart default Always → IfNotPresent: with a pinned
		// tag, Always just costs an extra registry round-trip on every
		// pod start.
		//
		// `custom.metrics_enable` is intentionally NOT set — it's the
		// chart's all-in-one observability flag that spins up its own
		// Prometheus + Grafana + kube-state-metrics. KPilot already
		// installs VictoriaMetrics + Grafana via separate plugins, so
		// turning this on would give us a duplicate monitoring stack.
		// The controller and scheduler still expose /metrics endpoints
		// (controller_metrics_enable / scheduler_metrics_enable default
		// to true) which VictoriaMetrics can scrape directly.
		DefaultValues: `basic:
  image_registry: docker.io
  controller_image_name: volcanosh/vc-controller-manager
  scheduler_image_name: volcanosh/vc-scheduler
  admission_image_name: volcanosh/vc-webhook-manager
  image_pull_policy: IfNotPresent
  image_tag_version: "v1.14.2"
custom:
  scheduler_replicas: 1
  controller_replicas: 1
  admission_replicas: 1
`,
		// kpilot-scheduling joins the kpilot-* namespace family so the
		// Workload page treats Volcano's pods as read-only — users can
		// browse them but can't accidentally `kubectl delete deployment`
		// the scheduler. Volcano's chart is fully namespace-portable
		// (every template references .Release.Namespace), so the choice
		// is ours; we don't need to use upstream's "volcano-system".
		DefaultReleaseNamespace: "kpilot-scheduling",
	},
	{
		Name:        "volcano-vgpu-device-plugin",
		DisplayName: "Volcano vGPU device-plugin",
		Description: "Registers physical NVIDIA GPUs as `volcano.sh/vgpu-*` resources via a HAMi-core fork; Volcano's deviceshare plugin slices them per the Pod's `vgpu-{number,memory,cores}` requests. Required for the /compute/:id/vgpu page to render anything — and for any pod that wants fractional GPU. Pairs with the Volcano plugin's deviceshare.VGPUEnable flag in scheduler config.",
		Category:    PluginCategoryScheduling,
		IsBuiltin:   true,
		// Same scheduling category, just after Volcano itself.
		SortOrder: 20,
		// Local chart — sources committed under pkg/server/plugins/
		// charts/volcano-vgpu/, packaged at boot. ChartBlobID is set
		// dynamically in SeedBuiltinPlugins below.
		ChartType:      ChartTypeLocal,
		ChartName:      "volcano-vgpu-device-plugin",
		DefaultVersion: "0.1.0",
		// Empty default values — chart's values.yaml carries the
		// real defaults. Users override per-cluster via the Enable
		// drawer when they need a different image tag or
		// deviceSplitCount.
		DefaultValues: "",
		// Match the Volcano plugin's release namespace so the
		// scheduler and the device-plugin share the same place. The
		// device-plugin is namespace-portable (RBAC is ClusterRole
		// scoped, hostPath mounts don't care).
		DefaultReleaseNamespace: "kpilot-scheduling",
	},
}

// SeedBuiltinPlugins upserts the builtin entries on startup. Built-ins are
// keyed by `name` (DNS-compatible, also doubles as the CRD metadata.name);
// existing rows are updated to match the latest hard-coded definition so
// fixes ship with the next deploy.
//
// Local-chart builtins (ChartType=Local) need their .tgz packaged + blob
// row upserted BEFORE the Plugin row is written, because the Plugin row
// references the blob via ChartBlobID. seedLocalChartBlobs handles that
// in one pass.
func SeedBuiltinPlugins(db *gorm.DB) error {
	// Patch up ChartBlobID on local-chart builtins. The blob ID isn't
	// known until we've packaged + upserted the .tgz, so we can't put
	// it in the static `builtinPlugins` slice — do it here, before
	// the upsert loop, by mutating the slice in place.
	if err := seedLocalChartBlobs(); err != nil {
		return err
	}
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
				"chart_blob_id":             want.ChartBlobID,
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

// seedLocalChartBlobs packages every local-chart builtin and writes
// the resulting .tgz to the PluginBlob table. The blob ID is then
// patched onto the matching entry in `builtinPlugins` so the upsert
// loop above writes a row that references the blob.
//
// New local-chart builtins: add another case below + commit the
// chart sources under pkg/server/plugins/charts/<name>/. The blob
// upsert is sha256-deduped, so re-packaging the same source produces
// the same DB row.
func seedLocalChartBlobs() error {
	vgpu, err := plugins.PackageVolcanoVGPU()
	if err != nil {
		return fmt.Errorf("package volcano-vgpu chart: %w", err)
	}
	blob := PluginBlob{
		Filename:  vgpu.Filename,
		Content:   vgpu.Bytes,
		SizeBytes: int64(len(vgpu.Bytes)),
		SHA256:    vgpu.SHA256,
	}
	if err := UpsertPluginBlob(&blob); err != nil {
		return fmt.Errorf("upsert volcano-vgpu blob: %w", err)
	}
	for i := range builtinPlugins {
		if builtinPlugins[i].Name == "volcano-vgpu-device-plugin" {
			id := blob.ID
			builtinPlugins[i].ChartBlobID = &id
			// Pin DefaultVersion to whatever the chart actually
			// shipped — the chart's version field is the source of
			// truth, so mismatches between Chart.yaml and the seed
			// data can't bite us.
			builtinPlugins[i].DefaultVersion = vgpu.Version
		}
	}
	return nil
}
