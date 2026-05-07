export default {
  'menu.login': 'Login',

  // Top-level platforms (4 modules).
  'menu.clusters': 'Clusters',
  'menu.compute': 'Compute',
  'menu.models': 'Models',
  'menu.plugins': 'Plugins',

  // Cluster detail sider — injected when a cluster is selected under
  // /clusters/:id/*. Locale keys auto-derive as menu.clusters.{name}.
  'menu.clusters.nodes': 'Nodes',
  'menu.clusters.workloads': 'Workloads',
  'menu.clusters.workloads.deployments': 'Deployments',
  'menu.clusters.workloads.statefulsets': 'StatefulSets',
  'menu.clusters.workloads.daemonsets': 'DaemonSets',
  'menu.clusters.workloads.pods': 'Pods',
  'menu.clusters.workloads.jobs': 'Jobs',
  'menu.clusters.workloads.cronjobs': 'CronJobs',
  'menu.clusters.workloads.hpa': 'HPA',
  'menu.clusters.network': 'Network',
  'menu.clusters.network.services': 'Services',
  'menu.clusters.network.ingresses': 'Ingresses',
  'menu.clusters.network.gatewayclasses': 'GatewayClasses',
  'menu.clusters.network.gateways': 'Gateways',
  'menu.clusters.network.httproutes': 'HTTPRoutes',
  'menu.clusters.network.grpcroutes': 'GRPCRoutes',
  'menu.clusters.storage': 'Storage',
  'menu.clusters.storage.pvc': 'PVC',
  'menu.clusters.storage.pv': 'PV',
  'menu.clusters.storage.sc': 'StorageClass',
  'menu.clusters.config': 'Configuration',
  'menu.clusters.config.configmaps': 'ConfigMaps',
  'menu.clusters.config.secrets': 'Secrets',
  'menu.clusters.extensions': 'Extensions',
  'menu.clusters.extensions.crds': 'CRD',
  // Hidden child route — used by breadcrumbs / page titles on the CR
  // instances browser even though it's hideInMenu: true.
  'menu.clusters.extensions.crds.crInstances': 'CR Instances',
  // DRA (Dynamic Resource Allocation) — accelerator / device scheduling.
  // Nested under Extensions since DRA, like CRD, is an extension mechanism.
  'menu.clusters.extensions.dra': 'DRA',
  'menu.clusters.extensions.dra.resourceclaims': 'ResourceClaims',
  'menu.clusters.extensions.dra.resourceclaimtemplates': 'ClaimTemplates',
  'menu.clusters.extensions.dra.deviceclasses': 'DeviceClasses',
  'menu.clusters.extensions.dra.resourceslices': 'ResourceSlices',
  'menu.clusters.plugins': 'Plugins',
  'menu.clusters.monitoring': 'Monitoring',
  'menu.clusters.logging': 'Logging',

  // Compute platform sider — injected when a cluster is selected under
  // /compute/:id/*.
  'menu.compute.overview': 'Resource Overview',
};
