/** Clamp pageIndex: NaN/negative → 0 (DoS guard for Mongo `.skip()`). */
export function parsePageIndex(raw?: string): number {
  const n = parseInt(raw ?? '0', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
