import { createHash } from 'node:crypto';

/**
 * Tamper-evident hash chain for the control audit journals (P8 T5.1, decision
 * Р-5). The chain spans the EXISTING `RoleAuditLog` / `OrgAuditLog` tables (we do
 * NOT merge them into a new table). Every appended record stores:
 *   - `prevHash`  — the `chainHash` of the previous record of the same chain
 *                   (null for the genesis record of a chain);
 *   - `chainHash` — sha256(prevHash ?? '' + '\n' + canonicalPayload).
 *
 * A retro-edit of any field of any record changes its recomputed `chainHash`,
 * which no longer matches the `prevHash` stored on the next record — so the
 * forgery is localised on a full-chain recompute ({@link verifyChain} lives in
 * the audit services). The chain is per-scope (see {@link ChainScopeKey}).
 *
 * This contract is LOCAL to control (both writer and verifier live here), so it
 * stays in control and is deliberately NOT lifted into @fairflow/shared.
 */

/**
 * Canonical, order-stable projection of an audit record used as the hashed
 * payload. Key order here is the wire order of the canonical JSON and MUST stay
 * stable across writer and verifier — do not reorder without a chain migration.
 */
export interface AuditChainPayload {
  /** Chain scope discriminator: which column identifies the chain. */
  scopeType: 'role:project' | 'role:org' | 'org';
  /** Chain scope id (projectId | orgId | organizationId). */
  scopeId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  actorUserId: string | null;
  /** ISO-8601 (ms) timestamp of the record's createdAt. */
  createdAt: string;
}

/**
 * Deterministic JSON serialization with recursively sorted object keys so the
 * hashed byte string does not depend on insertion order of `before`/`after`
 * diffs or of the payload object itself. Arrays keep their order (semantic).
 * `undefined` is normalised to `null` so an absent field and an explicit null
 * hash identically (Prisma reads back nulls, never undefined).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortValue(obj[key]);
  }
  return sorted;
}

/**
 * chainHash = sha256( (prevHash ?? '') + '\n' + canonicalJson(payload) ).
 * The '\n' separator keeps the genesis case (prevHash === null → '') distinct
 * from any record whose payload happens to start with the previous hash bytes.
 */
export function computeChainHash(prevHash: string | null, payload: AuditChainPayload): string {
  const material = `${prevHash ?? ''}\n${canonicalJson(payload)}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Build the canonical payload from a stored/being-stored audit record. Used by
 * both the writer (before insert) and the verifier (on recompute) so the two
 * always agree byte-for-byte.
 */
export function buildAuditPayload(record: {
  scopeType: AuditChainPayload['scopeType'];
  scopeId: string;
  action: string;
  entityType: string;
  entityId: string | null | undefined;
  before: unknown;
  after: unknown;
  actorUserId: string | null | undefined;
  createdAt: Date;
}): AuditChainPayload {
  return {
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId ?? null,
    before: record.before ?? null,
    after: record.after ?? null,
    actorUserId: record.actorUserId ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Postgres advisory-lock key for a chain scope. We serialize the chain TAIL with
 * a transaction-scoped advisory lock (`pg_advisory_xact_lock`) rather than
 * `SELECT ... FOR UPDATE` on the last row, because FOR UPDATE cannot lock a
 * not-yet-existing row: two concurrent GENESIS inserts (empty chain) would both
 * see "no tail", read prevHash=null and fork the chain. The advisory lock is
 * keyed by the scope itself and therefore serializes appends even when the chain
 * is empty. The lock is released automatically at commit/rollback (xact-scoped),
 * so it cannot leak. bigint key = signed 64-bit hash of the scope string.
 */
export function chainAdvisoryLockKey(scopeType: string, scopeId: string): bigint {
  const h = createHash('sha256').update(`${scopeType}\u0000${scopeId}`, 'utf8').digest();
  // Take the low 64 bits and interpret as a signed bigint (pg advisory keys are
  // signed int8). readBigInt64BE reads exactly 8 bytes as two's-complement.
  return h.readBigInt64BE(0);
}
