import { useRequest } from '@umijs/max';
import type { DependencyList } from 'react';
import { useEffect } from 'react';

interface Options {
  // When false, the helper skips the fetch and clears any previously
  // loaded data so children render their unready / not-installed state
  // instead of stale rows.
  ready?: boolean;
}

// ClusterRequestResult is the slice of useRequest's surface that pages
// actually consume. Explicit return type so TypeScript doesn't widen
// T → {} through the manual-mode wrapper (which it does when the helper
// returns useRequest's full inferred Result type).
export interface ClusterRequestResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  refresh: () => void;
  mutate: (data?: T) => void;
  run: () => void;
}

// useClusterRequest wraps @umijs/max's useRequest with `manual: true`
// plus a deps-driven useEffect that calls `run()`. This replaces the
// `ready + refreshDeps` anti-pattern documented in CLAUDE.md: useRequest
// still fires once on deps change even when ready=false, so a transition
// like `name='foo' → null` (drawer close, route param clear) used to
// produce a fetch with `null` interpolated into the URL — guaranteed 404.
//
// `formatResult: (res) => res` is the universal contract per CLAUDE.md
// so the wrapped service can return its bare object without the
// {success,data} envelope.
//
// Typical use:
//   const { data, loading, error, refresh } = useClusterRequest(
//     () => listVolcanoQueues(clusterId, { limit: 500 }),
//     [clusterId],
//     { ready: !!clusterId },
//   );
export function useClusterRequest<T>(
  service: () => Promise<T>,
  deps: DependencyList,
  options?: Options,
): ClusterRequestResult<T> {
  const ready = options?.ready !== false;
  const req = useRequest<T, []>(service, {
    manual: true,
    formatResult: (res) => res,
  });
  // Run on every deps change, but only when ready. Lazy fetch with an
  // explicit clear path: when ready transitions false we mutate to
  // undefined so consumers see a fresh empty state instead of cached
  // data from a previous (cluster, ns) tuple.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready) {
      req.mutate(undefined as unknown as T);
      return;
    }
    req.run();
    // service is intentionally NOT in deps — it's a closure over `deps`
    // by lexical scope. Adding it would re-run every render because
    // arrow functions are fresh each tick.
  }, [ready, ...deps]);
  return req as ClusterRequestResult<T>;
}
