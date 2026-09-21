/**
 * ABAC attribute materialization for the search index (TODO-483).
 *
 * `compileMongo` emits residual leaves over `record.<flatField>` refs and
 * therefore produces FLAT, top-level field conditions (`{ stageId: {...} }`,
 * see shared/src/abac/materialize.ts §1). The index used to keep the attributes
 * NESTED under `abacAttrs` (and only for deals), so every ABAC-narrowed read
 * matched nothing — the predicate looked at a path that does not exist on the
 * index document.
 *
 * Here the declared attributes of shared `ABAC_MATERIALIZED_ATTRS` are copied
 * onto the index document as flat fields for EVERY indexable type, and the
 * matching project-scoped compound indexes are declared so the predicate is
 * index-backed (non-negotiable №3: `projectId` always wins the index prefix).
 */
import {
  abacMaterializedAttrs,
  abacMaterializedIndexSpecs,
  CROSS_ENTITY_TYPE_SUBJECTS,
  type MongoIndexSpec,
} from '@fairflow/shared';

/** index entityType → ABAC manifest resource (shared ABAC_MATERIALIZED_ATTRS key).
 *
 * [review-1] Taken from the shared cross-entity contract instead of a local copy:
 * it is the SAME vocabulary the gateway compiles the cross-entity ABAC predicate
 * over, so the attributes materialized here and the fields the predicate targets
 * are guaranteed to be about the same set of types. */
export const TYPE_TO_ABAC_RESOURCE: Readonly<Record<string, string>> = {
  ...CROSS_ENTITY_TYPE_SUBJECTS,
};

/**
 * Own fields of the index document — an ABAC attribute may never shadow them
 * (a manifest that declared e.g. `title` must not rewrite the indexed title).
 */
const RESERVED_INDEX_FIELDS: ReadonlySet<string> = new Set([
  '_id',
  'projectId',
  'entityType',
  'entityId',
  'title',
  'subtitle',
  'path',
  'tokens',
  'ownerId',
  'departmentId',
  'ownerField',
  'abacAttrs',
  'sourceUpdatedAt',
  'deletedAt',
  'version',
  'updatedAt',
]);

/** camelCase → snake_case spelling of the same attribute (`expectedCloseDate` →
 * `expected_close_date`). The reindex path reads RAW source rows, and the CRM
 * collections carry both spellings (`stageId` / `stage_id`, see `rowStr` in
 * SearchService) — reading only the camel one silently materialized `undefined`
 * for a value that WAS there, i.e. the very "attribute missing from the index"
 * class this module exists to prevent. */
const snakeOf = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Project a source record / event payload onto the flat ABAC attributes declared
 * for its entity type. Absent attributes stay absent (a missing field never
 * passes a predicate — RFC-5 §1.2, fail-closed).
 *
 * [review-1] `complete: true` marks the source as an AUTHORITATIVE SNAPSHOT of
 * the record (the recovery reindex, which reads the whole source row): there,
 * "attribute not in the row" means "the record has no value", so the attribute is
 * materialized as an explicit `null` instead of being left off the document. That
 * distinction is load-bearing for {@link abacCompletenessFilter}: an absent field
 * then means "this index document never learned the attribute", never "the record
 * is empty". An event payload is NOT such a snapshot — producers ship a
 * hand-picked field list (`crm.contact.created` = name/email/phone/owner, no
 * `source`/`tags`), so the delta path must keep `complete` off and leave the
 * attributes it did not hear about absent.
 */
export function pickAbacFields(
  entityType: string,
  src: Record<string, unknown>,
  opts?: { complete?: boolean },
): Record<string, unknown> {
  const resource = TYPE_TO_ABAC_RESOURCE[entityType];
  if (!resource) return {};
  const out: Record<string, unknown> = {};
  for (const attr of abacMaterializedAttrs(resource)) {
    if (RESERVED_INDEX_FIELDS.has(attr.field)) continue;
    // `undefined` only — an explicit `null` in the payload is a CLEAR and must be
    // written through (otherwise the Mongo `$set` merge keeps the stale value).
    const camel = src[attr.field];
    const v = camel === undefined ? src[snakeOf(attr.field)] : camel;
    if (v !== undefined) out[attr.field] = v;
    else if (opts?.complete) out[attr.field] = null;
  }
  return out;
}

