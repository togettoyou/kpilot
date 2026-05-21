export default [
  {
    path: '/user',
    layout: false,
    routes: [
      {
        path: '/user/login',
        name: 'login',
        component: './user/login',
      },
      {
        path: '/user',
        redirect: '/user/login',
      },
    ],
  },
  // ─── 集群管理 — pure K8s primitives platform ──────────────────────────
  {
    path: '/clusters',
    name: 'clusters',
    icon: 'cluster',
    routes: [
      {
        path: '/clusters',
        component: './Clusters/index',
      },
      {
        path: '/clusters/:id',
        redirect: '/clusters/:id/nodes',
      },
      {
        path: '/clusters/:id/nodes',
        component: './ClusterDetail/Nodes/index',
      },
      {
        path: '/clusters/:id/workloads',
        redirect: '/clusters/:id/workloads/deployments',
      },
      {
        path: '/clusters/:id/workloads/:type',
        component: './ClusterDetail/Workloads/index',
      },
      {
        path: '/clusters/:id/plugins',
        component: './ClusterDetail/Plugins/index',
      },
      {
        path: '/clusters/:id/monitoring',
        component: './ClusterDetail/Monitoring/index',
      },
      {
        path: '/clusters/:id/logging',
        component: './ClusterDetail/Logging/index',
      },
      {
        // Grafana home — escape hatch into the bundled Grafana when
        // the user wants ad-hoc PromQL / LogsQL exploration or
        // custom dashboards. The Monitoring and Logging pages above
        // already draw their own panels; this is the "anything else"
        // entry point. Requires the grafana plugin to be enabled.
        path: '/clusters/:id/grafana',
        component: './ClusterDetail/Grafana/index',
      },
    ],
  },
  // ─── 算力调度 — Volcano-centric batch scheduling platform ─────────────
  {
    path: '/compute',
    name: 'compute',
    icon: 'thunderbolt',
    routes: [
      {
        path: '/compute',
        component: './Compute/index',
      },
      {
        // Land on the dashboard so users see cluster-wide
        // Volcano health first. /scheduler is one click away in
        // the sider for config-only tasks.
        path: '/compute/:id',
        redirect: '/compute/:id/overview',
      },
      {
        // /overview now points at the Volcano dashboard: charts +
        // KPIs aggregated from Queue / Job / CronJob / PodGroup /
        // HyperNode in a single fetch. Same URL the pre-Volcano
        // GPU dashboard lived at, so existing bookmarks just land
        // on the new (and more relevant) Volcano overview.
        path: '/compute/:id/overview',
        component: './Compute/Volcano/Overview',
      },
      // Volcano CR browsers — thin wrappers around the workload
      // page's CR-instances component (WorkloadsContent), preset
      // with the correct GVK so the user lands on a Volcano resource
      // straight from the algorithm sider instead of going through
      // /workloads/customresourcedefinitions.
      {
        path: '/compute/:id/queues',
        component: './Compute/Volcano/Queues',
      },
      {
        path: '/compute/:id/jobs',
        component: './Compute/Volcano/Jobs',
      },
      {
        path: '/compute/:id/cronjobs',
        component: './Compute/Volcano/CronJobs',
      },
      {
        path: '/compute/:id/podgroups',
        component: './Compute/Volcano/PodGroups',
      },
      {
        path: '/compute/:id/hypernodes',
        component: './Compute/Volcano/HyperNodes',
      },
      {
        path: '/compute/:id/jobflows',
        component: './Compute/Volcano/JobFlows',
      },
      {
        path: '/compute/:id/jobtemplates',
        component: './Compute/Volcano/JobTemplates',
      },
      {
        path: '/compute/:id/numatopologies',
        component: './Compute/Volcano/NumaTopologies',
      },
      {
        path: '/compute/:id/nodeshards',
        component: './Compute/Volcano/NodeShards',
      },
      {
        path: '/compute/:id/colocationconfigurations',
        component: './Compute/Volcano/ColocationConfigurations',
      },
      {
        // Cluster-wide vGPU snapshot — Volcano vGPU device-plugin
        // installs the node-register annotations the page reads. Page
        // shows "not installed" empty state when no nodes registered.
        path: '/compute/:id/vgpu',
        component: './Compute/Volcano/VGPU',
      },
      {
        // Physical GPU monitoring: embeds the bundled NVIDIA DCGM
        // Exporter Grafana dashboard. Requires grafana + victoria-
        // metrics for the visualization stack and dcgm-exporter for the
        // raw counters. Sister to /vgpu — that page shows slice
        // allocation, this page shows hardware-level health.
        path: '/compute/:id/gpu-monitoring',
        component: './Compute/Volcano/GPUMonitoring',
      },
      {
        // Per-queue resource quota deep-dive: capability / guarantee /
        // allocated / deserved across every resource a queue declares,
        // with hierarchical subqueue cards. Sister to Overview — that
        // page rolls everything up to cluster totals; this one drills
        // into a single queue at a time. No new endpoint; the existing
        // /volcano/queues list-full already returns spec.{capability,
        // guarantee, deserved} + status.allocated after the P14a queueRow
        // extension.
        path: '/compute/:id/queue-quota',
        component: './Compute/Volcano/QueueQuota',
      },
      {
        // Device health aggregator — DCGM XID / ECC / temp / FB-near-
        // full alerts rolled into one severity-sorted list. Server-side
        // PromQL against VictoriaMetrics; requires victoria-metrics +
        // dcgm-exporter installed.
        path: '/compute/:id/device-health',
        component: './Compute/Volcano/DeviceHealth',
      },
      {
        // GPU-Hour usage report — integrates DCGM_FI_DEV_GPU_UTIL/100
        // over a user-selected window (1h/24h/7d/30d). v1 groups by
        // (hostname, gpu, uuid) only — queue / namespace breakdown
        // requires Volcano allocation snapshots persisted server-side,
        // out of scope for P14c v1.
        path: '/compute/:id/gpu-hour',
        component: './Compute/Volcano/GPUHour',
      },
      {
        // Read-only view of volcano-scheduler-configmap → the
        // currently configured actions + plugin tiers. Editing
        // happens through the volcano plugin's helm values, not
        // here, so we don't need a workload-style PUT path.
        path: '/compute/:id/scheduler',
        component: './Compute/Volcano/Scheduler',
      },
    ],
  },
  // ─── 模型服务 — global model serving platform ─────────────────────────
  // Global (not per-cluster). Three peer pages under one platform menu,
  // sibling pattern to /clusters and /compute but with a static sub-menu
  // (no per-X context to inject dynamically):
  //   - /models/catalog     模型仓库   (the registry of model presets)
  //   - /models/deployments 部署实例   (cross-model + cross-cluster survey)
  //   - /models/chat        Chat 调试  (full-page playground)
  //
  // Pages live under pages/ModelHub/, pages/ModelDeployments/,
  // pages/ModelChat/ — never under pages/Models/, because Umi's
  // plugin-model auto-scans pages/**/models/** as state-hook files
  // and the case-insensitive macOS FS collision breaks the build.
  {
    path: '/models',
    name: 'models',
    icon: 'bulb',
    routes: [
      {
        path: '/models',
        redirect: '/models/catalog',
      },
      {
        path: '/models/catalog',
        name: 'catalog',
        icon: 'database',
        component: './ModelHub/index',
      },
      {
        // Icon must be camelCase ("deploymentUnit") not kebab
        // ("deployment-unit") — umi's runtime `formatIcon` has a
        // broken regex (`/-(w)/g` instead of `/-(\w)/g`) so kebab
        // names with hyphens never get converted to PascalCase
        // and the icon silently disappears from the sider.
        path: '/models/deployments',
        name: 'deployments',
        icon: 'deploymentUnit',
        component: './ModelDeployments/index',
      },
      {
        path: '/models/chat',
        name: 'chat',
        icon: 'message',
        component: './ModelChat/index',
      },
      {
        // P16-D — operator CRUD for Bearer-token API keys that
        // gate /api/v1/clusters/:id/proxy/inference/... external
        // calls. JWT cookie-protected like the rest of /models/*.
        path: '/models/api-keys',
        name: 'apiKeys',
        icon: 'key',
        component: './APIKeys/index',
      },
    ],
  },
  // ─── 插件管理 — global Helm chart registry ────────────────────────────
  {
    path: '/plugins',
    name: 'plugins',
    icon: 'appstore',
    component: './Plugins/index',
  },
  {
    path: '/',
    redirect: '/clusters',
  },
  {
    component: './exception/404',
    path: '/*',
  },
];
