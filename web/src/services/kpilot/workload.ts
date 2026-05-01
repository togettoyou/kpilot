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

export function listWorkloads(clusterId: string, type: WorkloadResourceType) {
  return request<WorkloadItem[]>(`/api/v1/clusters/${clusterId}/workloads/${type}`, {
    method: 'GET',
  });
}
