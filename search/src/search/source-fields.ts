/**
 * TODO-264 — the projection inputs kept ON the index document so a PARTIAL event
 * can be merged over the last known state instead of overwriting it.
 *
 * Why this exists: `crm.contact.updated` / `crm.company.updated` ship a DIFF
 * (`changes[]` / `changedFields[]`), not a snapshot — renaming only the first
 * name emits `[{field:'firstName', newValue:'Пётр'}]`. Rebuilding the composite
 * `title` (`firstName lastName`) / `subtitle` (`email · phone`) from that diff
 * alone would silently drop the untouched half, so the surname would stop being
 * findable. Persisting the whitelisted flat inputs under `sourceFields` lets the
 * projection do `{...stored, ...diff}` and recompute the FULL projection with no
 * source-DB read (WN-MSRCH-2 still holds — we only read our own index).
 *
 * The list is a strict whitelist of what `buildProjection` (delta path) and
 * `reindexSources()` (rebuild path) actually consume — no untrusted egress and
 * no unbounded document growth.
 */
import { ABAC_MATERIALIZED_ATTRS } from '@fairflow/shared';

/** Composite-projection inputs (title/subtitle/tokens), camelCase canonical names. */
const TITLE_SOURCE_FIELDS = [
  'firstName',
  'lastName',
  'name',
  'email',
  'phone',
  'inn',
  'number',
  'status',
  'stageId',
  'amount',
  'sku',
  'category',
  'title',
  'subject',
  'type',
  'completed',
] as const;

/**
 * Flat projection inputs kept on the index document.
 *
 * [review-1] = title/subtitle inputs ∪ the DECLARED ABAC attributes. The ABAC half
 * is derived from the shared manifest, never re-typed, so a new attribute cannot
 * be declared for the predicate compiler and quietly stay unpersisted here: the
 * merged view `{...stored, ...payload}` that `buildProjection` re-materializes the
 * ABAC fields from would otherwise forget every attribute the current partial
 * event does not mention.
 */
export const PROJECTION_SOURCE_FIELDS: readonly string[] = [
  ...new Set<string>([
    ...TITLE_SOURCE_FIELDS,
    ...Object.values(ABAC_MATERIALIZED_ATTRS).flatMap((attrs) => attrs.map((a) => a.field)),
  ]),
];

/** snake_case spelling of a camelCase field (`expectedCloseDate` →
 * `expected_close_date`) — the reindex path reads RAW source rows and the CRM
 * collections carry both spellings. Derived, so it cannot fall behind the list. */
const snakeOf = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Pick the whitelisted projection inputs out of an event payload or a source row.
 * Only scalars (and explicit `null`, which means "cleared") are kept — objects and
 * arrays never enter the index document (an array-valued ABAC attribute such as
 * `tags` therefore lives ONLY as the flat top-level field written by
 * `pickAbacFields`, which the version-guarded `$set` merge keeps across partial
 * events; storing a copy here would risk re-materializing a truncated list).
 */
export function pickSourceFields(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PROJECTION_SOURCE_FIELDS) {
    let value = src[field];
    if (value === undefined) value = src[snakeOf(field)];
    if (value === undefined) continue;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[field] = value;
    }
  }
  return out;
}
