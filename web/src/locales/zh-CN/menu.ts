export default {
  'menu.login': '登录',

  // Top-level platforms (4 modules).
  'menu.clusters': '集群管理',
  'menu.compute': '算力管理',
  'menu.models': '模型管理',
  'menu.plugins': '插件管理',

  // Cluster detail sider — injected when a cluster is selected under
  // /clusters/:id/*. Locale keys auto-derive as menu.clusters.{name}.
  'menu.clusters.nodes': '节点概览',
  'menu.clusters.workloads': '工作负载',
  'menu.clusters.workloads.deployments': 'Deployments',
  'menu.clusters.workloads.statefulsets': 'StatefulSets',
  'menu.clusters.workloads.daemonsets': 'DaemonSets',
  'menu.clusters.workloads.replicasets': 'ReplicaSets',
  'menu.clusters.workloads.pods': 'Pods',
  'menu.clusters.workloads.jobs': 'Jobs',
  'menu.clusters.workloads.cronjobs': 'CronJobs',
  'menu.clusters.workloads.hpa': 'HPA',
  'menu.clusters.network': '网络',
  'menu.clusters.network.services': 'Services',
  'menu.clusters.network.endpointslices': 'EndpointSlices',
  'menu.clusters.network.ingresses': 'Ingresses',
  'menu.clusters.network.networkpolicies': 'NetworkPolicies',
  'menu.clusters.network.gatewayclasses': 'GatewayClasses',
  'menu.clusters.network.gateways': 'Gateways',
  'menu.clusters.network.httproutes': 'HTTPRoutes',
  'menu.clusters.network.grpcroutes': 'GRPCRoutes',
  'menu.clusters.storage': '存储',
  'menu.clusters.storage.pvc': 'PVC',
  'menu.clusters.storage.pv': 'PV',
  'menu.clusters.storage.sc': 'StorageClass',
  'menu.clusters.config': '配置',
  'menu.clusters.config.configmaps': 'ConfigMaps',
  'menu.clusters.config.secrets': 'Secrets',
  'menu.clusters.security': '安全',
  'menu.clusters.security.serviceaccounts': 'ServiceAccounts',
  'menu.clusters.security.roles': 'Roles',
  'menu.clusters.security.rolebindings': 'RoleBindings',
  'menu.clusters.security.clusterroles': 'ClusterRoles',
  'menu.clusters.security.clusterrolebindings': 'ClusterRoleBindings',
  'menu.clusters.policy': '策略',
  'menu.clusters.policy.resourcequotas': 'ResourceQuotas',
  'menu.clusters.policy.limitranges': 'LimitRanges',
  'menu.clusters.policy.poddisruptionbudgets': 'PDBs',
  'menu.clusters.policy.priorityclasses': 'PriorityClasses',
  'menu.clusters.policy.runtimeclasses': 'RuntimeClasses',
  'menu.clusters.extensions': '扩展',
  'menu.clusters.extensions.crds': 'CRD',
  // Hidden child route — used by breadcrumbs / page titles on the CR
  // instances browser even though it's hideInMenu: true.
  'menu.clusters.extensions.crds.crInstances': 'CR 实例',
  // DRA (Dynamic Resource Allocation) — accelerator / device scheduling.
  // Nested under 扩展 since DRA, like CRD, is an extension mechanism.
  'menu.clusters.extensions.dra': 'DRA',
  'menu.clusters.extensions.dra.resourceclaims': 'ResourceClaims',
  'menu.clusters.extensions.dra.resourceclaimtemplates': 'ClaimTemplates',
  'menu.clusters.extensions.dra.deviceclasses': 'DeviceClasses',
  'menu.clusters.extensions.dra.resourceslices': 'ResourceSlices',
  // Admission webhook + policy configurations — extends the K8s API.
  // Sub-items keep proper-noun English names (no Chinese) — these
  // are K8s API kinds and operators / docs always refer to them by
  // the original spelling.
  'menu.clusters.extensions.admission': 'Admission',
  'menu.clusters.extensions.admission.validatingwebhooks': 'ValidatingWebhook',
  'menu.clusters.extensions.admission.mutatingwebhooks': 'MutatingWebhook',
  // "Admission" parent already supplies the context, so leaves drop
  // the redundant "Admission" word to fit the 220px sider at level
  // 3 indent. Full Kind names show in the page header inside.
  'menu.clusters.extensions.admission.validatingadmissionpolicies':
    'ValidatingPolicy',
  'menu.clusters.extensions.admission.mutatingadmissionpolicies':
    'MutatingPolicy',
  'menu.clusters.plugins': '插件',
  'menu.clusters.monitoring': '监控',
  'menu.clusters.logging': '日志',

  // Compute platform sider — injected when a cluster is selected under
  // /compute/:id/*. P5b will add GPU monitoring as a sibling.
  'menu.compute.overview': '资源概览',
};
