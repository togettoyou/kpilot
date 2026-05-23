// Shared formatters for the System monitoring pages. Kept local to
// pages/System/ so we don't grow another global "utils" surface; if
// these prove useful elsewhere later they can promote up.

export function formatBytes(n: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = opts?.compact ? (v >= 100 ? 0 : v >= 10 ? 1 : 2) : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h}h`;
}

export function formatPercent(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatMillis(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${(seconds * 1000).toFixed(2)} ms`;
}

export function formatBigNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
