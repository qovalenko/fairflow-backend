/**
 * `compilePostgres` — DEFERRED in v1 (RFC-ABAC §6, RFC-5 §1.3, v1-decisions Решение 1).
 *
 * The list of PG data-subjects with record-level ABAC in v1 is EMPTY (RFC-ABAC §6.1). Every
 * Postgres data-subject is `abacBackend:'mongo-only'`; a `record.*` predicate on any of them is
 * rejected at validation with `ABAC_BACKEND_UNSUPPORTED` (see `validateAbac`). Therefore no IR
 * with `record.*` should ever reach this compiler in v1.
 *
 * The IR is storage-neutral by design (door open for v1.1+ PG+RLS): when a confirmed PG case
 * arrives, implement `compilePostgres(node) → Prisma where` HERE / inside the owning domain
 * (Prisma lives in the domain; the gateway does not carry schemas — OQ-ABAC-7) and wire the
 * PG column of the RFC-5 §1.2 table into the property suite (`evalGate ≡ compilePostgres`).
 *
 * Until then this function fails-closed: it always throws, never returns a permissive filter.
 */
import { AbacError, AbacNode } from './ir';

/**
 * Not implemented in v1. Always throws `ABAC_BACKEND_UNSUPPORTED` (fail-closed).
 * @throws AbacError - always.
 */
export function compilePostgres(_node: AbacNode): never {
  throw new AbacError(
    'ABAC_BACKEND_UNSUPPORTED',
    'compilePostgres is deferred in v1 (RFC-ABAC §6); PG data-subjects are mongo-only',
    '$',
  );
}
