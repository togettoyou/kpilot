import { request } from '@umijs/max';

import type { TimeRangeValue } from '@/components/TimeRangePicker';
import { buildRangeQuery } from '@/components/TimeRangePicker';

// monitoring.ts — services for the cluster Monitoring page. Three
// endpoints map to the three drill-down levels (cluster / node /
// pod); each accepts the shared TimeRangeValue (preset OR custom
// from/to) and translates to the matching URL form.

// MetricsRange names the four preset windows the picker exposes. Kept
// for compatibility with any callers that want a preset literal, but
// the response's `range` field can also be a "custom:from:to" string
// (when the user picks an absolute range) — see ResponseRange.
export type MetricsRange = '1h' | '24h' | '7d' | '30d';

// ResponseRange is what the backend echoes back. Either one of the
// MetricsRange presets or "custom:<from>:<to>" verbatim.
export type ResponseRange = MetricsRange | string;

// rangeQS returns the URL query string fragment for the given range —
// just delegates to the shared helper but keeps the service file
// self-contained for readers tracing what shows up on the wire.
function rangeQS(v: TimeRangeValue): string {
  return buildRangeQuery(v);
}

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
  range: ResponseRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  snapshot: ClusterMetricsSnapshot;
  series: Record<string, ClusterMetricsSeries>;
}

export function getClusterMetrics(clusterId: string, range: TimeRangeValue) {
  return request<ClusterMetricsResponse>(
    `/api/v1/clusters/${clusterId}/cluster-metrics?${rangeQS(range)}`,
    { method: 'GET' },
  );
}

export interface NodeMetricSeries {
  instance: string;
  nodeName?: string;
  points: ClusterMetricsPoint[];
}

export interface NodeMetricsResponse {
  range: ResponseRange;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  series: Record<string, NodeMetricSeries[]>;
}

export function getNodeMetrics(clusterId: string, range: TimeRangeValue) {
  return request<NodeMetricsResponse>(
    `/api/v1/clusters/${clusterId}/node-metrics?${rangeQS(range)}`,
    { method: 'GET' },
  );
}

export interface PodMetricSeries {
  namespace: string;
  pod: string;
  latest: number;
  points: ClusterMetricsPoint[];
}

export interface PodMetricsResponse {
  range: ResponseRange;
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
  range: TimeRangeValue,
  namespace?: string,
  limit?: number,
) {
  const params: Record<string, string | number> = {};
  if (namespace) params.namespace = namespace;
  if (typeof limit === 'number' && limit > 0) params.limit = limit;
  return request<PodMetricsResponse>(
    `/api/v1/clusters/${clusterId}/pod-metrics?${rangeQS(range)}`,
    { method: 'GET', params },
  );
}
