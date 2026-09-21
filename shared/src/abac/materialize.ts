/**
 * ABAC attribute materialization (E2-05 / I2b, RFC-5 §1.2/§1.3).
 *
 * `compileMongo` emits residual leaves shaped as `{ <flatField>: { $op: L } }`
 * over `record.<flatField>` refs (RFC-5 §1.1 — flat fields only in v1). For those
 * predicates to be **index-backed** (not collection scans) the CRM (Mongo) domain
 * that owns the data-subject must:
 *   1. keep each materialized ABAC attribute as a FLAT, top-level field on the
 *      document (so `record.region` → `{ region: ... }` matches a real path), and
 *   2. carry a compound index `{ projectId: 1, <attr>: 1 }` so the composed
 *      `composeAccessFilter` filter (`{projectId} AND (visibility) AND abac`)
 *      can use the project boundary as the index prefix and the ABAC attribute as
 *      the discriminator.
 *
 * This module is the single declarative source of WHICH flat fields each CRM
 * resource materializes for ABAC, plus a builder for the Mongo index specs the
 * domain creates on startup. It is descriptive only — it stores no data and runs
 * no I/O; the owning domain calls `abacMaterializedIndexSpecs(resource)` from its
 * Mongo bootstrap. Keeping the list here (next to `compileMongo`) keeps the
 * materialized fields and the predicate compiler in lock-step.
 *
 * NB: the projectId prefix is non-negotiable (non-договорной №3) — every ABAC
 * index is project-scoped, never a bare `{ <attr>: 1 }`, so isolation always wins
 * the index prefix and one project's reads never scan another's documents.
 */

/** Scalar type of a materialized ABAC attribute (mirrors the literal types in the IR). */
export type AbacAttrType = 'string' | 'number' | 'boolean' | 'date' | 'id';

/**
 * One materialized ABAC attribute on a CRM document. `field` is the FLAT
 * (top-level, no dots) document path that a `record.<field>` ref resolves to.
 */
export interface AbacMaterializedAttr {
  /** Flat document field (matches `RECORD_FLAT_FIELD_RE` suffix). */
  field: string;
  /** Scalar type — used to keep manifest operand types and literals in sync. */
  type: AbacAttrType;
  /** Human note (why it is materialized / which vision case it serves). */
  note?: string;
}

/** A Mongo compound index spec: `{ projectId: 1, <attr>: 1 }`, plus a stable name. */
export interface MongoIndexSpec {
  key: Record<string, 1 | -1>;
  name: string;
}

/**
 * Canonical materialized ABAC attributes per CRM resource (manifest `resource`).
 *
 * Only flat, top-level fields the predicate compiler can target as `record.<f>`.
 * Ownership / department fields (`ownerId`/`assigneeId`/`departmentId`) are part of
 * the VISIBILITY layer, not ABAC, and are indexed by that layer — they are NOT
 * duplicated here. These are the *attribute* fields ABAC rules filter on
 * ("сделки до миллиона" → `amount`, "свой регион" → `region`, RFC-5 §1.3).
 */
export const ABAC_MATERIALIZED_ATTRS: Readonly<Record<string, readonly AbacMaterializedAttr[]>> = {
  contacts: [
    { field: 'source', type: 'string', note: 'lead source — "только свои источники"' },
    { field: 'tags', type: 'string', note: 'tag membership (in/nin over array)' },
  ],
  companies: [
    { field: 'industry', type: 'string', note: 'industry segment' },
    { field: 'region', type: 'string', note: '"свой регион" (vision)' },
    { field: 'tags', type: 'string' },
  ],
  deals: [
    { field: 'amount', type: 'number', note: '"сделки до миллиона" (vision)' },
    { field: 'status', type: 'string', note: 'open|won|lost' },
    { field: 'stageId', type: 'id' },
    { field: 'pipelineId', type: 'id' },
    { field: 'source', type: 'string' },
    { field: 'probability', type: 'number' },
    { field: 'expectedCloseDate', type: 'date' },
    { field: 'tags', type: 'string' },
  ],
  orders: [
    { field: 'amount', type: 'number' },
    { field: 'status', type: 'string' },
    { field: 'orderTypeId', type: 'id' },
    { field: 'stageId', type: 'id' },
  ],
  activities: [
    { field: 'type', type: 'string' },
    { field: 'status', type: 'string' },
    { field: 'dueAt', type: 'date' },
  ],
  products: [
    { field: 'categoryId', type: 'id' },
    { field: 'status', type: 'string' },
    { field: 'price', type: 'number' },
  ],
} as const;

