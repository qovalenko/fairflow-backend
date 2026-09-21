/**
 * ABAC neutral intermediate representation (IR).
 *
 * Canon — RFC-5 §1.1 / RFC-ABAC-syntax §1. A single storage-neutral predicate tree
 * (`AbacNode`) is the one source of truth from which all interpreters are derived:
 *   - `evalGate(node, ctx?, record)`  — single-record check (get/update/delete);
 *   - `compileMongo(node)`            — Mongo filter fragment (CRM domains / list paths);
 *   - `compilePostgres(node)`         — deferred in v1 (PG subjects = `mongo-only`, RFC-ABAC §6).
 *
 * Closed operator set v1 (exactly 10): eq, ne, gt, gte, lt, lte, in, nin, and, or, not.
 * Anything outside the set is rejected at *validation* time (fail-closed, non-договорной №6).
 *
 * Operand namespaces (`ref`): `record.*` (flat field only), `user.*`, `project.*`.
 * `user.*`/`project.*` are resolved to literals on the gateway via `resolveContextRefs`
 * *before* compilation; the BD predicate only ever contains `record.* <op> lit`.
 *
 * CANON (decision Р-2 / X-1, P8): this IR (`parseAbac`/`normalizeAbac`/`evalGate`/
 * `compileMongo`) is canonized as **v1**. The syntax/operator set is FROZEN — do not
 * change it (add operators, namespaces, operand shapes) without a governing RFC.
 */

/** JSON scalar usable as a literal (re-uses the shared definition to avoid duplication). */
import type { JsonPrimitive } from '../module-registry';
export type { JsonPrimitive };

/**
 * Operand: an attribute reference OR a literal. Closed disjunction.
 *  - `ref`: "record.<flat>" | "user.<attr>" | "project.<attr>"
 *  - `lit`: scalar (comparisons) | scalar[] (only for `in`/`nin`).
 */
export type AbacOperand =
  | { ref: string }
  | { lit: JsonPrimitive | JsonPrimitive[] };

export type AbacCompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type AbacSetOp = 'in' | 'nin';
export type AbacLogicOp = 'and' | 'or' | 'not';

/** Closed set of all v1 operators. */
export const ABAC_COMPARE_OPS: readonly AbacCompareOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
export const ABAC_SET_OPS: readonly AbacSetOp[] = ['in', 'nin'];
export const ABAC_LOGIC_OPS: readonly AbacLogicOp[] = ['and', 'or', 'not'];

export type AbacNode =
  | { op: AbacCompareOp; left: AbacOperand; right: AbacOperand }
  | { op: AbacSetOp; left: AbacOperand; right: AbacOperand } // right: {lit: []} in v1; {ref} — v1.1
  | { op: 'and' | 'or'; nodes: AbacNode[] }
  | { op: 'not'; node: AbacNode };

/** Machine-readable validation/compile error codes (RFC-ABAC §9.2). */
export type AbacErrorCode =
  | 'OPERATOR_NOT_SUPPORTED'
  | 'OPERAND_NOT_ALLOWED'
  | 'OPERAND_NESTED_PATH_UNSUPPORTED'
  | 'FIELD_VS_FIELD_UNSUPPORTED'
  | 'TYPE_MISMATCH'
  | 'DATE_OPERAND_UNSUPPORTED'
  | 'NOT_OVER_UNSUPPORTED_LEAF'
  | 'NULL_IN_LITERAL_ARRAY'
  | 'NULL_LITERAL_COMPARE'
  | 'ABAC_BACKEND_UNSUPPORTED'
  | 'NOT_COMPILABLE_MONGO'
  | 'UNKNOWN_CONTEXT_REF'
  | 'MALFORMED_NODE';

/** Thrown by parse/validate/compile. Carries a machine code and JSON-pointer-ish path. */
export class AbacError extends Error {
  readonly code: AbacErrorCode;
  readonly path: string;
  constructor(code: AbacErrorCode, message: string, path = '$') {
    super(`${code}: ${message} (at ${path})`);
    this.name = 'AbacError';
    this.code = code;
    this.path = path;
  }
}

/** Allowed `ref` namespace prefixes (RFC-ABAC §1.2). */
export const ABAC_REF_NAMESPACES = ['record.', 'user.', 'project.'] as const;
export type AbacRefNamespace = 'record' | 'user' | 'project';

/** Flat record field: no dots, no brackets. */
export const RECORD_FLAT_FIELD_RE = /^record\.[A-Za-z_][A-Za-z0-9_]*$/;

/** Type guards / helpers. */
export function isRefOperand(op: AbacOperand): op is { ref: string } {
  return typeof op === 'object' && op !== null && 'ref' in op;
}
export function isLitOperand(op: AbacOperand): op is { lit: JsonPrimitive | JsonPrimitive[] } {
  return typeof op === 'object' && op !== null && 'lit' in op;
}

/** Namespace of a ref ('record' | 'user' | 'project'); throws OPERAND_NOT_ALLOWED otherwise. */
export function refNamespace(ref: string, path = '$'): AbacRefNamespace {
  if (ref.startsWith('record.')) return 'record';
  if (ref.startsWith('user.')) return 'user';
  if (ref.startsWith('project.')) return 'project';
  throw new AbacError('OPERAND_NOT_ALLOWED', `ref namespace not allowed: "${ref}"`, path);
}

/** Suffix of a ref past its namespace (e.g. "record.amount" → "amount"). */
export function refField(ref: string): string {
  const dot = ref.indexOf('.');
  return dot >= 0 ? ref.slice(dot + 1) : ref;
}
