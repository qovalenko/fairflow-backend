/**
 * Semantic validation of an ABAC rule against the operand catalog (RFC-ABAC §5).
 *
 * Runs AFTER `parseAbac` (pure syntax). Compile-time, fail-closed, NOT runtime: a rule that
 * cannot be compiled is rejected when the policy is saved, never silently in a read path
 * (non-договорной №6). Pipeline (RFC-ABAC §5.2):
 *   1. catalog: every `record.<f>` in subject operands; user./project. refs in platform catalog;
 *   2. type-check: literal type = descriptor.type; date operands rejected (v1);
 *      gt/gte/lt/lte forbidden on boolean/id; op ∈ descriptor.allowedOperators;
 *   3. null literals: NULL_IN_LITERAL_ARRAY / NULL_LITERAL_COMPARE;
 *   4. backend: mongo-only/postgres subject + record.* condition → ABAC_BACKEND_UNSUPPORTED;
 *   5. compilability: trial `compileMongo(normalizeAbac(node))` → NOT_COMPILABLE_MONGO on throw.
 *
 * `not`-leaf restriction (only over eq/in) is enforced by `normalizeAbac`
 * (NOT_OVER_UNSUPPORTED_LEAF), surfaced here as a validation error too.
 */
import {
  AbacCompareOp,
  AbacError,
  AbacErrorCode,
  AbacNode,
  AbacOperand,
  AbacSetOp,
  JsonPrimitive,
  refField,
  refNamespace,
} from './ir';
import { compileMongo } from './compile-mongo';
import { normalizeAbac } from './normalize';

export type AbacOperandType = 'string' | 'number' | 'boolean' | 'date' | 'id';

/** Operand descriptor — whitelist of `record.*` fields of a subject (RFC-ABAC §5.1). */
export interface AbacOperandDescriptor {
  path: string; // 'record.amount' | 'record.region'
  type: AbacOperandType;
  allowedOperators: (AbacCompareOp | AbacSetOp)[];
  enumValues?: JsonPrimitive[];
}

/** Subject ABAC capability (manifest extension, RFC-ABAC §5.1). */
export interface AbacBackendInfo {
  backend: 'mongo' | 'postgres' | 'mongo-only';
}

export interface AbacValidationContext {
  /** record.* operand whitelist for the rule's subject. */
  operands: AbacOperandDescriptor[];
  /** Backend of the subject (RFC-ABAC §6). default 'mongo'. */
  abacBackend?: 'mongo' | 'postgres' | 'mongo-only';
}

/** Fixed platform catalog for user.* / project.* refs (RFC-ABAC §1.2). */
const PLATFORM_OPERANDS: Record<string, AbacOperandType> = {
  'user.id': 'id',
  'user.departmentId': 'id',
  'user.departmentChain': 'id',
  'user.leaderOfDepartmentIds': 'id',
  'user.role': 'string',
  'project.id': 'id',
  'project.ownerType': 'string',
  'project.ownerId': 'id',
};

const ORDERED_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

function litType(v: JsonPrimitive): AbacOperandType | 'null' {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string'; // string covers string/id/date (compared by descriptor)
}

/** True if a literal of JS type `t` is assignable to a descriptor of `type`. */
function literalMatchesType(v: JsonPrimitive, type: AbacOperandType): boolean {
  const lt = litType(v);
  if (lt === 'null') return false;
  if (type === 'number') return lt === 'number';
  if (type === 'boolean') return lt === 'boolean';
  // string/id/date are all carried as JSON string literals
  return lt === 'string';
}

function descriptorFor(
  ref: string,
  ctx: AbacValidationContext,
  path: string,
): { type: AbacOperandType; allowedOperators?: (AbacCompareOp | AbacSetOp)[] } {
  const ns = refNamespace(ref, path);
  if (ns === 'record') {
    const d = ctx.operands.find((o) => o.path === ref);
    if (!d) {
      throw new AbacError('OPERAND_NOT_ALLOWED', `record field not in subject catalog: "${ref}"`, path);
    }
    return { type: d.type, allowedOperators: d.allowedOperators };
  }
  // user.*/project.*
  const t = PLATFORM_OPERANDS[ref];
  if (!t) {
    throw new AbacError('OPERAND_NOT_ALLOWED', `unknown platform operand: "${ref}"`, path);
  }
  return { type: t };
}

