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
        // Read-only view of volcano-scheduler-configmap → the
        // currently configured actions + plugin tiers. Editing
        // happens through the volcano plugin's helm values, not
        // here, so we don't need a workload-style PUT path.
        path: '/compute/:id/scheduler',
        component: './Compute/Volcano/Scheduler',
      },
    ],
  },
  // ─── 模型管理 — global model serving platform ─────────────────────────
  // Global (not per-cluster) — registry is fleet-wide; deployment will
  // pick a target cluster as a step inside the workflow rather than at
  // the top of the URL.
  //
  // Component lives at pages/ModelHub/ rather than pages/Models/ —
  // Umi's plugin-model auto-scans pages/**/models/** as state-hook
  // files, and on case-insensitive macOS filesystems "Models" matches
  // that glob and breaks the build (CaseSensitivePathsPlugin fires).
  {
    path: '/models',
    name: 'models',
    icon: 'bulb',
    component: './ModelHub/index',
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
