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
      // Old compute / model URLs that used to live under /clusters/:id —
      // re-route to the new top-level platforms so deep links + bookmarks
      // keep working through the Phase 0 shuffle.
      {
        path: '/clusters/:id/gpu',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/compute',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/compute/overview',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/compute/nodes',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/compute/cards',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/compute/tasks',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/clusters/:id/models',
        redirect: '/models',
      },
      {
        path: '/clusters/:id/models/inference',
        redirect: '/models',
      },
    ],
  },
  // ─── 算力管理 — GPU-aware ops platform ────────────────────────────────
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
        path: '/compute/:id',
        redirect: '/compute/:id/overview',
      },
      {
        path: '/compute/:id/overview',
        component: './Compute/Overview/index',
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
