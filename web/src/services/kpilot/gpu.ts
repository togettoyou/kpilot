import { request } from '@umijs/max';

// GPUDevice mirrors one entry of HAMI's hami.io/node-nvidia-register
// annotation. Empty when the node has GPUs (extended resources reported)
// but HAMI isn't installed.
export interface GPUDevice {
  id: string;
  count: number;
  devmem: number;
  devcore: number;
  type: string;
  numa: number;
  health: boolean;
}

// GPUPodOnCard is one pod's allocation on a single physical GPU. mem is
// MB, cores is percent — these come from the scheduler's actual decision
// (hami.io/vgpu-devices-allocated annotation), not from user requests.
export interface GPUPodOnCard {
  namespace: string;
  name: string;
  mem: number;
  cores: number;
}

// GPUCardSummary is the per-physical-card breakdown. Only present when
// HAMI is providing per-card visibility; standard NVIDIA-device-plugin
// installs leave this empty and the UI falls back to GPUPodSummary.
export interface GPUCardSummary {
  uuid: string;
  type: string;
  health: boolean;
  numa: number;
  slots: number;     // total vGPU slot capacity
  devmem: number;    // total physical memory MB
  devcore: number;   // total compute %
  usedSlots: number; // taken slots
  usedMem: number;   // sum of mem allocated to pods
  usedCores: number; // sum of cores allocated to pods
  pods: GPUPodOnCard[] | null;
}

// GPUPodSummary is the per-pod node-level entry. Phase from pod.Status.Phase;
// Requests is keyed by the K8s extended-resource name. Always populated
// for any pod requesting nvidia.com/* — fallback view when HAMI's per-card
// allocation annotation isn't present.
export interface GPUPodSummary {
  namespace: string;
  name: string;
  phase: string;
  requests: Record<string, number>;
}

// GPUNodeSummary is the per-node payload. Cards (from HAMI) is the
// preferred view; Pods is the fallback for non-HAMI clusters or pods
// without the allocation annotation.
export interface GPUNodeSummary {
  name: string;
  status: string;
  devices: GPUDevice[] | null;
  capacity: Record<string, number> | null;
  allocatable: Record<string, number> | null;
  used: Record<string, number>;
  cards: GPUCardSummary[] | null;
  pods: GPUPodSummary[] | null;
}

export function getClusterGPU(clusterId: string) {
  return request<GPUNodeSummary[]>(`/api/v1/clusters/${clusterId}/gpu`, {
    method: 'GET',
  });
}
