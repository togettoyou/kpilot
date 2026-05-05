export default {
  'menu.login': 'Login',
  'menu.clusters': 'Clusters',
  'menu.plugins': 'Plugin Management',

  // Cluster detail (dynamically injected when a cluster is selected).
  // Locale keys are auto-derived as `menu.clusters.{name}` (parent prefix +
  // item name), so these MUST stay aligned with names in buildClusterSubMenu.
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
  'menu.clusters.plugins': 'Plugins',
  // AI Compute group: GPU + Model serving. Parent is a virtual menu
  // node (no route); children own the actual pages.
  'menu.clusters.compute': 'AI Compute',
  'menu.clusters.compute.gpu': 'GPU',
  'menu.clusters.compute.models': 'Models',
  'menu.clusters.monitoring': 'Monitoring',
  'menu.clusters.logging': 'Logging',
};
