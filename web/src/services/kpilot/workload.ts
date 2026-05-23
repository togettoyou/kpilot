import { request } from '@umijs/max';

export type WorkloadResourceType =
  | 'deployments' | 'statefulsets' | 'daemonsets' | 'replicasets' | 'pods'
  | 'jobs' | 'cronjobs' | 'horizontalpodautoscalers'
  | 'services' | 'endpointslices' | 'ingresses' | 'networkpolicies'
  | 'gatewayclasses' | 'gateways' | 'httproutes' | 'grpcroutes'
  | 'configmaps' | 'secrets'
  | 'persistentvolumeclaims' | 'persistentvolumes' | 'storageclasses'
  | 'serviceaccounts' | 'roles' | 'rolebindings' | 'clusterroles' | 'clusterrolebindings'
  | 'resourcequotas' | 'limitranges' | 'poddisruptionbudgets'
  | 'priorityclasses' | 'runtimeclasses'
  | 'validatingwebhookconfigurations' | 'mutatingwebhookconfigurations'
  | 'validatingadmissionpolicies' | 'mutatingadmissionpolicies'
  | 'resourceclaims' | 'resourceclaimtemplates' | 'deviceclasses' | 'resourceslices'
  | 'customresourcedefinitions'
  // `nodes` is accessed by the dedicated /clusters/:id/nodes page,
  // not the Workloads index page (Workloads VALID_TYPES set doesn't
  // include it, so /workloads/nodes URL still redirects). Listed here
  // so DescribeDrawer / describeWorkload can be reused for Node
  // describe text without a parallel service.
  | 'nodes';

// Cluster-scoped workload kinds — no metadata.namespace, so the global
// namespace picker hides itself and the table omits the namespace column
// when one of these is selected. Shared between NamespacePicker (top bar)
// and the Workloads page; keep these two consumers in lockstep.
export const CLUSTER_SCOPED_TYPES = new Set<WorkloadResourceType>([
  'persistentvolumes',
  'storageclasses',
  'gatewayclasses',
  'deviceclasses',
  'resourceslices',
  'customresourcedefinitions',
  'clusterroles',
  'clusterrolebindings',
  'priorityclasses',
  'runtimeclasses',
  'validatingwebhookconfigurations',
  'mutatingwebhookconfigurations',
  'validatingadmissionpolicies',
  'mutatingadmissionpolicies',
  'nodes',
]);

export interface WorkloadItem {
  name: string;
  namespace: string;
  [key: string]: any;
}

// CRRef identifies an arbitrary CRD-defined kind for the CR-instances
// viewer. When passed to a workload service function alongside
// type='_cr', the GVK lands in URL query params (group/version/kind)
// and the server's resolveGVK helper picks them up. group is optional
// — empty string is valid for core/v1, though no current CRD lives
// there. scope drives namespace-picker visibility client-side; the
// server resolves resource scope independently via RESTMapper.
export interface CRRef {
  group: string;
  version: string;
  kind: string;
  scope: 'Namespaced' | 'Cluster';
}

// gvkParams returns the query params that pin a CR-viewer request to a
// specific GVK. Returns {} for built-in workload types so the existing
// URL pattern stays unchanged.
function gvkParams(
  type: WorkloadResourceType | '_cr',
  cr?: CRRef,
): Record<string, string> {
  if (type !== '_cr' || !cr) return {};
  return { group: cr.group, version: cr.version, kind: cr.kind };
}