/**
 * Compound `{ projectId: 1, <attr>: 1 }` specs for every materialized attribute
 * of every indexable type, de-duplicated by name (the single `search_index`
 * collection holds all types, and e.g. `amount`/`status` are declared by more
 * than one resource).
 */
export function searchAbacIndexSpecs(): MongoIndexSpec[] {
  const byName = new Map<string, MongoIndexSpec>();
  for (const resource of Object.values(TYPE_TO_ABAC_RESOURCE)) {
    for (const spec of abacMaterializedIndexSpecs(resource)) {
      if (!RESERVED_INDEX_FIELDS.has(Object.keys(spec.key)[1] ?? '')) {
        byName.set(spec.name, spec);
      }
    }
  }
  return [...byName.values()];
}

// ── read side: is the index document ABAC-complete for THIS predicate? ────────

/**
 * [review-1] The seam between the two write paths, and why the read must guard it.
 *
 * The index is filled from two sources that know DIFFERENT amounts about a record:
 *
 *  - the recovery reindex reads the whole source row → every declared attribute of
 *    the type is materialized (absent value → explicit `null`, see
 *    {@link pickAbacFields} `complete`);
 *  - the event delta materializes only what the producer put in the payload, and
 *    the producers ship a hand-picked field list: `crm.contact.created` carries
 *    name/email/phone/companyIds/ownerId — not `source`, not `tags`;
 *    `crm.company.created` carries name/ownerId/source — not `industry`/`region`.
 *    So a document that entered the index through an event legitimately has NO
 *    field for most declared ABAC attributes.
 *
 * Evaluating a compiled predicate against such a document is not fail-closed, it is
 * merely *undefined*: `{region: 'EU'}` does not match a missing field (record drops
 * out — an availability gap, it is visible on its own list route), but the deny form
 * the gateway emits — `{$nor: [{region: 'EU'}]}` — MATCHES a missing field, so a
 * record a deny-rule forbids would be handed out by search with its
 * title/subtitle/entity_id. Same document, opposite verdicts, decided by which write
 * path happened to touch it last.
 *
 * Hence: for every entity type, require that the document actually CARRIES the
 * declared ABAC attributes the predicate constrains for that type. A document that
 * never learned the attribute is dropped from the ABAC-narrowed read (fail-closed,
 * unknown ≠ allowed) instead of being judged on data it does not have. The guard is
 * a pure narrowing ANDed after the predicate — it can only ever remove rows.
 *
 * The permanent fix is upstream (producers must ship `ABAC_MATERIALIZED_ATTRS` in
 * `crm.*.created/updated`, TODO-263) or a Reindex; until then this keeps the two
 * paths from disagreeing in the unsafe direction.
 */

/** Attributes of `entityType` that a predicate may legitimately constrain. */
function declaredAttrs(entityType: string): Set<string> {
  const resource = TYPE_TO_ABAC_RESOURCE[entityType];
  if (!resource) return new Set();
  return new Set(
    abacMaterializedAttrs(resource)
      .map((a) => a.field)
      .filter((f) => !RESERVED_INDEX_FIELDS.has(f)),
  );
}

/** Fields a predicate references for ONE entity type, plus "references something
 * this index cannot materialize at all" (→ the type must be dropped). */
