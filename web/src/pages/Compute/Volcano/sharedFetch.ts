import type { CRRef } from '@/services/kpilot/workload';
import { getWorkload } from '@/services/kpilot/workload';

// fetchOnce dedupes per-row workload GETs across cells that share a
// row. Volcano Queue / CronJob row has 2-3 components fetching the
// same object (state cell, detail cell, action button) — naive
// useRequest doesn't dedupe across instances, so each render fires
// 2-3 identical HTTP GETs. A module-level Promise cache keyed by
// (kind, cluster, namespace, name, tick) makes the second + third
// calls reuse the first's in-flight Promise so we end up with one
// HTTP request per row per refresh.
//
// Tick is the WorkloadRefreshTickContext value: when the user clicks
// Refresh on the workload page, tick bumps and the next fetch sees a
// stale entry → fires a fresh request.
//
// The cache holds Promises (resolved or pending). Once a Promise has
// resolved, calling .then() on it is essentially free — it replays
// the cached value synchronously on the next microtask. So callers
// don't see a cache vs in-flight distinction — they just await.

interface Entry {
  tick: number;
  promise: Promise<unknown>;
}

const cache = new Map<string, Entry>();

function keyOf(
  clusterId: string,
  cr: CRRef,
  name: string,
  namespace: string,
): string {
  return `${cr.kind}:${clusterId}:${namespace}:${name}`;
}

export function fetchOnce(
  clusterId: string,
  cr: CRRef,
  name: string,
  namespace: string,
  tick: number,
): Promise<unknown> {
  const key = keyOf(clusterId, cr, name, namespace);
  const existing = cache.get(key);
  if (existing && existing.tick === tick) return existing.promise;
  const promise = getWorkload(clusterId, '_cr', name, namespace, cr);
  cache.set(key, { tick, promise });
  // Drop on rejection so a transient network error doesn't lock the
  // entry — next render will retry.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}
