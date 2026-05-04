import { request } from '@umijs/max';

export type WorkloadResourceType =
  | 'deployments' | 'statefulsets' | 'daemonsets' | 'pods'
  | 'jobs' | 'cronjobs' | 'horizontalpodautoscalers'
  | 'services' | 'ingresses'
  | 'gatewayclasses' | 'gateways' | 'httproutes' | 'grpcroutes'
  | 'configmaps' | 'secrets'
  | 'persistentvolumeclaims' | 'persistentvolumes' | 'storageclasses'
  | 'customresourcedefinitions';

// Cluster-scoped workload kinds — no metadata.namespace, so the global
// namespace picker hides itself and the table omits the namespace column
// when one of these is selected. Shared between NamespacePicker (top bar)
// and the Workloads page; keep these two consumers in lockstep.
export const CLUSTER_SCOPED_TYPES = new Set<WorkloadResourceType>([
  'persistentvolumes',
  'storageclasses',
  'gatewayclasses',
  'customresourcedefinitions',
]);

// CRD names matching this regex (everything ending in .kpilot.io) are
// protected from edit/delete via the workload UI — the server enforces
// the same rule and returns 403/CRD_PROTECTED, but doing the gate on
// the frontend too means hiding the destructive buttons instead of
// surfacing a "operation forbidden" toast.
export function isProtectedCRDName(name: string): boolean {
  return name.endsWith('.kpilot.io');
}

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
// there. plural is only used for the page title and not sent to the
// server.
export interface CRRef {
  group: string;
  version: string;
  kind: string;
  plural: string;
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
