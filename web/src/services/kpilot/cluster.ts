import { request } from '@umijs/max';

export type ClusterStatus = 'online' | 'offline';

export interface Cluster {
  id: string;
  name: string;
  status: ClusterStatus;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface CreateClusterParams {
  name: string;
  description?: string;
}

export interface CreateClusterResult extends Cluster {
  token: string;
}

export function listClusters() {
  return request<Cluster[]>('/api/v1/clusters', { method: 'GET' });
}

export function createCluster(data: CreateClusterParams) {
  return request<CreateClusterResult>('/api/v1/clusters', {
    method: 'POST',
    data,
  });
}

export function deleteCluster(id: string) {
  return request(`/api/v1/clusters/${id}`, { method: 'DELETE' });
}
