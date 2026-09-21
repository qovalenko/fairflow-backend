/**
 * Rule-condition compiler (audit debt #24.2).
 *
 * Compiles a rule's stored `conditions_json` into a safe predicate that is
 * evaluated against an event payload BEFORE any action is dispatched. This is a
 * hand-written tree interpreter — there is NO `eval` / `new Function` and no
 * user input ever reaches the JS parser, so a crafted rule cannot execute code
 * or escape the sandbox (SEC).
 *
 * Supported condition grammar (JSON):
 *
 *   Leaf (field comparison):
 *     { "field": "deal.amount", "op": "gt", "value": 1000 }
 *
 *   Groups (boolean composition):
 *     { "and": [ <cond>, <cond>, ... ] }
 *     { "or":  [ <cond>, <cond>, ... ] }
 *     { "not": <cond> }
 *
 *   A bare array is treated as an implicit AND of its elements (legacy shape):
 *     [ <cond>, <cond> ]  ==  { "and": [ <cond>, <cond> ] }
 *
 * Operators: eq, neq, in, nin, contains, gt, gte, lt, lte, exists.
 *
 * Fields are resolved from the payload via dot-path (`a.b.c`), tolerating
 * arrays and missing intermediates (missing → undefined). Comparisons are
 * intentionally forgiving about number/string coercion for gt/lt so that a
 * numeric payload value compared against a JSON-string threshold still works.
 *
 * Fail-open vs fail-closed: an EMPTY / absent condition set means "no filter"
 * (the rule matches — same as before this compiler existed). A MALFORMED
 * condition node evaluates to `false` for that node (fail-closed on garbage) so
 * a broken rule does not fire external effects on every event.
 */

export type ConditionNode = unknown;

export type Predicate = (payload: Record<string, unknown>) => boolean;

const OPERATORS = new Set([
  'eq',
  'neq',
  'in',
  'nin',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
]);

/** Resolve a dot-path (`a.b.c`) against a payload object; missing → undefined. */
function resolvePath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Loose numeric coercion for ordering operators; NaN when not numeric. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number.NaN;
}

/** Strict-ish equality: same primitive value, or JSON-equal for objects/arrays. */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

function evalContains(fieldValue: unknown, expected: unknown): boolean {
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((item) => looseEqual(item, expected));
  }
  if (typeof fieldValue === 'string') {
    return fieldValue.includes(String(expected));
  }
  if (fieldValue && typeof fieldValue === 'object') {
    return Object.prototype.hasOwnProperty.call(fieldValue, String(expected));
  }
  return false;
}

