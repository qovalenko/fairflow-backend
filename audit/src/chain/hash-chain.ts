import { createHash } from 'node:crypto';

/**
 * Append-only, tamper-evident hash-chain primitives for the immutable audit log
 * (E3-03, RFC-ACCESS-GROUPS R8 / M8.2; event-audit/TZ §5.6, FR-EVT-19/20).
 *
 * A chain is a per-scope sequence of records. Each record carries:
 *  - `seq`      — monotonic position in the chain (1-based; genesis = 1);
 *  - `prevHash` — `hash` of the previous record (genesis = GENESIS_HASH);
 *  - `hash`     — `sha256(prevHash + canonicalContent)`.
 *
 * Because every record's hash depends on the previous record's hash, a single
 * altered/inserted/deleted record breaks the chain from that point on, which
 * {@link verifyChain} detects. This is what makes the log *provably* immutable
 * (mutable journals are insufficient for R6/B3 escalation forensics — R8).
 *
 * Pure & deterministic on purpose — fully unit-testable without Mongo/RabbitMQ.
 */

/** prevHash of the very first (genesis) record in any chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical, stable serialization of the chained content. Object keys are sorted
 * recursively so that the same logical content always yields the same bytes
 * (and therefore the same hash) regardless of key insertion order. Without this
 * the chain would be non-reproducible and verification would false-positive.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortKeys(src[key]);
    }
    return out;
  }
  return value;
}

/**
 * The immutable, hashed content of a single chain record. Only these fields take
 * part in the hash — transient/derived fields (e.g. `_id`) must NOT be included,
 * otherwise the chain cannot be re-verified from stored data.
 */
export interface ChainContent {
  /** Hash-chain scope: `{org}|{project}` (org-level) or `record|{project}` (record-level). */
  chainKey: string;
  /** 1-based position within the chain. */
  seq: number;
  /** Event/action name, e.g. `control.role.changed`. */
  action: string;
  /** `<entityType>/<entityId>` or subject identifier. */
  subject?: string;
  actorId?: string;
  actorType?: string;
  projectId?: string;
  organizationId?: string;
  /** Idempotency key of the source event (transport dedup carrier). */
  idempotencyKey?: string;
  /** Event production time (epoch ms). */
  createdAt: number;
  /** Domain-specific before/after / patch payload that must be tamper-evident. */
  data?: unknown;
}

/**
 * Compute the hash of a record given the previous record's hash. The previous
 * hash is folded into the canonical content so that re-ordering/insertion is
 * detectable, not only field tampering.
 */
export function computeHash(prevHash: string, content: ChainContent): string {
  const material = canonicalize({ prevHash, content });
  return createHash('sha256').update(material).digest('hex');
}

/** A fully linked chain record (content + chain linkage). */
export interface ChainRecord extends ChainContent {
  prevHash: string;
  hash: string;
}

/**
 * Link a new content item onto the tail of a chain. Returns the record ready for
 * persistence. Caller is responsible for the (chainKey, seq) uniqueness invariant
 * that enforces append-only ordering at the storage layer.
 */
export function linkRecord(prevHash: string, content: ChainContent): ChainRecord {
  const hash = computeHash(prevHash, content);
  return { ...content, prevHash, hash };
}

export interface ChainBreak {
  seq: number;
  expectedHash: string;
  actualHash: string;
  reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'seq_gap';
}

export interface VerifyResult {
  status: 'ok' | 'broken';
  checked: number;
  brokenAt?: ChainBreak;
}

/**
 * Verify an ordered slice of chain records (ascending `seq`). Detects:
 *  - recomputed `hash` mismatch (a record's content was altered);
 *  - `prevHash` not matching the previous record's `hash` (insertion/deletion/reorder);
 *  - `seq` gaps (a record was removed).
 *
 * Empty chain → `ok` (edge case, TZ §11 — verify-chain).
 */
export function verifyChain(records: readonly ChainRecord[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const rec of records) {
    if (rec.seq !== expectedSeq) {
      return {
        status: 'broken',
        checked: expectedSeq - 1,
        brokenAt: { seq: rec.seq, expectedHash: String(expectedSeq), actualHash: String(rec.seq), reason: 'seq_gap' },
      };
    }
    if (rec.prevHash !== prevHash) {
      return {
        status: 'broken',
        checked: expectedSeq - 1,
        brokenAt: { seq: rec.seq, expectedHash: prevHash, actualHash: rec.prevHash, reason: 'prev_hash_mismatch' },
      };
    }
    const { prevHash: _p, hash: _h, ...content } = rec;
    const recomputed = computeHash(prevHash, content as ChainContent);
    if (recomputed !== rec.hash) {
      return {
        status: 'broken',
        checked: expectedSeq - 1,
        brokenAt: { seq: rec.seq, expectedHash: recomputed, actualHash: rec.hash, reason: 'hash_mismatch' },
      };
    }
    prevHash = rec.hash;
    expectedSeq += 1;
  }
  return { status: 'ok', checked: records.length };
}
