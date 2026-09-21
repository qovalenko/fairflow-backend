/**
 * Pure-syntactic ABAC parser (RFC-ABAC §1.3).
 *
 * Validates structure + closedness of operators/namespaces/operand form ONLY.
 * Semantic checks (operand catalog, types, compilability, backend, lockout) live in
 * `validate.ts` (RFC-ABAC §5) and run AFTER parse.
 *
 * Whitelist by construction: a `switch` over the string `op` with `default: reject`.
 * Anything not explicitly accepted is rejected — never "everything not forbidden".
 */
import {
  AbacError,
  AbacNode,
  AbacOperand,
  JsonPrimitive,
  RECORD_FLAT_FIELD_RE,
  refNamespace,
} from './ir';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJsonPrimitive(v: unknown): v is JsonPrimitive {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Parse a single operand: `{ref}` or `{lit}` (closed). */
function parseOperand(raw: unknown, path: string): AbacOperand {
  if (!isPlainObject(raw)) {
    throw new AbacError('MALFORMED_NODE', 'operand must be an object {ref}|{lit}', path);
  }
  const hasRef = 'ref' in raw;
  const hasLit = 'lit' in raw;
  if (hasRef === hasLit) {
    throw new AbacError('MALFORMED_NODE', 'operand must have exactly one of {ref}|{lit}', path);
  }
  if (hasRef) {
    const ref = raw.ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new AbacError('MALFORMED_NODE', 'ref must be a non-empty string', `${path}.ref`);
    }
    const ns = refNamespace(ref, `${path}.ref`);
    if (ns === 'record' && !RECORD_FLAT_FIELD_RE.test(ref)) {
      // distinguish nested path from other malformations for a precise code
      if (ref.includes('[') || ref.split('.').length > 2) {
        throw new AbacError(
          'OPERAND_NESTED_PATH_UNSUPPORTED',
          `nested record path not supported in v1: "${ref}"`,
          `${path}.ref`,
        );
      }
      throw new AbacError('OPERAND_NOT_ALLOWED', `malformed record field: "${ref}"`, `${path}.ref`);
    }
    return { ref };
  }
  // lit
  const lit = raw.lit;
  if (Array.isArray(lit)) {
    for (let i = 0; i < lit.length; i++) {
      if (!isJsonPrimitive(lit[i])) {
        throw new AbacError('MALFORMED_NODE', 'lit array elements must be scalars', `${path}.lit[${i}]`);
      }
    }
    return { lit: lit as JsonPrimitive[] };
  }
  if (!isJsonPrimitive(lit)) {
    throw new AbacError('MALFORMED_NODE', 'lit must be a scalar or scalar[]', `${path}.lit`);
  }
  return { lit };
}

function parseCompareOrSet(op: string, raw: Record<string, unknown>, path: string): AbacNode {
  if (!('left' in raw) || !('right' in raw)) {
    throw new AbacError('MALFORMED_NODE', `"${op}" requires {left,right}`, path);
  }
  const left = parseOperand(raw.left, `${path}.left`);
  const right = parseOperand(raw.right, `${path}.right`);

  if (op === 'in' || op === 'nin') {
    // v1: right MUST be a literal array; field-vs-field is v1.1.
    if ('ref' in right) {
      throw new AbacError('FIELD_VS_FIELD_UNSUPPORTED', `"${op}" field-vs-field is v1.1`, `${path}.right`);
    }
    if (!Array.isArray(right.lit)) {
      throw new AbacError('MALFORMED_NODE', `"${op}" right operand must be a lit array`, `${path}.right`);
    }
    return { op: op as 'in' | 'nin', left, right };
  }
  return { op: op as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', left, right };
}

function parseNode(raw: unknown, path: string): AbacNode {
  if (!isPlainObject(raw)) {
    throw new AbacError('MALFORMED_NODE', 'node must be an object', path);
  }
  const op = raw.op;
  if (typeof op !== 'string') {
    throw new AbacError('MALFORMED_NODE', 'node.op must be a string', `${path}.op`);
  }
  switch (op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'in':
    case 'nin':
      return parseCompareOrSet(op, raw, path);
    case 'and':
    case 'or': {
      const nodes = raw.nodes;
      if (!Array.isArray(nodes)) {
        throw new AbacError('MALFORMED_NODE', `"${op}" requires {nodes:[]}`, `${path}.nodes`);
      }
      return { op, nodes: nodes.map((n, i) => parseNode(n, `${path}.nodes[${i}]`)) };
    }
    case 'not': {
      if (!('node' in raw)) {
        throw new AbacError('MALFORMED_NODE', '"not" requires {node}', `${path}.node`);
      }
      return { op: 'not', node: parseNode(raw.node, `${path}.node`) };
    }
    default:
      // whitelist: anything else is rejected with the canonical code.
      throw new AbacError('OPERATOR_NOT_SUPPORTED', `operator not supported: "${op}"`, `${path}.op`);
  }
}

/**
 * Parse untrusted JSON into a typed `AbacNode`.
 * Throws `AbacError{code, path}`. Pure syntax — no catalog/type checks here.
 */
export function parseAbac(json: unknown): AbacNode {
  return parseNode(json, '$');
}
