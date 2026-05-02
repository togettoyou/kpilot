export default {
  'menu.login': 'Login',
  'menu.clusters': 'Clusters',
  'menu.plugins': 'Plugin Center',

  // Cluster detail (dynamically injected when a cluster is selected).
  // Locale keys are auto-derived as `menu.clusters.{name}` (parent prefix +
  // item name), so these MUST stay aligned with names in buildClusterSubMenu.
  'menu.clusters.nodes': 'Nodes',
  'menu.clusters.workloads': 'Workloads',
  'menu.clusters.workloads.deployments': 'Deployments',
  'menu.clusters.workloads.statefulsets': 'StatefulSets',
  'menu.clusters.workloads.daemonsets': 'DaemonSets',
  'menu.clusters.workloads.pods': 'Pods',
  'menu.clusters.network': 'Network',
  'menu.clusters.network.services': 'Services',
  'menu.clusters.network.ingresses': 'Ingresses',
  'menu.clusters.storage': 'Storage',
  'menu.clusters.storage.pvc': 'PersistentVolumeClaims',
  'menu.clusters.storage.pv': 'PersistentVolumes',
  'menu.clusters.config': 'Configuration',
  'menu.clusters.config.configmaps': 'ConfigMaps',
  'menu.clusters.config.secrets': 'Secrets',
  'menu.clusters.plugins': 'Plugins',
  'menu.clusters.gpu': 'GPU',
  'menu.clusters.models': 'Models',
  'menu.clusters.monitoring': 'Monitoring',
  'menu.clusters.logging': 'Logging',
};
