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
        path: '/clusters/:id/monitoring',
        component: './ClusterDetail/Monitoring/index',
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
