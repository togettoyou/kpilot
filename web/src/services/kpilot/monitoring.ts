import { request } from '@umijs/max';

// monitoring.ts — services for the cluster Monitoring page. Three
// endpoints map to the three drill-down levels (cluster / node /
// pod); each shares the same MetricsRange enum so the page can wire
// one range picker to all three fetches.

export type MetricsRange = '1h' | '24h' | '7d' | '30d';

export interface ClusterMetricsSnapshot {
  nodesReady: number;
  nodesTotal: number;
  cpuUtilPct: number;
  memUtilPct: number;
  // Absolute values backing the rate fields above — a 45% number
  // reads very differently depending on whether it's 45% of 4 cores
  // or 45% of 400. Zero indicates the source metric isn't present
  // (node-exporter missing); UI then shows just the rate.
  cpuTotalCores: number;
  cpuUsedCores: number;
  memTotalBytes: number;
  memUsedBytes: number;
  podsByPhase: Record<string, number>;
  podsTotal: number;
  podsPending: number;
}

export interface ClusterMetricsPoint {
  ts: number;
  value: number;
}

export interface ClusterMetricsSeries {
  points: ClusterMetricsPoint[];
}

export interface ClusterMetricsResponse {
  range: MetricsRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  snapshot: ClusterMetricsSnapshot;
  series: Record<string, ClusterMetricsSeries>;
}

export function getClusterMetrics(clusterId: string, range: MetricsRange) {
  return request<ClusterMetricsResponse>(
    `/api/v1/clusters/${clusterId}/cluster-metrics`,
    { method: 'GET', params: { range } },
  );
}

export interface NodeMetricSeries {
  instance: string;
  nodeName?: string;
  points: ClusterMetricsPoint[];
}

export interface NodeMetricsResponse {
  range: MetricsRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  series: Record<string, NodeMetricSeries[]>;
}

export function getNodeMetrics(clusterId: string, range: MetricsRange) {
  return request<NodeMetricsResponse>(
    `/api/v1/clusters/${clusterId}/node-metrics`,
    { method: 'GET', params: { range } },
  );
}

export interface PodMetricSeries {
  namespace: string;
  pod: string;
  latest: number;
  points: ClusterMetricsPoint[];
}

export interface PodMetricsResponse {
  range: MetricsRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  namespace?: string;
  series: Record<string, PodMetricSeries[]>;
}

export interface PodHealthRow {
  namespace: string;
  pod: string;
  restarts: number;
  ooms: number;
}

export interface PodHealthResponse {
  generatedAt: string;
  namespace?: string;
  rows: PodHealthRow[];
}

export function getPodHealth(
  clusterId: string,
  namespace?: string,
  limit?: number,
) {
  const params: Record<string, string | number> = {};
  if (namespace) params.namespace = namespace;
  if (typeof limit === 'number' && limit > 0) params.limit = limit;
  return request<PodHealthResponse>(
    `/api/v1/clusters/${clusterId}/pod-health`,
    { method: 'GET', params },
  );
}

export function getPodMetrics(
  clusterId: string,
  range: MetricsRange,
  namespace?: string,
  limit?: number,
) {
  const params: Record<string, string | number> = { range };
  if (namespace) params.namespace = namespace;
  if (typeof limit === 'number' && limit > 0) params.limit = limit;
  return request<PodMetricsResponse>(
    `/api/v1/clusters/${clusterId}/pod-metrics`,
    { method: 'GET', params },
  );
}
