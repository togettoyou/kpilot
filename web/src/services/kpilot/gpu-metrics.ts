import { request } from '@umijs/max';

// Mirrors pkg/server/api/handler/gpu_metrics.go::gpuMetricsResponse.

export type GPUMetricsRange = '1h' | '24h' | '7d' | '30d';

// Metric IDs the server emits in `series`. Adding a new metric is a
// server-driven contract change; treat unknown keys as ignorable on
// the frontend rather than crashing — newer server + older frontend
// continues to work for the known panels.
export type GPUMetricKey =
  | 'util'
  | 'temp'
  | 'power'
  | 'fbUsed'
  | 'fbTotal'
  | 'sm'
  | 'tensor';

export interface GPUMetricPt {
  // Unix milliseconds, ready to feed directly to chart APIs.
  ts: number;
  value: number;
}

export interface GPUMetricSeries {
  hostname?: string;
  gpu?: string;
  uuid?: string;
  points: GPUMetricPt[];
}

export interface GPUMetricsSnapshot {
  activeGPUs: number;
  avgTempC: number;
  maxTempC: number;
  totalPowerW: number;
  avgUtilPct: number;
  fbUsedMiB: number;
  fbTotalMiB: number;
  fbUsagePct: number;
  avgTensorActPct: number;
}

export interface GPUMetricsResponse {
  range: GPUMetricsRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  snapshot: GPUMetricsSnapshot;
  series: Partial<Record<GPUMetricKey, GPUMetricSeries[]>>;
}

export function getGPUMetrics(clusterId: string, range: GPUMetricsRange) {
  return request<GPUMetricsResponse>(
    `/api/v1/clusters/${clusterId}/gpu-metrics`,
    { method: 'GET', params: { range } },
  );
}
