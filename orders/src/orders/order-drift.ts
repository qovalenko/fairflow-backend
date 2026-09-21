/**
 * Pure per-field drift computation for orders (OQ-MORD-3, contract 3.14).
 *
 * The order carries a point-in-time `snapshot` of the linked contact/company
 * requisites. Drift = the current source values diverge from that snapshot.
 * This module holds ONLY the pure comparison logic (no gRPC/IO) so it can be
 * unit-tested; the cross-domain reads live in `OrderSourceReaderService`.
 */

/** How a source donor responded when we asked for the current values. */
export type SourceState =
  | 'present' // donor returned the entity → we have current values
  | 'deleted' // donor answered NOT_FOUND → the record was removed
  | 'unknown'; // donor timed out / unavailable → we could NOT determine drift

/** Outcome of reading one source entity. */
export interface SourceRead {
  state: SourceState;
  /** Current field values (only meaningful when `state === 'present'`). */
  fields: Record<string, string>;
}

/** One per-field difference between the snapshot and the current source. */
export interface DriftDiff {
  entity: 'contact' | 'company';
  field: string;
  /** Value stored in the order snapshot. */
  old: string;
  /** Current value in the source domain ('' when the source is gone). */
  new: string;
}

export interface DriftResult {
  has_drift: boolean;
  /** `present` | `deleted` | `unknown` — the strongest signal across sources. */
  source_state: string;
  diffs: DriftDiff[];
}

/** Contact requisites captured in the snapshot and compared for drift. */
export const CONTACT_DRIFT_FIELDS = ['name', 'phone', 'email'] as const;
/** Company requisites captured in the snapshot and compared for drift. */
export const COMPANY_DRIFT_FIELDS = ['name', 'inn', 'kpp'] as const;

function norm(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

export interface DriftInput {
  /** '' when the order does not link a contact — then contact is not compared. */
  contactId?: string;
  companyId?: string;
  snapshot?: { contact?: Record<string, unknown>; company?: Record<string, unknown> } | null;
  /** undefined when the entity is not linked (nothing read). */
  contactRead?: SourceRead;
  companyRead?: SourceRead;
}

/**
 * Compare the order snapshot against the freshly-read source values, per field.
 *
 * Precedence of `source_state` across the (at most two) linked entities:
 *  - any `unknown` → `{ has_drift:false, source_state:'unknown', diffs:[] }`.
 *    A donor was unreachable, so we CANNOT tell whether values changed — we do
 *    not fabricate a drift banner the user could not resolve (accept would fail
 *    on the same unreachable source anyway).
 *  - any `deleted` (none unknown) → `has_drift:true, source_state:'deleted'`.
 *    A linked record was removed — that is genuine drift; per-field diffs carry
 *    the removed snapshot values with `new:''`.
 *  - all `present` → `has_drift = diffs.length>0, source_state:'present'`.
 */
export function computeOrderDrift(input: DriftInput): DriftResult {
  const diffs: DriftDiff[] = [];
  const states: SourceState[] = [];

  const entities: Array<{
    entity: 'contact' | 'company';
    id?: string;
    read?: SourceRead;
    snap: Record<string, unknown>;
    fields: readonly string[];
  }> = [
    {
      entity: 'contact',
      id: input.contactId,
      read: input.contactRead,
      snap: input.snapshot?.contact ?? {},
      fields: CONTACT_DRIFT_FIELDS,
    },
    {
      entity: 'company',
      id: input.companyId,
      read: input.companyRead,
      snap: input.snapshot?.company ?? {},
      fields: COMPANY_DRIFT_FIELDS,
    },
  ];

  for (const e of entities) {
    if (!e.id) continue; // order does not link this entity → nothing to compare.
    const read: SourceRead = e.read ?? { state: 'unknown', fields: {} };
    states.push(read.state);
    if (read.state === 'present') {
      for (const f of e.fields) {
        const oldV = norm(e.snap[f]);
        const newV = norm(read.fields[f]);
        if (oldV !== newV) diffs.push({ entity: e.entity, field: f, old: oldV, new: newV });
      }
    } else if (read.state === 'deleted') {
      // Source removed → every non-empty snapshot field is a drift to ''.
      for (const f of e.fields) {
        const oldV = norm(e.snap[f]);
        if (oldV) diffs.push({ entity: e.entity, field: f, old: oldV, new: '' });
      }
    }
    // 'unknown' → contributes no diff (handled by precedence below).
  }

  if (states.includes('unknown')) {
    return { has_drift: false, source_state: 'unknown', diffs: [] };
  }
  if (states.includes('deleted')) {
    return { has_drift: true, source_state: 'deleted', diffs };
  }
  return { has_drift: diffs.length > 0, source_state: 'present', diffs };
}

/**
 * Strip the CURRENT donor values from the drift result for the entities the
 * CALLER may not see (review: PII egress through `CheckDrift`).
 *
 * The verdict is computed from the full picture on purpose — `has_drift` feeds a
 * stored flag and the terminal-transition gate, so it must be the same for every
 * caller (see `OrdersService.refreshDrift`). What must NOT be the same is the
 * payload: a `diffs[].new` carries the donor's live phone/e-mail/ИНН, i.e. data
 * from a record the caller is not allowed to read. The `old` side is the order's
 * own pinned snapshot, so it is not filtered — the caller already reads it as
 * part of the order.
 *
 * Result for a hidden donor: `has_drift:true` with no values — enough to tell the
 * user «требуется принять изменения», nothing to read out of the invisible record.
 */
export function redactHiddenDiffs(
  result: DriftResult,
  hidden: Iterable<'contact' | 'company'>,
): DriftResult {
  const hide = new Set(hidden);
  if (!hide.size || !result.diffs.length) return result;
  const diffs = result.diffs.filter((d) => !hide.has(d.entity));
  return diffs.length === result.diffs.length ? result : { ...result, diffs };
}

/**
 * Single-entity drift check used by the reactive source-change consumer
 * (FR-ORDERS-390): does ONE order snapshot diverge from a freshly read donor?
 *
 * This is the per-entity branch of {@link computeOrderDrift} in isolation — the
 * consumer re-reads the changed donor exactly once and then compares it against
 * many order snapshots, so it must not pretend to know the state of the OTHER
 * linked entity (passing an absent read into computeOrderDrift would collapse the
 * whole result to `unknown`). Semantics match 1:1:
 *  - `unknown` → `false` (never raise a banner off an unobserved state);
 *  - `deleted` → `true`  (a linked record disappeared is genuine drift);
 *  - `present` → any compared requisite differs from the snapshot.
 */
export function entityDrifted(
  entity: 'contact' | 'company',
  snapshot:
    | { contact?: Record<string, unknown>; company?: Record<string, unknown> }
    | null
    | undefined,
  read: SourceRead,
): boolean {
  if (read.state === 'unknown') return false;
  if (read.state === 'deleted') return true;
  const fields = entity === 'contact' ? CONTACT_DRIFT_FIELDS : COMPANY_DRIFT_FIELDS;
  const snap = snapshot?.[entity] ?? {};
  return fields.some((field) => norm(snap[field]) !== norm(read.fields[field]));
}