/** Materialized ABAC attributes declared for `resource` (empty array if none). */
export function abacMaterializedAttrs(resource: string): readonly AbacMaterializedAttr[] {
  return ABAC_MATERIALIZED_ATTRS[resource] ?? [];
}

/** True when `field` is a declared materialized ABAC attribute of `resource`. */
export function isAbacMaterializedField(resource: string, field: string): boolean {
  return abacMaterializedAttrs(resource).some((a) => a.field === field);
}

/**
 * ABAC-attribute snapshot of ONE record for the gate path (E2-05 / I2b, board §3).
 *
 * `evalGate(node, record)` needs only the materialized ABAC attributes of a record,
 * not the whole document. The domain that owns a record projects it to this snapshot
 * (just the declared flat attrs) and the PDP/`evalGate` decides "yes/no" over it,
 * so the ABAC gate stops being `inactive` (closes the K3fe-be PDP-explain debt) —
 * without the gateway ever pulling full CRM docs.
 *
 * 152-ФЗ invariant (FR-ABAC-20): the snapshot carries values for the COMPILER, but
 * explain/trace must print the VERDICT, never the personal-data field values. Use
 * `redactSnapshotForTrace` before logging/returning a snapshot in an explain trace —
 * it keeps the field NAMES (so "why" is explainable) but masks the values.
 */
export type AbacGateSnapshot = Record<string, unknown>;

/**
 * Project a record to its ABAC gate snapshot: ONLY the declared materialized
 * attributes of `resource` (flat fields). Missing fields are simply absent in the
 * snapshot (collapsed to "no field" → never passes a predicate, RFC-5 §1.2).
 * This is the exact, minimal object `evalGate` should receive.
 */
export function buildAbacGateSnapshot(
  resource: string,
  record: Record<string, unknown>,
): AbacGateSnapshot {
  const snapshot: AbacGateSnapshot = {};
  for (const attr of abacMaterializedAttrs(resource)) {
    const v = record[attr.field];
    if (v !== undefined) snapshot[attr.field] = v;
  }
  return snapshot;
}

/**
 * Redact a gate snapshot for an explain trace (152-ФЗ / FR-ABAC-20): keep the
 * attribute NAMES and a coarse presence/type marker, drop the actual values so no
 * personal-data field value lands in a log/trace. The verdict (allow/deny) and the
 * predicate structure remain explainable; the values do not leak.
 */
export function redactSnapshotForTrace(snapshot: AbacGateSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(snapshot)) {
    out[field] = value === null ? 'null' : `<${typeof value}>`;
  }
  return out;
}

/**
 * Project-scoped compound index specs for a resource's materialized ABAC
 * attributes: one `{ projectId: 1, <attr>: 1 }` per attribute.
 *
 * `projectField` defaults to `projectId`; pass the collection's actual project key
 * if it differs. Indexes are sparse: ABAC attributes are frequently absent on a
 * document, and a missing/null field never passes a predicate (RFC-5 §1.2), so
 * indexing only present values keeps the index small without changing semantics.
 */
export function abacMaterializedIndexSpecs(
  resource: string,
  projectField = 'projectId',
): MongoIndexSpec[] {
  return abacMaterializedAttrs(resource).map((a) => ({
    key: { [projectField]: 1, [a.field]: 1 } as Record<string, 1 | -1>,
    name: `abac_${projectField}_${a.field}`,
  }));
}
