import { request } from '@umijs/max';

// vgpu.ts — typed mirror of pkg/common/vgpu.Snapshot. Hand-mirrored
// because Go → TS code-gen pipeline isn't wired up; the server-side
// JSON tags are the source of truth — keep these in sync if the Go
// shape evolves.

export interface VGPUPodUsage {
  namespace: string;
  name: string;
  usedMemory: number;
  usedCores: number;
}

export interface VGPUCard {
  index: number;
  uuid: string;
  type: string;
  number: number;
  memory: number;
  health: boolean;
  sharingMode: string;
  usedMemory: number;
  usedCores: number;
  usedNumber: number;
  pods?: VGPUPodUsage[];
}

export interface VGPUNode {
  name: string;
  healthy: boolean;
  cards: VGPUCard[];
  totalMemory: number;
  usedMemory: number;
  totalNumber: number;
  usedNumber: number;
}

export interface VGPUSnapshot {
  nodes: VGPUNode[];
  totalCards: number;
  totalMemory: number;
  usedMemory: number;
  totalSlots: number;
  usedSlots: number;
}

export function getVGPUSnapshot(clusterId: string) {
  return request<VGPUSnapshot>(`/api/v1/clusters/${clusterId}/vgpu`, {
    method: 'GET',
  });
}
