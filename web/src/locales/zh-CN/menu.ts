export default {
  'menu.login': '登录',
  'menu.clusters': '集群管理',
  'menu.plugins': '插件管理',

  // Cluster detail (dynamically injected when a cluster is selected).
  // Locale keys are auto-derived as `menu.clusters.{name}` (parent prefix +
  // item name), so these MUST stay aligned with names in buildClusterSubMenu.
  'menu.clusters.nodes': '节点概览',
  'menu.clusters.workloads': '工作负载',
  'menu.clusters.workloads.deployments': 'Deployments',
  'menu.clusters.workloads.statefulsets': 'StatefulSets',
  'menu.clusters.workloads.daemonsets': 'DaemonSets',
  'menu.clusters.workloads.pods': 'Pods',
  'menu.clusters.network': '网络',
  'menu.clusters.network.services': 'Services',
  'menu.clusters.network.ingresses': 'Ingresses',
  'menu.clusters.storage': '存储',
  'menu.clusters.storage.pvc': 'PVC',
  'menu.clusters.storage.pv': 'PV',
  'menu.clusters.config': '配置',
  'menu.clusters.config.configmaps': 'ConfigMaps',
  'menu.clusters.config.secrets': 'Secrets',
  'menu.clusters.plugins': '插件',
  'menu.clusters.gpu': 'GPU',
  'menu.clusters.models': '模型',
  'menu.clusters.monitoring': '监控',
  'menu.clusters.logging': '日志',
};
