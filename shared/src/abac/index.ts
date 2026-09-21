/**
 * ABAC engine (K2-abac / E2-03 + E2-04).
 *
 * Storage-neutral predicate IR with three interpreters derived from ONE source of truth:
 *   - evalGate(node, record)      — single-record check (gate; get/update/delete);
 *   - compileMongo(node)          — Mongo filter fragment (CRM list/get/count/aggregate/search);
 *   - compilePostgres(node)       — deferred in v1 (PG subjects = mongo-only, fail-closed reject).
 *
 * Pipeline on the gateway:
 *   parseAbac → validateAbac → resolveContextRefs → normalizeAbac → compileMongo → CompiledPredicate
 * Domains AND `CompiledPredicate.mongo` into `{ projectId } AND (visibility OR sharing)` via
 * `composeAccessFilter`. Source of canon: RFC-5-abac-meta.md, RFC-ABAC-syntax.md.
 *
 * gate ↔ filter equivalence (RFC-ABAC §4): for every record,
 *   evalGate(normalizeAbac(ir), R) ≡ (R ∈ compileMongo(normalizeAbac(ir))).
 */
export * from './ir';
export * from './parse';
export * from './normalize';
export * from './eval-gate';
export * from './compile-mongo';
export * from './materialize';
export * from './compile-postgres';
export * from './partial-eval';
export * from './validate';
export * from './predicate';
export * from './compose';
export * from './owner-short-circuit';
