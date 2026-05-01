import { request } from '@umijs/max';

export type WorkloadResourceType =
  | 'deployments' | 'statefulsets' | 'daemonsets' | 'pods'
  | 'services' | 'ingresses' | 'configmaps' | 'secrets'
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

export function listNamespaces(clusterId: string) {
  return request<string[]>(`/api/v1/clusters/${clusterId}/namespaces`, {
    method: 'GET',
  });
}
