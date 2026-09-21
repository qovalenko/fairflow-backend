/**
 * `compileMongo` — IR → Mongo filter fragment (E2-04, RFC-ABAC §3, RFC-5).
 *
 * Input is the RESIDUAL IR (after `resolveContextRefs`: only `record.* <op> lit`).
 * Output is the ABAC-only fragment a CRM domain AND-s into its base `{ projectId, ... }`
 * read filter (composition itself lives in `compose.ts`/gateway — RFC-ABAC §7.3).
 *
 * `compileMongo` is NOT a superset of `buildVisibilityFilter` (rbac.ts): it only knows
 * `record.* vs lit`, never `owner $in [...]` / `_id $in [shared…]` (RFC-ABAC §3 B2).
 *
 * Null/missing neutralization mirrors the §4 table so that
 *   evalGate(normalizeAbac(ir), R) ≡ (R ∈ compileMongo(normalizeAbac(ir)))
 * holds for every record (value/null/missing × type).
 *
 * `compileMongo = compileNode ∘ normalizeAbac`. `not` is already lowered to `ne`/`nin`
 * by `normalizeAbac`, so this compiler never emits `$nor` over a comparison leaf.
 */
import { AbacError, AbacNode, AbacOperand, JsonPrimitive, refField } from './ir';
import { normalizeAbac } from './normalize';

/** Always-false fragment (`$or:[]` throws natively, so we canonicalize, RFC-ABAC §3.1). */
const FALSE_FRAGMENT: Record<string, unknown> = { $nor: [{}] };
/** Always-true fragment. */
const TRUE_FRAGMENT: Record<string, unknown> = {};

/** The record field name for a comparison leaf; throws if its shape is unexpected. */
function leafField(left: AbacOperand, path: string): string {
  if (!('ref' in left) || !left.ref.startsWith('record.')) {
    throw new AbacError(
      'NOT_COMPILABLE_MONGO',
      'left operand of a leaf must be a resolved record.* ref',
      path,
    );
  }
  return refField(left.ref);
}

/** The literal value of a comparison leaf's right operand. */
function leafLiteral(right: AbacOperand, path: string): JsonPrimitive | JsonPrimitive[] {
  if (!('lit' in right)) {
    // After resolveContextRefs every right operand of a residual node is a literal.
    throw new AbacError(
      'NOT_COMPILABLE_MONGO',
      'right operand of a residual leaf must be a literal (field-vs-field is v1.1)',
      path,
    );
  }
  return right.lit;
}

/** `{ f: { $exists:true } }, { f: { $ne:null } }` guard reused by ne/nin. */
function presentGuards(f: string): Record<string, unknown>[] {
  return [{ [f]: { $exists: true } }, { [f]: { $ne: null } }];
}

function compileLeaf(node: Extract<AbacNode, { left: AbacOperand }>, path: string): Record<string, unknown> {
  const f = leafField(node.left, path);
  const L = leafLiteral(node.right, path);

  switch (node.op) {
    case 'eq':
      // {f:{$eq:L}} does not match missing when L≠null (L=null rejected at validation).
      return { [f]: { $eq: L } };
    case 'ne':
      // null/missing must NOT pass: present guard + $ne (RFC-ABAC §4).
      return { $and: [...presentGuards(f), { [f]: { $ne: L } }] };
    case 'gt':
      return { [f]: { $gt: L } };
    case 'gte':
      return { [f]: { $gte: L } };
    case 'lt':
      return { [f]: { $lt: L } };
    case 'lte':
      return { [f]: { $lte: L } };
    case 'in':
      // L[] without null (enforced at validation) ⇒ Mongo won't match missing — matches oracle.
      return { [f]: { $in: Array.isArray(L) ? L : [L] } };
    case 'nin':
      // symmetric to ne: null/missing must NOT pass.
      return { $and: [...presentGuards(f), { [f]: { $nin: Array.isArray(L) ? L : [L] } }] };
    default:
      throw new AbacError(
        'NOT_COMPILABLE_MONGO',
        `cannot compile operator "${(node as { op: string }).op}"`,
        path,
      );
  }
}

function compileNode(node: AbacNode, path: string): Record<string, unknown> {
  switch (node.op) {
    case 'and': {
      if (node.nodes.length === 0) return { ...TRUE_FRAGMENT };
      return { $and: node.nodes.map((n, i) => compileNode(n, `${path}.nodes[${i}]`)) };
    }
    case 'or': {
      if (node.nodes.length === 0) return { ...FALSE_FRAGMENT };
      return { $or: node.nodes.map((n, i) => compileNode(n, `${path}.nodes[${i}]`)) };
    }
    case 'not':
      // normalizeAbac lowers all `not`; reaching here means an un-normalized tree.
      throw new AbacError(
        'NOT_COMPILABLE_MONGO',
        'not reached compiler un-lowered; call normalizeAbac first',
        path,
      );
    default:
      return compileLeaf(node, path);
  }
}

/**
 * Compile a NORMALIZED residual IR into a Mongo filter fragment.
 * Use `compileMongoRaw` to normalize first.
 */
export function compileMongo(node: AbacNode): Record<string, unknown> {
  return compileNode(node, '$');
}

/** Convenience: normalize then compile (the canonical `compileMongo ∘ normalizeAbac`). */
export function compileMongoRaw(node: AbacNode): Record<string, unknown> {
  return compileNode(normalizeAbac(node), '$');
}
