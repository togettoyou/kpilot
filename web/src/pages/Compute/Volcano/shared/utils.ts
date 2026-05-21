// shared/utils.ts — helpers used across multiple Volcano / GPU pages.
// Previously each helper lived inline in 2-3 files; consolidating here
// keeps semantics consistent across the platform and saves drift.

// parseQuantity is the best-effort K8s Quantity translator used by the
// queue dashboards and GPU pages. Handles cpu millicores (`m` suffix),
// binary prefixes (Ki/Mi/Gi/Ti/Pi), and decimal SI prefixes
// (k/M/G/T/P/E — note SI kilo is lowercase per K8s/SI convention).
// Charts are illustrative, not balance-sheet exact — Quantities with
// E/e (scientific) or fractional exponents fall back to Number() which
// is usually right for the resource-list payloads we render.
//
// Was bitten in the wild by Volcano emitting `"12k"` for
// `volcano.sh/vgpu-memory`: the previous table only had uppercase `K`,
// `Number("12k")` returns NaN, so parseQuantity returned 0 and the
// scheduling overview's GPU memory row + the queue-quota vgpu-memory
// bar both showed 0 even though the queue clearly had 12000 MiB.
export function parseQuantity(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (!s) return 0;
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 0;
  }
  const binPrefixes: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  for (const [p, mul] of Object.entries(binPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  // SI kilo is lowercase `k` (uppercase K means Kelvin per SI). K8s
  // / kubelet / Volcano emit lowercase. The uppercase `K` entry stays
  // as a tolerance backup in case someone hand-authored a Queue spec.
  const decPrefixes: Record<string, number> = {
    k: 1000,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  };
  for (const [p, mul] of Object.entries(decPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// shortUUID formats a NVIDIA GPU UUID (`GPU-<32 hex chars>`) as
// `…<last 8>` so wide table cells stay readable while still giving the
// operator something unique enough to grep / copy. The full UUID
// remains available via copy buttons on the columns that need it.
export function shortUUID(uuid: string | undefined): string {
  if (!uuid) return '';
  return `…${uuid.slice(-8)}`;
}

// usageBand classifies a [0,1] ratio into one of three severity bands
// matching kpilot's platform-wide thresholds. Pages map the band to
// a real color via theme.useToken() (token.colorError /
// colorWarning / colorSuccess) so dark and light mode share the same
// semantic meaning. Centralizing the thresholds here keeps gauges /
// banners / status rings consistent.
export type UsageBand = 'success' | 'warning' | 'error';
export function usageBand(ratio: number): UsageBand {
  if (!Number.isFinite(ratio)) return 'success';
  if (ratio >= 0.85) return 'error';
  if (ratio >= 0.6) return 'warning';
  return 'success';
}

// usageColor turns a usage ratio directly into a theme-token color
// string. Pages that already hold a token via theme.useToken() can call
// this without the band intermediate.
export function usageColor(
  ratio: number,
  token: { colorSuccess: string; colorWarning: string; colorError: string },
): string {
  const band = usageBand(ratio);
  if (band === 'error') return token.colorError;
  if (band === 'warning') return token.colorWarning;
  return token.colorSuccess;
}
