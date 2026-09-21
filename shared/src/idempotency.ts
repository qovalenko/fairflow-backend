/**
 * Mutation-level idempotency ledger (P2.d) — dedup of create/merge/import so a
 * client retry with the same `Idempotency-Key` header never applies the mutation
 * twice. This complements the transport-level outbox dedup (RFC-4 §Р-4, which
 * only deduplicates emitted *events*): here we deduplicate the *mutation itself*.
 *
 * Storage-agnostic by design (mirrors {@link ./outbox}): the core algorithm runs
 * against a minimal {@link IdempotencyCollection} shape that MongoDB's
 * `Collection<IdempotencyRecord>` satisfies structurally, so each CRM domain wires
 * its own per-domain `idempotency_keys` collection while the logic — and its unit
 * tests — live here once.
 *
 * Contract of {@link withIdempotency}:
 *  - no key           → run the executor (no dedup, AS-IS behaviour);
 *  - first key        → claim `{projectId, key}` (unique), run the executor, then
 *                       persist the *full* result → the response is byte-identical
 *                       on replay (works for create AND merge/import shapes);
 *  - duplicate key    → the mutation already ran (or is running): return the
 *                       stored result; if a concurrent request still holds a
 *                       `pending` claim, wait (3×100 ms) for it to finish, else
 *                       fail `FAILED_PRECONDITION` ("уже обрабатывается");
 *  - executor throws  → release the claim so a genuine retry can re-attempt (we
 *                       persist successes only — a failed mutation is not dedup'd).
 *
 * The `key` is scoped by operation (`create:<hdr>`, `merge:<hdr>`, …) so one HTTP
 * `Idempotency-Key` can never collapse two different operations onto one row.
 */

import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';

/** MongoDB duplicate-key error code (a unique-index violation). */
const MONGO_DUPLICATE_KEY = 11000;

/** Lifecycle of a ledger row. */
export type IdempotencyStatus = 'pending' | 'done';

/** One row of the per-domain `idempotency_keys` ledger. */
export interface IdempotencyRecord {
  projectId: string;
  /** Operation-scoped key: `${operation}:${rawKey}`. Unique with `projectId`. */
  key: string;
  operation: string;
  status: IdempotencyStatus;
  /** Full first-run response, replayed verbatim on a duplicate (successes only). */
  result?: unknown;
  /** Best-effort primary id of the created/merged record (observability only). */
  recordId?: string;
  createdAt: Date;
  completedAt?: Date;
}

/**
 * Minimal subset of `mongodb.Collection<IdempotencyRecord>` used by
 * {@link withIdempotency}. The real driver Collection is structurally assignable,
 * so domains pass `mongo.idempotencyKeys()` directly; tests pass an in-memory fake.
 */
export interface IdempotencyCollection {
  insertOne(doc: IdempotencyRecord): Promise<unknown>;
  findOne(filter: { projectId: string; key: string }): Promise<IdempotencyRecord | null>;
  updateOne(
    filter: { projectId: string; key: string },
    update: { $set: Partial<IdempotencyRecord> },
  ): Promise<unknown>;
  deleteOne(filter: { projectId: string; key: string }): Promise<unknown>;
}

/** True when `err` is a MongoDB unique-index violation (code 11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === MONGO_DUPLICATE_KEY;
}

export interface WithIdempotencyParams<T> {
  projectId: string;
  /** Raw `Idempotency-Key` header (empty/undefined → no dedup). */
  key: string | undefined;
  /** Operation namespace, e.g. `create` / `merge` / `import`. */
  operation: string;
  /** Optional extractor of a stable record id from the result (default: `.id`). */
  extractRecordId?: (result: T) => string | undefined;
  /** Wait budget for a concurrent in-flight claim to complete (default 3×100 ms). */
  waitAttempts?: number;
  waitDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRecordId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/**
 * Run `executor` at-most-once per `{projectId, operation, key}`. See the module
 * doc for the full contract. Returns the executor result on the first call and
 * the persisted result (identical shape) on every duplicate.
 */
export async function withIdempotency<T>(
  collection: IdempotencyCollection,
  params: WithIdempotencyParams<T>,
  executor: () => Promise<T>,
): Promise<T> {
  const rawKey = (params.key ?? '').trim();
  if (!rawKey) return executor();

  const projectId = params.projectId;
  const scopedKey = `${params.operation}:${rawKey}`;
  const waitAttempts = params.waitAttempts ?? 3;
  const waitDelayMs = params.waitDelayMs ?? 100;

  // 1. Try to claim the key. A unique {projectId, key} index makes this the
  //    single atomic "who runs the mutation" decision.
  try {
    await collection.insertOne({
      projectId,
      key: scopedKey,
      operation: params.operation,
      status: 'pending',
      createdAt: new Date(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return awaitExistingResult<T>(collection, projectId, scopedKey, waitAttempts, waitDelayMs);
    }
    throw err;
  }

  // 2. We own the claim — run the mutation exactly once.
  try {
    const result = await executor();
    const recordId = params.extractRecordId
      ? params.extractRecordId(result)
      : defaultRecordId(result);
    await collection.updateOne(
      { projectId, key: scopedKey },
      { $set: { status: 'done', result, recordId, completedAt: new Date() } },
    );
    return result;
  } catch (err) {
    // Persist successes only: release the claim so a real retry can re-attempt.
    await collection.deleteOne({ projectId, key: scopedKey }).catch(() => undefined);
    throw err;
  }
}

/** A duplicate hit the claim — return the first run's result (waiting if in-flight). */
async function awaitExistingResult<T>(
  collection: IdempotencyCollection,
  projectId: string,
  scopedKey: string,
  waitAttempts: number,
  waitDelayMs: number,
): Promise<T> {
  for (let attempt = 0; attempt <= waitAttempts; attempt++) {
    const row = await collection.findOne({ projectId, key: scopedKey });
    // The claim was released (executor failed) — surface as "retry", not a
    // silent re-execution (the concurrent request owns the retry).
    if (!row) break;
    if (row.status === 'done') return row.result as T;
    if (attempt < waitAttempts) await sleep(waitDelayMs);
  }
  throw new RpcException({
    code: status.FAILED_PRECONDITION,
    message: 'Запрос с этим Idempotency-Key уже обрабатывается, повторите позже',
  });
}
