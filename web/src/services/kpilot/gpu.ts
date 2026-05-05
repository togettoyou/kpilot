import { request } from '@umijs/max';

// GPUDevice mirrors one entry of HAMI's hami.io/node-nvidia-register
// annotation. Empty when the node has GPUs (extended resources reported)
// but HAMI isn't installed or running an older schema.
export interface GPUDevice {
  id: string;
  count: number;
  devmem: number;
  devcore: number;
  type: string;
  numa: number;
  health: boolean;
}

// GPUPodSummary is one Pod that requested a GPU resource on a GPU node.
// Phase comes from pod.Status.Phase; Requests is keyed by the K8s
// extended-resource name (e.g. "nvidia.com/gpu", "nvidia.com/gpumem").
export interface GPUPodSummary {
  namespace: string;
  name: string;
  phase: string;
  requests: Record<string, number>;
}

// GPUNodeSummary is the per-node payload. Capacity / Allocatable / Used
// values are integers; the exact meaning depends on the resource name
// (slot count for nvidia.com/gpu, MB for nvidia.com/gpumem, percent for
// nvidia.com/gpucores).
export interface GPUNodeSummary {
  name: string;
  status: string;
  devices: GPUDevice[] | null;
  capacity: Record<string, number> | null;
  allocatable: Record<string, number> | null;
  used: Record<string, number>;
  pods: GPUPodSummary[] | null;
}

export function getClusterGPU(clusterId: string) {
  return request<GPUNodeSummary[]>(`/api/v1/clusters/${clusterId}/gpu`, {
    method: 'GET',
  });
}
