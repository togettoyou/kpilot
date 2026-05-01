import { request } from '@umijs/max';

export interface NodeInfo {
  name: string;
  status: 'Ready' | 'NotReady' | 'Unknown';
  cpu_capacity: number;
  cpu_allocatable: number;
  memory_capacity: number;
  memory_allocatable: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export function listNodes(clusterId: string) {
  return request<NodeInfo[]>(`/api/v1/clusters/${clusterId}/nodes`, {
    method: 'GET',
  });
}
