import { request } from '@umijs/max';

// Mirrors pkg/server/api/handler/gpu_hour.go::gpuHourResponse.

export type GPUHourRange = '1h' | '24h' | '7d' | '30d';

export interface GPUHourRow {
  hostname?: string;
  instance?: string;
  gpu?: string;
  uuid?: string;
  // Hours = avg(util/100) over window × window-length-in-hours. With 4
  // GPUs all running at 100% utilization for one hour you'd get 4.0.
  hours: number;
}

export interface GPUHourResponse {
  range: GPUHourRange;
  from: string;
  to: string;
  generatedAt: string;
  rows: GPUHourRow[];
  total: number;
}

export function getGPUHour(clusterId: string, range: GPUHourRange) {
  return request<GPUHourResponse>(`/api/v1/clusters/${clusterId}/gpu-hour`, {
    method: 'GET',
    params: { range },
  });
}
