import { request } from '@umijs/max';

export function getVersion() {
  return request<{ version: string }>('/api/v1/version', { method: 'GET' });
}

// ─── System monitoring (/system) ─────────────────────────────────────

// Identity carried in every snapshot — static-ish per process.
export interface SystemIdentity {
  kind: string; // "server" / "worker"
  name: string;
  hostname: string;
  pid: number;
  start_time: string;
  uptime_seconds: number;
  go_version: string;
  goos: string;
  goarch: string;
  app_version: string;
  num_cpu: number;
}

// Runtime metrics from pkg/diag. Histogram percentiles cover the last
// 1-second tick (not lifetime) — see snapshot.go in pkg/diag.
export interface SystemRuntime {
  goroutines: number;
  gomaxprocs: number;
  os_threads: number;
  heap_inuse_bytes: number;
  heap_idle_bytes: number;
  heap_released_bytes: number;
  heap_goal_bytes: number;
  stack_inuse_bytes: number;
  runtime_overhead_bytes: number;
  total_mapped_bytes: number;
  total_alloc_bytes: number;
  live_objects: number;
  rss_bytes: number;
  gc_cycles_total: number;
  gc_pause_p50_seconds: number;
  gc_pause_p90_seconds: number;
  gc_pause_p99_seconds: number;
  gc_pause_max_seconds: number;
  sched_latency_p50_seconds: number;
  sched_latency_p90_seconds: number;
  sched_latency_p99_seconds: number;
  cpu_user_seconds: number;
  cpu_scavenge_seconds: number;
  cpu_idle_seconds: number;
  cpu_gc_seconds: number;
  cpu_total_seconds: number;
  mutex_wait_total_seconds: number;
  open_fds: number;
  max_fds: number;
  mem_total_bytes: number;
  // Kernel-counted (not Go-runtime) CPU times for this PID — more
  // accurate than cpu_user_seconds in cgo / cpu-throttled containers
  // because the kernel sees every thread, not just Go-managed ones.
  process_cpu_user_seconds: number;
  process_cpu_system_seconds: number;
  // Disk I/O bytes (Linux only; 0 elsewhere).
  process_io_read_bytes: number;
  process_io_write_bytes: number;
  // System-wide memory view (host total in containers; the per-
  // container cgroup limit is mem_total_bytes above).
  system_mem_used_bytes: number;
  system_mem_available_bytes: number;
}

export interface SystemSnapshot {
  identity: SystemIdentity;
  runtime: SystemRuntime;
  custom?: Record<string, Record<string, unknown>>;
  at: string;
}

export interface SystemNode {
  node_id: string;
  kind: 'server' | 'worker';
  cluster_id?: string;
  cluster_name?: string;
  online: boolean;
  diag_available: boolean;
}

export interface SystemSnapshotEnvelope {
  node_id: string;
  snapshot?: SystemSnapshot;
  error?: string;
}

export function listSystemNodes() {
  return request<SystemNode[]>('/api/v1/system/nodes', { method: 'GET' });
}

export function batchSystemSnapshots() {
  return request<SystemSnapshotEnvelope[]>('/api/v1/system/snapshots', { method: 'GET' });
}

// pprofURL builds the absolute REST path the browser hands to a
// download link / window.open. confirm=true is required for CPU
// profile + trace (server returns 403 PPROF_CONFIRMATION_REQUIRED
// otherwise) — the dashboard surfaces a Modal before opening.
export function pprofURL(
  nodeID: string,
  kind: string,
  opts?: { seconds?: number; debug?: number; confirm?: boolean },
) {
  const params = new URLSearchParams();
  if (opts?.seconds) params.set('seconds', String(opts.seconds));
  if (opts?.debug !== undefined) params.set('debug', String(opts.debug));
  if (opts?.confirm) params.set('confirm', 'true');
  const q = params.toString();
  const base = `/api/v1/system/${encodeURIComponent(nodeID)}/pprof/${kind}`;
  return q ? `${base}?${q}` : base;
}

// SystemHistoryItem is one row of GET /api/v1/system/:node/history.
// `at` is the server-side ingest timestamp (UTC). `snapshot` is the
// full diag snapshot JSON the poller stored — same shape as
// SystemSnapshot, just embedded inside the history array.
export interface SystemHistoryItem {
  at: string;
  snapshot: SystemSnapshot;
}

// listSystemHistory fetches the rolling 1 h of snapshots for one
// node. Pass `since` to get only rows newer than a previous fetch —
// used by the detail page's 15 s incremental polling so we don't
// re-download the whole window each tick.
export function listSystemHistory(nodeID: string, opts?: { since?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.since) params.set('since', opts.since);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const q = params.toString();
  const url = `/api/v1/system/${encodeURIComponent(nodeID)}/history${q ? '?' + q : ''}`;
  return request<SystemHistoryItem[]>(url, { method: 'GET' });
}
