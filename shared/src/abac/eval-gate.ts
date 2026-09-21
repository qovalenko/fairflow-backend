/**
 * `evalGate` — single-record ABAC interpreter (E2-03, RFC-ABAC §8, RFC-5).
 *
 * Storage-neutral: takes a plain record object (Mongo doc, Prisma row, projection — any
 * `Record<string, unknown>`) and a NORMALIZED `AbacNode`, returns boolean. This is the
 * `gate` side of `gate(U,A,R) := R ∈ filter(U,A)` (FR-ABAC-8) and the property-test
 * oracle for `compileMongo` (`evalGate ≡ compileMongo`, RFC-ABAC §4/§9.1).
 *
 * Semantics column of the normative table (RFC-ABAC §4), null-safe & fail-closed:
 *   - missing AND null fields are treated identically → comparisons yield `false`
 *     ("no field" never passes a predicate; FR-ABAC-5);
 *   - `and([])` ≡ TRUE, `or([])` ≡ FALSE;
 *   - `not` has already been lowered to `ne`/`nin` by `normalizeAbac`.
 *
 * The input MUST be normalized first (`evalGate(normalizeAbac(ir), record)`); the helper
 * `evalGateRaw` does it for you.
 */
import { AbacError, AbacNode, AbacOperand, JsonPrimitive, refField } from './ir';
import { normalizeAbac } from './normalize';

/** A record field is "present" iff it is neither undefined (missing) nor null. */
function fieldValue(record: Record<string, unknown>, field: string): unknown {
  const v = record[field];
  return v === undefined ? null : v; // collapse missing → null (treated identically, §4)
}

/** Resolve a comparison operand to its concrete value against the record.
 *  After normalization + context-resolve, `left` is always a `record.*` ref and
 *  `right` is always a literal. We stay defensive for both shapes. */
function resolveValue(op: AbacOperand, record: Record<string, unknown>): unknown {
  if ('ref' in op) {
    if (!op.ref.startsWith('record.')) {
      // user.*/project.* must have been resolved on the gateway (RFC-ABAC §2).
      throw new AbacError('UNKNOWN_CONTEXT_REF', `unresolved ref reached evalGate: "${op.ref}"`);
    }
    return fieldValue(record, refField(op.ref));
  }
  return op.lit;
}

/** Lexicographic for strings, numeric for numbers (RFC-ABAC §4). Returns null if not comparable. */
function ordCompare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function evalLeaf(node: Extract<AbacNode, { left: AbacOperand }>, record: Record<string, unknown>): boolean {
  const lv = resolveValue(node.left, record);
  const rv = resolveValue(node.right, record);

  // Base invariant: null/missing on the record side → predicate false (fail-closed).
  // `left` is the record field after partial-eval; if it is null → false on every op.
  const recVal = 'ref' in node.left ? lv : rv; // record side
  if (recVal === null || recVal === undefined) return false;

  switch (node.op) {
    case 'eq':
      return lv === rv;
    case 'ne':
      return lv !== rv;
    case 'gt': {
      const c = ordCompare(lv, rv);
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = ordCompare(lv, rv);
      return c !== null && c >= 0;
    }
    case 'lt': {
      const c = ordCompare(lv, rv);
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = ordCompare(lv, rv);
      return c !== null && c <= 0;
    }
    case 'in': {
      const arr = Array.isArray(rv) ? (rv as JsonPrimitive[]) : [];
      return arr.includes(recVal as JsonPrimitive);
    }
    case 'nin': {
      const arr = Array.isArray(rv) ? (rv as JsonPrimitive[]) : [];
      return !arr.includes(recVal as JsonPrimitive);
    }
    default:
      return false;
  }
}

function evalNode(node: AbacNode, record: Record<string, unknown>): boolean {
  switch (node.op) {
    case 'and':
      // empty and ≡ TRUE
      return node.nodes.every((n) => evalNode(n, record));
    case 'or':
      // empty or ≡ FALSE
      return node.nodes.some((n) => evalNode(n, record));
    case 'not':
      // should have been lowered; defensive only
      return !evalNode(node.node, record);
    default:
      return evalLeaf(node, record);
  }
}

/**
 * Evaluate a NORMALIZED IR against a single record. Fail-closed by construction.
 * Use `evalGateRaw` if your IR is not normalized yet.
 */
export function evalGate(node: AbacNode, record: Record<string, unknown>): boolean {
  return evalNode(node, record);
}

/** Convenience: normalize then evaluate. */
export function evalGateRaw(node: AbacNode, record: Record<string, unknown>): boolean {
  return evalNode(normalizeAbac(node), record);
}
