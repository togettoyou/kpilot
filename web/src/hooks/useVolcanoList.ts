import type { DependencyList } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { VolcanoListResponse } from '@/services/kpilot/volcano-list';

// useVolcanoList wraps a cursor-paginated Volcano list endpoint. K8s
// `continue` tokens are forward-only — each call returns up to N items
// plus a token for the next page; the page accumulates them client-side
// so the user can scroll the full set even when the server-side cap
// (500 by default) cuts the first response short.
//
// The hook itself is deliberately not built on @umijs/max's useRequest:
// useRequest's deps semantics don't map cleanly onto "reset + paged
// accumulator", and the wrapper would end up doing as much work as the
// underlying setState dance. Direct state management keeps the data
// flow obvious.
//
// `refresh` resets the accumulator and re-fetches the first page —
// callers wire it to RefreshControl. `loadMore` fetches the next page
// using the most recent continue token. `hasMore` exposes whether the
// last response indicated more data on the server.
//
// Concurrent fetches are serialized via a token-stamped guard: every
// fetch tags itself with a generation counter at start and only commits
// state if its generation matches the latest. This means a fast
// refresh-during-loadMore (or repeated loadMore clicks) can't race in
// a stale page on top of a fresh accumulator.

export interface ListFn<T> {
  (continueToken?: string): Promise<VolcanoListResponse<T>>;
}

export interface UseVolcanoListResult<T> {
  items: T[];
  loading: boolean;
  error: Error | undefined;
  refresh: () => void;
  loadMore: () => void;
  hasMore: boolean;
  // total is the server's best estimate of the full result size when
  // available (items.length + remainingItemCount). undefined when the
  // server didn't report a remaining count.
  total: number | undefined;
}

interface Options {
  // When false the hook idles — no fetch, items emptied.
  ready?: boolean;
}

export function useVolcanoList<T>(
  fn: ListFn<T>,
  deps: DependencyList,
  options?: Options,
): UseVolcanoListResult<T> {
  const ready = options?.ready !== false;
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [continueToken, setContinueToken] = useState<string | undefined>(
    undefined,
  );
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>(undefined);

  // genRef tags every in-flight fetch with a monotonic generation. On
  // refresh / unmount / deps-change we bump the counter; stale callbacks
  // then see they're no longer the latest and skip the setState.
  const genRef = useRef(0);
  // continueRef mirrors continueToken for the loadMore closure so a
  // rapid double-click doesn't load the same page twice from a stale
  // state snapshot.
  const continueRef = useRef<string | undefined>(undefined);
  // fnRef holds the latest fetch function so loadMore stays stable
  // (doesn't need fn in its deps).
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  const fetchPage = useCallback(
    async (token: string | undefined, gen: number, append: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const res = await fnRef.current(token);
        if (gen !== genRef.current) return;
        const newItems = res.items ?? [];
        setItems((prev) => (append ? [...prev, ...newItems] : newItems));
        const next = res.continue || undefined;
        setContinueToken(next);
        continueRef.current = next;
        setHasMore(!!next);
        if (typeof res.remainingItemCount === 'number') {
          setTotal((prev) => {
            const base = append ? prev ?? 0 : 0;
            return base + newItems.length + (res.remainingItemCount ?? 0);
          });
        } else if (!next) {
          // No more pages and no remainingItemCount: total is just what
          // we've accumulated.
          setTotal((prev) => (append ? (prev ?? 0) + newItems.length : newItems.length));
        } else if (!append) {
          setTotal(undefined);
        }
      } catch (e: any) {
        if (gen !== genRef.current) return;
        setError(e);
      } finally {
        if (gen === genRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  const refresh = useCallback(() => {
    if (!ready) return;
    const gen = ++genRef.current;
    continueRef.current = undefined;
    setHasMore(false);
    setTotal(undefined);
    fetchPage(undefined, gen, false);
  }, [ready, fetchPage]);

  const loadMore = useCallback(() => {
    if (!ready) return;
    const token = continueRef.current;
    if (!token) return;
    const gen = ++genRef.current;
    fetchPage(token, gen, true);
  }, [ready, fetchPage]);

  // deps-change → fresh fetch. Bumping genRef cancels any in-flight
  // page from the previous (cluster, ns) tuple so the accumulator stays
  // pure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready) {
      const gen = ++genRef.current;
      void gen;
      setItems([]);
      setContinueToken(undefined);
      continueRef.current = undefined;
      setHasMore(false);
      setTotal(undefined);
      setError(undefined);
      return;
    }
    const gen = ++genRef.current;
    continueRef.current = undefined;
    setHasMore(false);
    setTotal(undefined);
    setItems([]);
    fetchPage(undefined, gen, false);
  }, [ready, ...deps]);

  // unmount: invalidate any pending fetch.
  useEffect(() => {
    return () => {
      genRef.current++;
    };
  }, []);

  // Silence unused-state warnings for continueToken — kept so future
  // callers / devtools can introspect the current cursor without a ref.
  void continueToken;

  return { items, loading, error, refresh, loadMore, hasMore, total };
}
