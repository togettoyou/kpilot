import { request } from '@umijs/max';

// logs.ts — services for the cluster Logging page. Two endpoints
// (search + histogram) share the same query / from / to / limit
// parameters so the page can fire them in parallel.

export interface LogLine {
  time: string;
  message: string;
  stream?: string;
  namespace?: string;
  pod?: string;
  container?: string;
  node?: string;
  fields?: Record<string, string>;
}

export interface LogSearchResponse {
  query: string;
  from: string;
  to: string;
  generatedAt: string;
  limit: number;
  lines: LogLine[];
  truncated: boolean;
}

export interface LogsHistogramPoint {
  ts: number;
  count: number;
}

export interface LogsHistogramResponse {
  query: string;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  points: LogsHistogramPoint[];
  total: number;
}

export interface LogQueryParams {
  query: string;
  from: string; // RFC3339
  to: string;   // RFC3339
  limit?: number;
}

export function searchLogs(clusterId: string, p: LogQueryParams) {
  return request<LogSearchResponse>(
    `/api/v1/clusters/${clusterId}/logs/search`,
    {
      method: 'GET',
      params: {
        query: p.query,
        from: p.from,
        to: p.to,
        ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
      },
    },
  );
}

export function logsHistogram(clusterId: string, p: LogQueryParams) {
  return request<LogsHistogramResponse>(
    `/api/v1/clusters/${clusterId}/logs/histogram`,
    {
      method: 'GET',
      params: { query: p.query, from: p.from, to: p.to },
    },
  );
}
