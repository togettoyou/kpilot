import { useCallback, useEffect, useRef } from 'react';

// useBurstRefresh wraps a refresh() function from useRequest (or any
// equivalent) and returns a `burst` trigger that fires an immediate
// refresh + N follow-up refreshes at fixed intervals. Designed for
// "after a mutation" UX: K8s is eventually consistent — a Pod just
// deleted shows up as Terminating for ~5s, a Deployment edit takes
// 2–6s to roll out, vGPU annotations propagate one informer tick
// later. A single refresh shows the stale snapshot the user already
// saw; a burst catches the converged state.
//
// Default: immediate + every 2s for 10s (≈6 calls total: 0, 2, 4, 6,
// 8, 10s). The cluster has typically converged by then for any
// kubectl-level operation we expose.
//
// Lifecycle:
//   - burst() cancels any in-flight burst and starts a new one. Two
//     rapid actions (delete then delete again) don't pile up timers.
//   - Hook auto-cancels on unmount; pending refreshes won't fire
//     against a stale component (also harmless since useRequest is
//     unmount-aware, but cleaning up still saves a few timer ticks).
//   - cancel() is exposed for explicit cancellation (e.g., on a
//     panel close).
export function useBurstRefresh(
  refresh: () => void,
  opts?: { intervalMs?: number; durationMs?: number },
) {
  const intervalMs = opts?.intervalMs ?? 2000;
  const durationMs = opts?.durationMs ?? 10_000;

  // Mirror refresh through a ref so the burst() closure stays stable
  // — without this, each render gives a new refresh function ref,
  // which would make burst() unstable and force re-renders on every
  // component using it as a dep.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const cancelRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
  }, []);

  const burst = useCallback(() => {
    cancel();
    refreshRef.current();
    const id = window.setInterval(() => refreshRef.current(), intervalMs);
    const stopId = window.setTimeout(() => {
      window.clearInterval(id);
      cancelRef.current = null;
    }, durationMs);
    cancelRef.current = () => {
      window.clearInterval(id);
      window.clearTimeout(stopId);
    };
  }, [cancel, intervalMs, durationMs]);

  useEffect(() => () => cancel(), [cancel]);

  return { burst, cancel };
}
