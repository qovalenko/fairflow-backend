/**
 * Partial evaluation on the gateway (RFC-ABAC §2, OPA partial-eval idea).
 *
 * `user.*`/`project.*` are known at request time (gateway has role, scope, org structure).
 * They are substituted as literals BEFORE compilation; only `record.* <op> lit` reaches the
 * BD predicate. Invariant after `resolveContextRefs`: no `ref` with prefix `user.`/`project.`
 * remains in the tree (RFC-ABAC §2.1, Criterion 2). Unknown context refs → fail-closed reject.
 */
import { AbacError, AbacNode, AbacOperand, JsonPrimitive, refField, refNamespace } from './ir';

/** Fixed platform catalogs of resolvable context attributes (RFC-ABAC §1.2). */
export interface AbacEvalContext {
  user: {
    id: string;
    departmentId: string | null;
    departmentChain: string[];
    leaderOfDepartmentIds: string[];
    role: string;
  };
  project: {
    id: string;
    ownerType: string;
    ownerId: string;
  };
}

type CtxValue = JsonPrimitive | JsonPrimitive[];

function resolveUserAttr(ctx: AbacEvalContext, attr: string): CtxValue {
  switch (attr) {
    case 'id':
      return ctx.user.id;
    case 'departmentId':
      return ctx.user.departmentId;
    case 'departmentChain':
      return ctx.user.departmentChain;
    case 'leaderOfDepartmentIds':
      return ctx.user.leaderOfDepartmentIds;
    case 'role':
      return ctx.user.role;
    default:
      throw new AbacError('UNKNOWN_CONTEXT_REF', `unknown user attribute: "${attr}"`);
  }
}

function resolveProjectAttr(ctx: AbacEvalContext, attr: string): CtxValue {
  switch (attr) {
    case 'id':
      return ctx.project.id;
    case 'ownerType':
      return ctx.project.ownerType;
    case 'ownerId':
      return ctx.project.ownerId;
    default:
      throw new AbacError('UNKNOWN_CONTEXT_REF', `unknown project attribute: "${attr}"`);
  }
}

function resolveOperand(op: AbacOperand, ctx: AbacEvalContext): AbacOperand {
  if (!('ref' in op)) return op;
  const ns = refNamespace(op.ref);
  if (ns === 'record') return op; // left intact for compileMongo/evalGate
  const attr = refField(op.ref);
  const value = ns === 'user' ? resolveUserAttr(ctx, attr) : resolveProjectAttr(ctx, attr);
  return { lit: value };
}

/**
 * Replace every `user.*`/`project.*` ref by its literal value; `record.*` is untouched.
 * After this the tree only contains `record.*` refs and literals.
 */
export function resolveContextRefs(node: AbacNode, ctx: AbacEvalContext): AbacNode {
  switch (node.op) {
    case 'and':
    case 'or':
      return { op: node.op, nodes: node.nodes.map((n) => resolveContextRefs(n, ctx)) };
    case 'not':
      return { op: 'not', node: resolveContextRefs(node.node, ctx) };
    default:
      return {
        op: node.op,
        left: resolveOperand(node.left, ctx),
        right: resolveOperand(node.right, ctx),
      } as AbacNode;
  }
}
