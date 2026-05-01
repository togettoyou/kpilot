import { request } from '@umijs/max';

export type WorkloadResourceType =
  | 'deployments' | 'statefulsets' | 'daemonsets' | 'pods'
  | 'services' | 'ingresses' | 'configmaps' | 'secrets';

export interface WorkloadItem {
  name: string;
  namespace: string;
  age: string;
  [key: string]: any;
}

// Returns raw K8s list JSON — caller must parse items.
export function listWorkloads(clusterId: string, type: WorkloadResourceType, namespace = '') {
  return request<any>(`/api/v1/clusters/${clusterId}/workloads/${type}`, {
    method: 'GET',
    params: namespace ? { namespace } : {},
  });
}

export function getWorkload(
  clusterId: string,
  type: WorkloadResourceType,
  name: string,
  namespace: string,
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
