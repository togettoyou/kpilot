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

export function listNamespaces(clusterId: string) {
  return request<string[]>(`/api/v1/clusters/${clusterId}/namespaces`, {
    method: 'GET',
  });
}
