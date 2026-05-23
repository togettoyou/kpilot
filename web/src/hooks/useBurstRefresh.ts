import { useCallback, useEffect, useRef } from 'react';

// useBurstRefresh wraps a refresh() function from useRequest (or any
// equivalent) and returns a `burst` trigger that fires an immediate
// refresh + a few follow-up refreshes at chosen delays. Designed for
// "after a mutation" UX: K8s is eventually consistent — a Pod just
// deleted shows up as Terminating for ~5s, a Deployment edit takes
// 2–6s to roll out, vGPU annotations propagate one informer tick
// later. A single refresh shows the stale snapshot the user already
// saw; a burst catches the converged state without thrashing the
// worker tunnel.
//
// Default delays: [0, 2000, 5000] ms (3 calls total):
//   - 0   immediate — feedback right after the action lands
//   - 2s  catches fast ops (cordon, patch, simple deletes)
//   - 5s  catches most K8s convergence (Pod Terminating → gone,
//         small Deployment rolls, queue updates)
//
// Anything slower (multi-replica rollouts, image-pull-bound Pod
// starts) is on the user to hit Refresh — the auto-burst shouldn't
// hold a worker channel open for 10s × every action × every user.
//
// Lifecycle:
//   - burst() cancels any in-flight burst and starts a new one. Two
//     rapid actions (delete then delete again) don't pile up timers.
//   - Hook auto-cancels on unmount; pending refreshes won't fire
//     against a stale component (also harmless since useRequest is
//     unmount-aware, but cleaning up still saves a few timer ticks).
//   - cancel() is exposed for explicit cancellation (e.g., on a
//     panel close).
//
// Override the delay schedule via `delaysMs` for slower-converging
// pages — but think hard before doing it; the default is tuned
// to be polite to the worker.
export function useBurstRefresh(
  refresh: () => void,
  opts?: { delaysMs?: number[] },
) {
  const delaysMs = opts?.delaysMs ?? [0, 2000, 5000];

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
    const timers: number[] = [];
    for (const d of delaysMs) {
      if (d <= 0) {
        refreshRef.current();
        continue;
      }
      timers.push(window.setTimeout(() => refreshRef.current(), d));
    }
    cancelRef.current = () => {
      for (const t of timers) window.clearTimeout(t);
    };
    // Self-clear once the last scheduled timer fires so cancel() on
    // unmount doesn't try to clear already-fired timeouts (harmless,
    // but tidier).
    const maxDelay = delaysMs.reduce((m, d) => Math.max(m, d), 0);
    if (maxDelay > 0) {
      window.setTimeout(() => {
        if (cancelRef.current) cancelRef.current = null;
      }, maxDelay + 10);
    }
  }, [cancel, delaysMs]);

  useEffect(() => () => cancel(), [cancel]);

  return { burst, cancel };
}
