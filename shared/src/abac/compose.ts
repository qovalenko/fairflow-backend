/**
 * Access-filter composition (RFC-ABAC §7.3, B2 — conjunctive, fail-closed SI-1).
 *
 *   finalFilter = { projectId } AND ( visibilityScope OR sharing ) AND abacFilter
 *
 *  - `{ projectId }` — the unbreakable isolation boundary (non-договорной №3), AND-ed first;
 *  - `visibility` — `buildVisibilityFilter(scope)` output (visibility OR sharing already inside),
 *    NOT produced by `compileMongo`;
 *  - `abac` — `compileMongo(normalizeAbac(resolveContextRefs(ir)))` | null.
 *
 * `abac=null` → no ABAC narrowing, BUT projectId/visibility still apply (SI-4, NOT fail-open).
 * Built on the gateway/domain edge, OUTSIDE `compileMongo`.
 */

import { withRecordOwnerAbacShortCircuit } from './owner-short-circuit';

export interface ComposeAccessFilterArgs {
  /** Project isolation value (x-project-id). */
  projectId: string;
  /** Field carrying the project id in the collection (default 'projectId'). */
  projectField?: string;
  /** buildVisibilityFilter(scope) — visibility OR sharing already inside; null = no narrowing. */
  visibility: Record<string, unknown> | null;
  /** compileMongo(...) abac fragment; null = no abac narrowing. */
  abac: Record<string, unknown> | null;
  /** Owner field for FR-ABAC-16 short-circuit (`ownerId` / `assigneeId`). */
  ownerField?: string;
  /** Viewer's user id — enables owner-of-record ABAC short-circuit when set. */
  recordOwnerSelfId?: string;
}

/**
 * Compose the final read filter fragment. Returns `{ $and: [...] }` with projectId always
 * first, then visibility (if any), then abac (if any).
 */
export function composeAccessFilter(args: ComposeAccessFilterArgs): Record<string, unknown> {
  const field = args.projectField ?? 'projectId';
  const parts: Record<string, unknown>[] = [{ [field]: args.projectId }];
  if (args.visibility) parts.push(args.visibility);
  const abac = withRecordOwnerAbacShortCircuit(
    args.abac,
    args.ownerField ?? 'ownerId',
    args.recordOwnerSelfId,
  );
  if (abac) parts.push(abac);
  return parts.length === 1 ? parts[0] : { $and: parts };
}