interface TypeRefs {
  fields: Set<string>;
  /** A referenced field that is neither an index field nor a declared attribute. */
  unmaterializable: boolean;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Can a document of `entityType` satisfy this `entityType` condition? */
function typeApplies(cond: unknown, entityType: string): boolean {
  if (typeof cond === 'string') return cond === entityType;
  if (!cond || typeof cond !== 'object') return true;
  const ops = cond as Record<string, unknown>;
  if (Array.isArray(ops.$in) && !ops.$in.includes(entityType)) return false;
  if (Array.isArray(ops.$nin) && ops.$nin.includes(entityType)) return false;
  if ('$eq' in ops && ops.$eq !== entityType) return false;
  if ('$ne' in ops && ops.$ne === entityType) return false;
  return true;
}

/**
 * Walk a compiled Mongo predicate collecting the fields it constrains for
 * `entityType`. Returns `false` when the fragment can never apply to that type
 * (its `entityType` guard names another one) — those branches contribute no
 * requirement, which is what keeps the cross-entity predicate
 * `{$or: [{entityType:'contact'}, {$and:[{entityType:'deal'}, <deal abac>]}]}`
 * from demanding the deals attributes of a contact document.
 */
function collectRefs(node: unknown, entityType: string, acc: TypeRefs): boolean {
  if (Array.isArray(node)) return node.every((n) => collectRefs(n, entityType, acc));
  if (!node || typeof node !== 'object') return true;
  const declared = declaredAttrs(entityType);
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$and') {
      for (const child of asArray(val)) if (!collectRefs(child, entityType, acc)) return false;
      continue;
    }
    if (key === '$or' || key === '$nor') {
      // Only branches that can apply to this type contribute requirements; a
      // disjunction with no applicable branch cannot be satisfied at all.
      let applicable = false;
      for (const child of asArray(val)) {
        const probe: TypeRefs = { fields: new Set(), unmaterializable: false };
        if (!collectRefs(child, entityType, probe)) continue;
        applicable = true;
        for (const f of probe.fields) acc.fields.add(f);
        acc.unmaterializable ||= probe.unmaterializable;
      }
      if (key === '$or' && !applicable) return false;
      continue;
    }
    if (key.startsWith('$')) {
      collectRefs(val, entityType, acc);
      continue;
    }
    if (key === 'entityType') {
      if (!typeApplies(val, entityType)) return false;
      continue;
    }
    // Own index fields (title/subtitle/ownerId/…) are written by BOTH paths, so
    // they are always known and need no guard.
    if (RESERVED_INDEX_FIELDS.has(key)) continue;
    if (declared.has(key)) acc.fields.add(key);
    else acc.unmaterializable = true;
  }
  return true;
}

/**
 * Extra AND-clause that keeps an ABAC-narrowed read off documents whose ABAC
 * attributes the index never learned (see the block comment above).
 *
 * `null` when nothing has to be guarded (no predicate, or the predicate only
 * constrains fields every document carries) — the filter is then byte-identical to
 * the pre-guard one. When a type's predicate references a field the index cannot
 * materialize for it, the type is dropped entirely: search cannot honour that rule,
 * and a cross-entity aggregate must show less rather than leak (the same
 * `undecidable ⇒ drop the subject` rule the gateway applies when compiling).
 */
export function abacCompletenessFilter(
  entityTypes: readonly string[],
  predicate?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!predicate || !Object.keys(predicate).length || !entityTypes.length) return null;

  const unguarded: string[] = [];
  const branches: Record<string, unknown>[] = [];
  let guardNeeded = false;
  for (const entityType of entityTypes) {
    const acc: TypeRefs = { fields: new Set(), unmaterializable: false };
    const applies = collectRefs(predicate, entityType, acc);
    if (!applies) {
      // The predicate already excludes the type; no extra clause needed for it.
      unguarded.push(entityType);
      continue;
    }
    if (acc.unmaterializable) {
      guardNeeded = true; // dropped: no branch at all.
      continue;
    }
    if (!acc.fields.size) {
      unguarded.push(entityType);
      continue;
    }
    guardNeeded = true;
    branches.push({
      $and: [
        { entityType },
        ...[...acc.fields].sort().map((f) => ({ [f]: { $exists: true } })),
      ],
    });
  }
  if (!guardNeeded) return null;
  if (unguarded.length) branches.unshift({ entityType: { $in: unguarded } });
  // Every type dropped → match nothing (fail-closed) without an empty `$or`,
  // which Mongo rejects.
  if (!branches.length) return { entityType: { $in: [] } };
  return branches.length === 1 ? branches[0] : { $or: branches };
}
