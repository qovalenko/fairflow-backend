/**
 * FR-ACCESS-560: derive «ещё N записей скрыто по настройкам доступа» from list
 * totals. `projectTotal` counts active project rows without visibility/ABAC;
 * `visibleTotal` is the filtered list total the caller already has.
 */
export function computeHiddenByPolicy(
  visibleTotal: number,
  projectTotal: number,
): number {
  if (!Number.isFinite(visibleTotal) || !Number.isFinite(projectTotal)) return 0;
  const hidden = projectTotal - visibleTotal;
  return hidden > 0 ? hidden : 0;
}
