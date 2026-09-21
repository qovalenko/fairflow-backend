/**
 * IR normalization (RFC-ABAC §3.3).
 *
 * `normalizeAbac` is the SHARED entry for BOTH `evalGate` and `compileMongo` so the two
 * interpreters always see one and the same tree (SI-3). It:
 *  - pushes `not` to leaves via De Morgan (`not(and)→or(not…)`, `not(or)→and(not…)`),
 *    collapses double `not` (`not(not(X))→X`);
 *  - flattens nested same-kind logic (`and` in `and`, `or` in `or`);
 *  - collapses single-child `and`/`or` into the child;
 *  - leaves empty `and([])` / `or([])` AS-IS (interpreters give them their canonical
 *    semantics: `and([])` ≡ TRUE, `or([])` ≡ FALSE — RFC-ABAC §4).
 *
 * `not` over a comparison leaf is rewritten to its null-safe equivalent so all backends
 * agree on null/missing semantics (RFC-ABAC §3.2):
 *   not(eq(f,L)) ≡ ne(f,L);   not(in(f,L)) ≡ nin(f,L).
 * `not` over any other leaf (gt/gte/lt/lte/ne/nin) is rejected — `NOT_OVER_UNSUPPORTED_LEAF`.
 */
import { AbacError, AbacNode } from './ir';

/** Invert a leaf comparison under `not` (only eq/in allowed). */
function negateLeaf(node: AbacNode, path: string): AbacNode {
  switch (node.op) {
    case 'eq':
      return { op: 'ne', left: node.left, right: node.right };
    case 'in':
      return { op: 'nin', left: node.left, right: node.right };
    case 'and':
      // De Morgan: not(and) → or(not…)
      return { op: 'or', nodes: node.nodes.map((n, i) => negate(n, `${path}.nodes[${i}]`)) };
    case 'or':
      // De Morgan: not(or) → and(not…)
      return { op: 'and', nodes: node.nodes.map((n, i) => negate(n, `${path}.nodes[${i}]`)) };
    case 'not':
      // double negation
      return node.node;
    default:
      throw new AbacError(
        'NOT_OVER_UNSUPPORTED_LEAF',
        `not over "${node.op}" is not supported in v1 (only eq/in)`,
        path,
      );
  }
}

/** Negate a node (entry for `not` lowering). */
function negate(node: AbacNode, path: string): AbacNode {
  return normalize(negateLeaf(node, path), path);
}

function normalize(node: AbacNode, path: string): AbacNode {
  switch (node.op) {
    case 'not':
      return negate(node.node, `${path}.node`);
    case 'and':
    case 'or': {
      const kind = node.op;
      const out: AbacNode[] = [];
      node.nodes.forEach((child, i) => {
        const n = normalize(child, `${path}.nodes[${i}]`);
        // flatten nested same-kind logic
        if (n.op === kind && 'nodes' in n) {
          out.push(...n.nodes);
        } else {
          out.push(n);
        }
      });
      // collapse single child; keep empty AS-IS (interpreters own the identity)
      if (out.length === 1) return out[0];
      return { op: kind, nodes: out };
    }
    default:
      // comparison / set leaf — already normal
      return node;
  }
}

/** Normalize an IR tree to canonical form (De Morgan to leaves, flatten, collapse). */
export function normalizeAbac(node: AbacNode): AbacNode {
  return normalize(node, '$');
}