function validateLeaf(
  node: Extract<AbacNode, { left: AbacOperand }>,
  ctx: AbacValidationContext,
  path: string,
): void {
  // left must be a ref (record.* or context); right is the comparison value.
  if (!('ref' in node.left)) {
    throw new AbacError('OPERAND_NOT_ALLOWED', 'left operand must be a ref', `${path}.left`);
  }
  const left = descriptorFor(node.left.ref, ctx, `${path}.left`);

  // date operands forbidden in v1 (RFC-ABAC §1.2/§5.2 step 3).
  if (left.type === 'date') {
    throw new AbacError('DATE_OPERAND_UNSUPPORTED', `date operand not supported in v1: "${node.left.ref}"`, `${path}.left`);
  }

  // per-field allowedOperators (record.* only).
  if (left.allowedOperators && !left.allowedOperators.includes(node.op as AbacCompareOp | AbacSetOp)) {
    throw new AbacError(
      'OPERATOR_NOT_SUPPORTED',
      `operator "${node.op}" not allowed on "${node.left.ref}"`,
      `${path}.op`,
    );
  }

  // ordered ops forbidden on boolean/id.
  if (ORDERED_OPS.has(node.op) && (left.type === 'boolean' || left.type === 'id')) {
    throw new AbacError('TYPE_MISMATCH', `"${node.op}" not allowed on ${left.type}`, `${path}.op`);
  }

  // right operand type checks.
  if (node.op === 'in' || node.op === 'nin') {
    if (!('lit' in node.right) || !Array.isArray(node.right.lit)) {
      throw new AbacError('FIELD_VS_FIELD_UNSUPPORTED', `"${node.op}" requires a literal array`, `${path}.right`);
    }
    node.right.lit.forEach((el, i) => {
      if (el === null) {
        throw new AbacError('NULL_IN_LITERAL_ARRAY', 'null not allowed in lit array', `${path}.right[${i}]`);
      }
      if (!literalMatchesType(el, left.type)) {
        throw new AbacError('TYPE_MISMATCH', `array element type ≠ ${left.type}`, `${path}.right[${i}]`);
      }
    });
    return;
  }

  // scalar comparison.
  if (!('lit' in node.right)) {
    throw new AbacError('FIELD_VS_FIELD_UNSUPPORTED', 'field-vs-field comparison is v1.1', `${path}.right`);
  }
  const r = node.right.lit;
  if (Array.isArray(r)) {
    throw new AbacError('TYPE_MISMATCH', 'array literal only valid for in/nin', `${path}.right`);
  }
  if (r === null) {
    // no `isNull` operator in v1; reject null compare.
    throw new AbacError('NULL_LITERAL_COMPARE', 'null literal compare not supported in v1', `${path}.right`);
  }
  if (!literalMatchesType(r, left.type)) {
    throw new AbacError('TYPE_MISMATCH', `literal type ≠ ${left.type}`, `${path}.right`);
  }
}

function validateNode(node: AbacNode, ctx: AbacValidationContext, path: string): void {
  switch (node.op) {
    case 'and':
    case 'or':
      node.nodes.forEach((n, i) => validateNode(n, ctx, `${path}.nodes[${i}]`));
      return;
    case 'not':
      // not(eq|in) only; not(and/or/not) is De-Morganed by normalize. Validate by lowering:
      // a not over an unsupported leaf surfaces as NOT_OVER_UNSUPPORTED_LEAF during normalize.
      validateNode(node.node, ctx, `${path}.node`);
      return;
    default:
      validateLeaf(node, ctx, path);
  }
}

/** True if a tree references any `record.*` operand. */
export function referencesRecord(node: AbacNode): boolean {
  switch (node.op) {
    case 'and':
    case 'or':
      return node.nodes.some(referencesRecord);
    case 'not':
      return referencesRecord(node.node);
    default:
      return (
        ('ref' in node.left && node.left.ref.startsWith('record.')) ||
        ('ref' in node.right && node.right.ref.startsWith('record.'))
      );
  }
}

/**
 * Validate a parsed `AbacNode` against the subject operand catalog. Throws `AbacError` on the
 * first violation. Backend gating: a `record.*` condition on a `mongo-only`/`postgres` subject
 * is rejected with `ABAC_BACKEND_UNSUPPORTED` (compilePostgres deferred in v1, RFC-ABAC §6).
 */
export function validateAbac(node: AbacNode, ctx: AbacValidationContext): void {
  // 1-3. catalog/type/null checks.
  validateNode(node, ctx, '$');

  // 4. backend allowance (RFC-ABAC §6 / §5.2 step 6).
  const backend = ctx.abacBackend ?? 'mongo';
  if (backend !== 'mongo' && referencesRecord(node)) {
    throw new AbacError(
      'ABAC_BACKEND_UNSUPPORTED',
      `record-level ABAC not supported on backend "${backend}" in v1`,
      '$',
    );
  }

  // 5. compilability (normalize lowers `not` → NOT_OVER_UNSUPPORTED_LEAF; compile → mongo).
  try {
    const normalized = normalizeAbac(node);
    compileMongo(normalized);
  } catch (e) {
    if (e instanceof AbacError) {
      // surface the precise code (NOT_OVER_UNSUPPORTED_LEAF, NOT_COMPILABLE_MONGO, …).
      throw e;
    }
    throw new AbacError('NOT_COMPILABLE_MONGO', String((e as Error)?.message ?? e), '$');
  }
}

/** Accumulating variant: returns all reason codes instead of throwing on the first. */
export function collectAbacErrors(node: AbacNode, ctx: AbacValidationContext): AbacErrorCode[] {
  const reasons: AbacErrorCode[] = [];
  try {
    validateAbac(node, ctx);
  } catch (e) {
    if (e instanceof AbacError) reasons.push(e.code);
    else reasons.push('NOT_COMPILABLE_MONGO');
  }
  return reasons;
}
