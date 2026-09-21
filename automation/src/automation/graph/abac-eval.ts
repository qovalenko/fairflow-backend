/**
 * Minimal in-domain ABAC evaluator for automation v2 condition/branch nodes.
 *
 * Why in-domain (and not `@fairflow/shared/abac` directly): the shared IR is the
 * canonical closed operator set (eq/ne/gt/gte/lt/lte/in/nin/and/or/not). Workflow
 * condition nodes additionally need `contains`/`is_empty`/`is_not_empty` for the
 * canvas UX (PLAN.md §0). This module is a SUPERSET evaluator whose node SHAPE is
 * byte-compatible with `AbacNode` ({op,left,right} / {op,nodes} / {op,node}), so a
 * predicate accepted here is trivially swappable onto `@fairflow/shared/abac`
 * (`evalGate`) once the extra operators land there — no callsite churn.
 *
 * Semantics mirror the shared `evalGate` (fail-closed, null-safe):
 *   - a missing OR null record field never satisfies a comparison;
 *   - `and([])` ≡ TRUE, `or([])` ≡ FALSE;
 *   - `not` is evaluated structurally (logical negation of its child).
 *
 * Operands reuse the shared `{ref}`/`{lit}` form. `ref` resolves against the
 * record snapshot only ('record.<flat>' | 'trigger.<field>'); a flat key lookup
 * (`refField`) keeps it storage-neutral.
 */

/** Operand: an attribute reference OR a literal (shared `AbacOperand` shape). */
export type AbacEvalOperand =
  | { ref: string }
  | { lit: unknown };

/** Comparison ops (shared subset) + the v2 string/emptiness extensions. */
export type AbacEvalLeafOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty';

/**
 * Predicate node — shape-compatible with `@fairflow/shared/abac` `AbacNode`.
 * `is_empty`/`is_not_empty` are unary leaves: `right` is ignored.
 */
export type AbacEvalNode =
  | { op: AbacEvalLeafOp; left: AbacEvalOperand; right?: AbacEvalOperand }
  | { op: 'and' | 'or'; nodes: AbacEvalNode[] }
  | { op: 'not'; node: AbacEvalNode };

/** Flat field of a ref past its namespace ("record.amount" → "amount"). */
function refField(ref: string): string {
  const dot = ref.indexOf('.');
  return dot >= 0 ? ref.slice(dot + 1) : ref;
}

/** A field is "present" iff it is neither undefined (missing) nor null. */
function resolve(op: AbacEvalOperand | undefined, record: Record<string, unknown>): unknown {
  if (!op || typeof op !== 'object') return null;
  if ('ref' in op) {
    const v = record[refField(op.ref)];
    return v === undefined ? null : v;
  }
  return (op as { lit: unknown }).lit;
}

/** Lexicographic for strings, numeric for numbers; null if not comparable. */
function ordCompare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** True when a value counts as "empty" (missing/null/''/[]/{}). */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function evalLeaf(node: Extract<AbacEvalNode, { left: AbacEvalOperand }>, record: Record<string, unknown>): boolean {
  const lv = resolve(node.left, record);

  // Unary emptiness ops short-circuit before the null-fail-closed gate below.
  if (node.op === 'is_empty') return isEmptyValue(lv);
  if (node.op === 'is_not_empty') return !isEmptyValue(lv);

  const rv = resolve(node.right, record);

  // Fail-closed: the record side being null/missing never satisfies a comparison.
  if (lv === null || lv === undefined) return false;

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
      const arr = Array.isArray(rv) ? rv : [];
      return arr.includes(lv);
    }
    case 'nin': {
      const arr = Array.isArray(rv) ? rv : [];
      return !arr.includes(lv);
    }
    case 'contains': {
      // string⊇substring or array⊇element (right side is the needle literal).
      if (typeof lv === 'string') return lv.includes(String(rv ?? ''));
      if (Array.isArray(lv)) return lv.includes(rv);
      return false;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a predicate against a single record snapshot. Pure & deterministic —
 * the unit-test oracle for v2 condition/branch nodes.
 */
export function evalAbac(node: AbacEvalNode | null | undefined, record: Record<string, unknown>): boolean {
  // A null/empty predicate is "always true" (an empty condition passes — §1.4).
  if (!node || typeof node !== 'object') return true;
  switch (node.op) {
    case 'and':
      return node.nodes.every((n) => evalAbac(n, record));
    case 'or':
      return node.nodes.some((n) => evalAbac(n, record));
    case 'not':
      return !evalAbac(node.node, record);
    default:
      return evalLeaf(node as Extract<AbacEvalNode, { left: AbacEvalOperand }>, record);
  }
}

/** Set of leaf operators this evaluator accepts (used by the validator). */
export const ABAC_EVAL_LEAF_OPS: ReadonlySet<AbacEvalLeafOp> = new Set<AbacEvalLeafOp>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
  'is_empty',
  'is_not_empty',
]);

/**
 * Shallow structural check that a predicate is compilable by this evaluator.
 * Returns the offending message (for CONDITION_NOT_COMPILABLE) or null when ok.
 * `null`/`{}` predicate is treated as the always-true empty condition.
 */
export function validateAbacShape(node: unknown, path = '$'): string | null {
  if (node == null) return null;
  if (typeof node !== 'object' || Array.isArray(node)) {
    return `predicate node must be an object (at ${path})`;
  }
  const op = (node as { op?: unknown }).op;
  if (op === undefined && Object.keys(node as object).length === 0) return null; // empty {} = always true
  if (typeof op !== 'string') return `node.op must be a string (at ${path}.op)`;

  if (op === 'and' || op === 'or') {
    const nodes = (node as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return `"${op}" requires nodes[] (at ${path}.nodes)`;
    for (let i = 0; i < nodes.length; i++) {
      const err = validateAbacShape(nodes[i], `${path}.nodes[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (op === 'not') {
    if (!('node' in (node as object))) return `"not" requires {node} (at ${path}.node)`;
    return validateAbacShape((node as { node: unknown }).node, `${path}.node`);
  }
  if (!ABAC_EVAL_LEAF_OPS.has(op as AbacEvalLeafOp)) {
    return `operator not supported: "${op}" (at ${path}.op)`;
  }
  const leaf = node as { left?: unknown; right?: unknown };
  if (!isOperandShape(leaf.left)) return `"${op}" requires a {ref|lit} left operand (at ${path}.left)`;
  if (op !== 'is_empty' && op !== 'is_not_empty') {
    if (!isOperandShape(leaf.right)) return `"${op}" requires a {ref|lit} right operand (at ${path}.right)`;
  }
  return null;
}

function isOperandShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const hasRef = 'ref' in v;
  const hasLit = 'lit' in v;
  return hasRef !== hasLit; // exactly one of ref|lit
}
