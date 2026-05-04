import { request } from '@umijs/max';

export type WorkloadResourceType =
  | 'deployments' | 'statefulsets' | 'daemonsets' | 'pods'
  | 'services' | 'ingresses'
  | 'gatewayclasses' | 'gateways' | 'httproutes' | 'grpcroutes'
  | 'configmaps' | 'secrets'
  | 'persistentvolumeclaims' | 'persistentvolumes';

export interface WorkloadItem {
  name: string;
  namespace: string;
  [key: string]: any;
}

// Returns raw K8s list JSON — caller must parse items.
// Pass limit > 0 and continueToken for server-side pagination.
export function listWorkloads(
  clusterId: string,
  type: WorkloadResourceType,
  namespace = '',
  limit = 0,
  continueToken = '',
) {
  const params: Record<string, string | number> = {};
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
  type: WorkloadResourceType,
  name: string,
  namespace = '',
) {
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'GET',
    params: namespace ? { namespace } : {},
  });
}

export function applyWorkload(
  clusterId: string,
  type: WorkloadResourceType,
  name: string,
  namespace: string,
  body: object,
) {
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'PUT',
    params: namespace ? { namespace } : {},
    data: body,
  });
}

export function deleteWorkload(
  clusterId: string,
  type: WorkloadResourceType,
  name: string,
  namespace: string,
) {
  return request(`/api/v1/clusters/${clusterId}/workloads/${type}/${name}`, {
    method: 'DELETE',
    params: namespace ? { namespace } : {},
  });
}

// Returns plain text — the same output as `kubectl describe`.
export function describeWorkload(
  clusterId: string,
  type: WorkloadResourceType,
  name: string,
  namespace = '',
) {
  return request<string>(
    `/api/v1/clusters/${clusterId}/workloads/${type}/${name}/describe`,
    {
      method: 'GET',
      params: namespace ? { namespace } : {},
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