// Returns raw K8s list JSON — caller must parse items.
// Pass limit > 0 and continueToken for server-side pagination.
export function listWorkloads(
  clusterId: string,
  type: WorkloadResourceType | '_cr',
  namespace = '',
  limit = 0,
  continueToken = '',
  cr?: CRRef,
) {
  const params: Record<string, string | number> = { ...gvkParams(type, cr) };
  if (namespace) params.namespace = namespace;
  if (limit > 0) params.limit = limit;
  if (continueToken) params.continue = continueToken;
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}`, {
    method: 'GET',
    params,
  });
}

export function getWorkload(
  clusterId: string,
  type: WorkloadResourceType | '_cr',
  name: string,
  namespace = '',
  cr?: CRRef,
) {
  const params: Record<string, string> = { ...gvkParams(type, cr) };
  if (namespace) params.namespace = namespace;
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'GET',
    params,
  });
}

export function applyWorkload(
  clusterId: string,
  type: WorkloadResourceType | '_cr',
  name: string,
  namespace: string,
  body: object,
  cr?: CRRef,
) {
  const params: Record<string, string> = { ...gvkParams(type, cr) };
  if (namespace) params.namespace = namespace;
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'PUT',
    params,
    data: body,
  });
}

export function deleteWorkload(
  clusterId: string,
  type: WorkloadResourceType | '_cr',
  name: string,
  namespace: string,
  cr?: CRRef,
) {
  const params: Record<string, string> = { ...gvkParams(type, cr) };
  if (namespace) params.namespace = namespace;
  return request(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'DELETE',
    params,
  });
}

// Returns plain text — the same output as `kubectl describe`.
export function describeWorkload(
  clusterId: string,
  type: WorkloadResourceType | '_cr',
  name: string,
  namespace = '',
  cr?: CRRef,
) {
  const params: Record<string, string> = { ...gvkParams(type, cr) };
  if (namespace) params.namespace = namespace;
  return request<string>(
    `/api/v1/clusters/${clusterId}/workloads/${type}/${name}/describe`,
    {
      method: 'GET',
      params,
      responseType: 'text',
    },
  );
}

export function listNamespaces(clusterId: string) {
  return request<string[]>(`/api/v1/clusters/${clusterId}/namespaces`, {
    method: 'GET',
  });
}

export interface ApplyYamlResult {
  index: number;
  kind?: string;
  namespace?: string;
  name?: string;
  success: boolean;
  error?: string;
}

// Generic apply: server parses YAML/JSON text (multi-doc `---` supported),
// extracts GVK + metadata for each manifest, and routes to the SSA path.
// Returns one result entry per document — the caller checks `success` per
// entry to surface partial failures.
export function applyYAML(clusterId: string, yamlText: string) {
  return request<{ results: ApplyYamlResult[] }>(
    `/api/v1/clusters/${clusterId}/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      data: yamlText,
    },
  );
}

// Mirror of applyYAML — deletes every resource described in the YAML
// stream by GVK + namespace + name. Doc body itself is discarded after
// parsing; only identity is needed. Same per-doc result shape so the
// drawer's success/failure rendering can be reused.
export function deleteYAML(clusterId: string, yamlText: string) {
  return request<{ results: ApplyYamlResult[] }>(
    `/api/v1/clusters/${clusterId}/delete-yaml`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      data: yamlText,
    },
  );
}

// ─── kubectl rollout / scale shortcuts ────────────────────────────
//
// All POST to /workloads/:type/:name/<verb>?namespace=<ns>. Server
// builds the patch body; client only carries `replicas` (scale) or
// `toRevision` (undo). Generic edit YAML / kubectl-apply still go
// through applyWorkload — these are convenience verbs only.

export function rolloutRestart(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
) {
  return request<void>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/restart`,
    { method: 'POST', params: { namespace } },
  );
}

export function rolloutPause(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
) {
  return request<void>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/pause`,
    { method: 'POST', params: { namespace } },
  );
}

export function rolloutResume(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
) {
  return request<void>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/resume`,
    { method: 'POST', params: { namespace } },
  );
}

export function scaleWorkload(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
  replicas: number,
) {
  return request<void>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/scale`,
    { method: 'POST', params: { namespace }, data: { replicas } },
  );
}

export interface RolloutHistoryEntry {
  revision: number;
  name: string;
  replicas: number;
  readyReplicas: number;
  image?: string;
  createdAt: string;
  changeCause?: string;
  podTemplateHash?: string;
  current: boolean;
}

export function getRolloutHistory(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
) {
  return request<{ revisions: RolloutHistoryEntry[] }>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/rollout/history`,
    { method: 'GET', params: { namespace } },
  );
}

export function rolloutUndo(
  clusterId: string,
  resourceType: WorkloadResourceType,
  name: string,
  namespace: string,
  toRevision?: number,
) {
  return request<{ rolledBackTo: number; noop: boolean }>(
    `/api/v1/clusters/${clusterId}/workloads/${resourceType}/${name}/rollout/undo`,
    {
      method: 'POST',
      params: { namespace },
      data: toRevision ? { toRevision } : {},
    },
  );
}

export interface DrainOptions {
  ignoreDaemonSets?: boolean;
  deleteEmptyDirData?: boolean;
  force?: boolean;
  gracePeriodSeconds?: number;
}

export interface DrainResult {
  total: number;
  evicted: number;
  skipped: number;
  failed: number;
  failures?: string[];
}

export function drainNode(
  clusterId: string,
  nodeName: string,
  opts: DrainOptions,
) {
  return request<DrainResult>(
    `/api/v1/clusters/${clusterId}/workloads/nodes/${nodeName}/drain`,
    { method: 'POST', data: opts },
  );
}
