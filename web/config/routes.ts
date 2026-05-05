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
        // Old single GPU page — keep the redirect for any deep links
        // that already exist (menu update is sufficient for new traffic).
        path: '/clusters/:id/gpu',
        redirect: '/clusters/:id/compute/overview',
      },
      {
        path: '/clusters/:id/compute',
        redirect: '/clusters/:id/compute/overview',
      },
      {
        path: '/clusters/:id/compute/overview',
        component: './ClusterDetail/Compute/Overview/index',
      },
      {
        path: '/clusters/:id/compute/nodes',
        component: './ClusterDetail/Compute/Nodes/index',
      },
      {
        path: '/clusters/:id/compute/cards',
        component: './ClusterDetail/Compute/Cards/index',
      },
      {
        path: '/clusters/:id/compute/tasks',
        component: './ClusterDetail/Compute/Tasks/index',
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
