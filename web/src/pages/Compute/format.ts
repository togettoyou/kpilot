// formatMB renders an MB integer as MiB / GiB based on size. HAMi
// memory advertises in MB so this is the right unit; we translate to
// GiB visually once a value exceeds ~1 GB to keep numbers readable.
export function formatMB(mb: number): string {
  if (mb <= 0) return '0 MiB';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
  return `${mb} MiB`;
}

// Resource keys shared across the 智算 pages.
export const RES_GPU = 'nvidia.com/gpu';
export const RES_GPUMEM = 'nvidia.com/gpumem';
export const RES_GPUCORES = 'nvidia.com/gpucores';
