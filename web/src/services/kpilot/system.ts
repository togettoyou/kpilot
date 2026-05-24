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

// ─── System logs (/system/logs) ──────────────────────────────────────

// SystemLogEntry is one row from /api/v1/system/:node/logs. `fields`
// is the structured KV map the call site passed to pkg/log (already
// stringified by the backend; render as JSON in the UI for the
// expanded row view).
//
// `seq` is a STRING, not a number. The backend anchors seq at the
// process's UnixNano (~1.8e18 in 2026) which exceeds JavaScript's
// safe-integer range (2^53 ≈ 9e15). Parsed as Number, two seqs
// emitted within ~1µs of each other collapse onto the same value
// — breaking dedup, live-tail cursor advancement, and Set identity.
// The Go side serializes via `json:"seq,string"`; we keep the wire
// string here and compare via BigInt when ordering matters.
export interface SystemLogEntry {
  seq: string;
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  module?: string;
  msg: string;
  fields?: Record<string, unknown>;
}

// Call modes:
//
//   { afterSeq }                    — live-tail incremental: rows with
//                                     seq > afterSeq, newest first.
//                                     Frontend polling every 2 s.
//
//   { rangeQuery, level?, module?,  — windowed query via the shared
//     q?, limit? }                     TimeRangePicker vocabulary,
//                                     same key as monitoring.
//
// Filters (any combination):
//   level     — 'debug'|'info'|'warn'|'error'|'fatal' (min level)
//   module    — exact name OR dotted prefix ('handler' matches
//                'handler.model', 'handler.volcano', …)
//   q         — case-insensitive substring in msg
//   limit     — cap rows; backend hard cap 5 000.
export interface SystemLogsOpts {
  // String for the same precision reason as SystemLogEntry.seq —
  // the backend's `?after_seq=` Sscanf parses the URL value back
  // into uint64, so we hand it the raw decimal string we got out
  // of a previous response (no Number round-trip).
  afterSeq?: string;
  rangeQuery?: string;
  level?: string;
  module?: string;
  q?: string;
  limit?: number;
}

export function listSystemLogs(nodeID: string, opts: SystemLogsOpts = {}) {
  // Filter params go through URLSearchParams (it encodes values for us).
  // The range query, however, is ALREADY URL-encoded by buildRangeQuery
  // — running it through URLSearchParams.set + toString() double-encodes
  // (`%3A` → `%253A`), and the server's time.Parse(RFC3339) rejects the
  // resulting string with INVALID_REQUEST. Concatenate the pre-encoded
  // rangeQuery into the final URL string instead.
  const filters = new URLSearchParams();
  if (opts.afterSeq !== undefined) {
    filters.set('after_seq', opts.afterSeq);
  }
  if (opts.level) filters.set('level', opts.level);
  if (opts.module) filters.set('module', opts.module);
  if (opts.q) filters.set('q', opts.q);
  if (opts.limit) filters.set('limit', String(opts.limit));

  const parts: string[] = [];
  // Range only applies when not in live-tail mode (afterSeq mutually
  // exclusive at the handler level — sending both makes after_seq win
  // and the time filter is ignored, but cleaner to not send the redundant
  // bytes either).
  if (opts.afterSeq === undefined && opts.rangeQuery) {
    parts.push(opts.rangeQuery);
  }
  const fs = filters.toString();
  if (fs) parts.push(fs);
  const qs = parts.join('&');

  const url = `/api/v1/system/${encodeURIComponent(nodeID)}/logs${qs ? `?${qs}` : ''}`;
  return request<SystemLogEntry[]>(url, { method: 'GET' });
}

// listSystemLogModules returns the distinct module names for the
// given node. Pass the empty string to fetch the union across all
// nodes — only useful for debugging; normally the picker is
// node-scoped so operators don't see "tunnel" in the server view
// or "gorm" in the worker view.
export function listSystemLogModules(nodeID = '') {
  const qs = nodeID ? `?node_id=${encodeURIComponent(nodeID)}` : '';
  return request<string[]>(`/api/v1/system/logs/modules${qs}`, { method: 'GET' });
}

// listSystemHistory fetches snapshots for one node. Three calling
// modes — at most one set of params can be active at a time:
//
//   { since }                      — incremental: rows strictly
//                                    after `since` (RFC3339). Only
//                                    used by the 1 h live mode's
//                                    15 s polling tick. Backend
//                                    returns ≤ 240 raw rows.
//   { rangeQuery: 'range=24h' }    — preset window. Backend
//                                    downsamples to ~240 rows so a
//                                    24 h pull stays renderable.
//   { rangeQuery: 'from=&to=' }    — absolute window via the shared
//                                    TimeRangePicker.buildRangeQuery
//                                    output. Same downsampling.
//
// Callers typically use the latter two for the initial fetch + on
// range-change, and the first for steady-state incremental polling
// when the user is on the live 1 h preset.
export function listSystemHistory(
  nodeID: string,
  opts: { since?: string; rangeQuery?: string },
) {
  let qs = '';
  if (opts.since) {
    qs = `?since=${encodeURIComponent(opts.since)}`;
  } else if (opts.rangeQuery) {
    qs = `?${opts.rangeQuery}`;
  }
  const url = `/api/v1/system/${encodeURIComponent(nodeID)}/history${qs}`;
  return request<SystemHistoryItem[]>(url, { method: 'GET' });
}
