import { request } from '@umijs/max';

// Build a WebSocket URL for the Pod logs endpoint, derived from window.location
// so the dev proxy + production reverse-proxy both work without env-specific
// config. The auth cookie is sent automatically with the WS handshake.
export function buildPodLogsURL(
  clusterId: string,
  namespace: string,
  pod: string,
  opts: {
    container?: string;
    follow?: boolean;
    tail?: number;
    previous?: boolean;
  },
): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (opts.container) params.set('container', opts.container);
  if (opts.follow !== undefined) params.set('follow', String(opts.follow));
  if (opts.tail !== undefined) params.set('tail', String(opts.tail));
  if (opts.previous) params.set('previous', '1');
  return `${proto}//${window.location.host}/api/v1/clusters/${clusterId}/pods/${namespace}/${pod}/logs?${params.toString()}`;
}

export function buildPodExecURL(
  clusterId: string,
  namespace: string,
  pod: string,
  opts: { container?: string; cols: number; rows: number },
): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (opts.container) params.set('container', opts.container);
  params.set('cols', String(opts.cols));
  params.set('rows', String(opts.rows));
  // Shell selection is owned by the worker: it tries /bin/bash first and
  // falls back to /bin/sh if bash isn't installed in the container.
  return `${proto}//${window.location.host}/api/v1/clusters/${clusterId}/pods/${namespace}/${pod}/exec?${params.toString()}`;
}

export interface PodContainerUsage {
  name: string;
  cpu_milli: number;
  memory_bytes: number;
}

export interface PodTopResponse {
  timestamp: string;
  window: string;
  containers: PodContainerUsage[];
}

// Fetch realtime CPU/memory usage for a pod. Backend returns 404 with
// errors.RESOURCE_NOT_AVAILABLE when Metrics Server isn't installed or
// hasn't produced data — the calling drawer renders an install hint
// for that code instead of a generic error toast.
export function getPodTop(
  clusterId: string,
  namespace: string,
  name: string,
) {
  return request<PodTopResponse>(
    `/api/v1/clusters/${clusterId}/pods/${namespace}/${name}/top`,
    { method: 'GET' },
  );
}
