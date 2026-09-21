/** Default high-frequency collapse window (FR-MNOT-19). */
export const DEFAULT_COLLAPSE_WINDOW_SEC = 300;

/** Bucket timestamp into a fixed window for collapse grouping. */
export function collapseWindowBucket(nowMs: number, windowSec: number): number {
  const w = Math.max(1, windowSec) * 1000;
  return Math.floor(nowMs / w);
}

/**
 * Collapse key: same user + category + entity within a time window (FR-MNOT-19).
 * Distinct from idempotency `message_id` which is per-envelope+addressee.
 */
export function buildCollapseKey(input: {
  user_id: string;
  category: string;
  entity_type?: string;
  entity_id?: string;
  windowSec: number;
  nowMs?: number;
}): string {
  const bucket = collapseWindowBucket(input.nowMs ?? Date.now(), input.windowSec);
  const entity = `${input.entity_type ?? ''}:${input.entity_id ?? ''}`;
  return `collapse:${input.user_id}:${input.category}:${entity}:${bucket}`;
}