function evalLeaf(node: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  const field = String(node.field ?? '');
  const op = String(node.op ?? '').toLowerCase();
  if (!field || !OPERATORS.has(op)) return false; // fail-closed on garbage leaf
  const fieldValue = resolvePath(payload, field);
  const expected = node.value;

  switch (op) {
    case 'exists': {
      const want = node.value === undefined ? true : Boolean(node.value);
      const present = fieldValue !== undefined && fieldValue !== null;
      return want ? present : !present;
    }
    case 'eq':
      return looseEqual(fieldValue, expected);
    case 'neq':
      return !looseEqual(fieldValue, expected);
    case 'in':
      return Array.isArray(expected) && expected.some((e) => looseEqual(fieldValue, e));
    case 'nin':
      return !(Array.isArray(expected) && expected.some((e) => looseEqual(fieldValue, e)));
    case 'contains':
      return evalContains(fieldValue, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(fieldValue);
      const b = toNumber(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a single condition node. Recursion depth is bounded to defend against
 * pathological / deeply-nested inputs (fail-closed past the limit).
 */
function evalNode(node: ConditionNode, payload: Record<string, unknown>, depth: number): boolean {
  if (depth > 32) return false;
  if (node == null) return true; // absent node == no constraint
  if (Array.isArray(node)) {
    // Implicit AND of the array elements (legacy shape).
    return node.every((child) => evalNode(child, payload, depth + 1));
  }
  if (typeof node !== 'object') return false;

  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.and)) {
    return obj.and.every((child) => evalNode(child, payload, depth + 1));
  }
  if (Array.isArray(obj.or)) {
    return obj.or.some((child) => evalNode(child, payload, depth + 1));
  }
  if ('not' in obj) {
    return !evalNode(obj.not, payload, depth + 1);
  }
  if ('field' in obj && 'op' in obj) {
    return evalLeaf(obj, payload);
  }
  // Unknown node shape → fail-closed.
  return false;
}

/**
 * Compile `conditions_json` (or an already-parsed tree) into a predicate.
 *
 * An empty/absent condition set compiles to a predicate that always returns
 * `true` (no filter). Malformed JSON is treated the same as "no conditions"
 * only when it is empty; a parseable-but-garbage node evaluates to `false`.
 */
export function compileConditions(conditions: string | ConditionNode): Predicate {
  let tree: ConditionNode;
  if (typeof conditions === 'string') {
    const raw = conditions.trim();
    if (!raw || raw === '[]' || raw === '{}' || raw === 'null') {
      return () => true;
    }
    try {
      tree = JSON.parse(raw);
    } catch {
      // Unparseable conditions → do not silently fire; treat as "never match".
      return () => false;
    }
  } else {
    tree = conditions;
  }

  if (tree == null) return () => true;
  if (Array.isArray(tree) && tree.length === 0) return () => true;
  if (typeof tree === 'object' && !Array.isArray(tree) && Object.keys(tree as object).length === 0) {
    return () => true;
  }

  return (payload: Record<string, unknown>) => evalNode(tree, payload ?? {}, 0);
}

/**
 * Reject-on-save validation of a condition tree (FR-AUTOM-070).
 *
 * `compileConditions` is intentionally forgiving at EXECUTION time (a garbage
 * node fails closed to `false`), but a rule being SAVED with a tree the
 * interpreter cannot understand would silently never fire. This walker applies
 * the exact grammar of {@link evalNode}/{@link evalLeaf} and returns a
 * human-readable problem for the first non-compilable node, or `null` when the
 * tree is fully understood. Empty/absent conditions are valid (== no filter).
 */
export function validateConditionTree(conditions: string | ConditionNode): string | null {
  let tree: ConditionNode;
  if (typeof conditions === 'string') {
    const raw = conditions.trim();
    if (!raw || raw === '[]' || raw === '{}' || raw === 'null') return null;
    try {
      tree = JSON.parse(raw);
    } catch {
      return 'conditions are not valid JSON';
    }
  } else {
    tree = conditions;
  }
  if (tree == null) return null;
  if (Array.isArray(tree) && tree.length === 0) return null;
  if (typeof tree === 'object' && !Array.isArray(tree) && Object.keys(tree as object).length === 0) {
    return null;
  }
  return validateNodeShape(tree, 0);
}

function validateNodeShape(node: ConditionNode, depth: number): string | null {
  if (depth > 32) return 'condition tree is too deeply nested (max 32)';
  if (node == null) return null; // absent node == no constraint
  if (Array.isArray(node)) {
    for (const child of node) {
      const problem = validateNodeShape(child, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof node !== 'object') return 'condition node must be an object or array';

  const obj = node as Record<string, unknown>;
  if ('and' in obj || 'or' in obj) {
    const key = 'and' in obj ? 'and' : 'or';
    const children = obj[key];
    if (!Array.isArray(children)) return `"${key}" must be an array of conditions`;
    for (const child of children) {
      const problem = validateNodeShape(child, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if ('not' in obj) {
    return validateNodeShape(obj.not, depth + 1);
  }
  if ('field' in obj && 'op' in obj) {
    const field = String(obj.field ?? '');
    const op = String(obj.op ?? '').toLowerCase();
    if (!field) return 'condition leaf requires a non-empty "field"';
    if (!OPERATORS.has(op)) {
      return `unknown operator "${op}" (allowed: ${[...OPERATORS].join(', ')})`;
    }
    return null;
  }
  return 'unknown condition node shape (expected {and}/{or}/{not}/{field,op})';
}

/** Convenience: compile + evaluate in one call. */
export function evaluateConditions(
  conditions: string | ConditionNode,
  payload: Record<string, unknown>,
): boolean {
  return compileConditions(conditions)(payload);
}
