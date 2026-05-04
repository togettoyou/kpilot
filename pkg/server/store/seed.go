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
grafana.ini:
  security:
    allow_embedding: true
  server:
    serve_from_sub_path: true
    root_url: "/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/"
  users:
    auto_assign_org_role: Admin
    # Default to light theme so the embedded iframe matches KPilot's
    # default chrome on first paint. Users who prefer dark can flip it
    # in Grafana's profile preferences — this only sets the default for
    # newly auto-created accounts.
    default_theme: light
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
