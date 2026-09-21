/**
 * review-1 (gateway PEP): ABAC push-down for a CROSS-ENTITY route.
 *
 * `/search/query` is gated on subject `search`, but the rows it returns belong to
 * `deals`/`contacts`/… . `compileAccessPredicate` selects rules by
 * `rule.subject === subject`, so compiling against `search` matched NOTHING: every
 * conditional ABAC rule and every blanket module DENY written for a CRM module was
 * enforced on that module's own routes and bypassed by the global search box
 * (title/subtitle/path/entity_id of a hidden record leaked through it).
 *
 * `compileCrossEntityAccessPredicate` compiles each indexed data-subject on its own
 * and emits one `entityType`-guarded disjunct per subject, so the store's read
 * filter applies each module's rules inside its own type and drops the subjects it
 * cannot honour.
 */
import { compileCrossEntityAccessPredicate, type AbacPolicyRule } from './access-predicate';
import {
  CROSS_ENTITY_SUBJECT_ENTITY_TYPES,
  parseCompiledPredicate,
  type AbacEvalContext,
} from '@fairflow/shared';

const CTX: AbacEvalContext = {
  user: {
    id: 'u1',
    departmentId: null,
    departmentChain: [],
    leaderOfDepartmentIds: [],
    role: 'member',
  },
  project: { id: 'p1', ownerType: '', ownerId: '' },
};

const PAIRS = Object.entries(CROSS_ENTITY_SUBJECT_ENTITY_TYPES).map(([s, t]) => [s, t] as const);
const ALL_TYPES = PAIRS.map(([, t]) => t);

function compile(
  rules: AbacPolicyRule[],
  denied: string[] = [],
  action = 'read',
): Record<string, unknown> | undefined {
  const serialized = compileCrossEntityAccessPredicate({
    rules,
    action,
    ctx: CTX,
    subjectEntityTypes: PAIRS,
    isBlanketDenied: (s) => denied.includes(s),
  });
  if (serialized === undefined) return undefined;
  const parsed = parseCompiledPredicate(serialized);
  expect(parsed.ir).toBeNull();
  expect(parsed.mongo).toBeTruthy();
  return parsed.mongo as Record<string, unknown>;
}

/** entity types that can still match at least one disjunct of `mongo`. */
function typesAllowed(mongo: Record<string, unknown> | undefined): string[] {
  if (!mongo) return [...ALL_TYPES]; // absent predicate = no narrowing at all
  const branches = Array.isArray(mongo.$or) ? (mongo.$or as Record<string, unknown>[]) : [mongo];
  const out: string[] = [];
  for (const b of branches) {
    const flat = Array.isArray(b.$and)
      ? Object.assign({}, ...(b.$and as Record<string, unknown>[]))
      : b;
    const t = (flat as Record<string, unknown>).entityType;
    if (typeof t === 'string') out.push(t);
    else if (t && typeof t === 'object' && Array.isArray((t as { $in?: string[] }).$in)) {
      out.push(...((t as { $in: string[] }).$in ?? []));
    }
  }
  return out;
}

/**
 * A conditional DENY at the COMPILER level. NB: in the live guard such a rule is
 * short-circuited earlier by `isDeniedByPolicy` (which ignores `condition` and
 * 403s the module route), so the guard hands this subject in as blanket-denied —
 * pinned in `project-access.cross-entity-predicate.spec.ts`. The compiler is
 * tested on its own contract so it stays correct if that ever changes.
 */
const dealAmountDeny: AbacPolicyRule = {
  effect: 'deny',
  subject: 'deals',
  action: 'read',
  resource: '*',
  condition: { op: 'gt', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
};

describe('compileCrossEntityAccessPredicate', () => {
  it('emits nothing when no rule narrows and nothing is denied (byte-identical to today)', () => {
    expect(compile([])).toBeUndefined();
    expect(
      compile([{ effect: 'allow', subject: 'deals', action: 'read', resource: '*' }]),
    ).toBeUndefined();
  });

  it('applies a module rule INSIDE its own entity type and leaves the others open', () => {
    const mongo = compile([dealAmountDeny])!;
    // Every indexable type still has a disjunct — the rule must not hide contacts.
    expect(typesAllowed(mongo).sort()).toEqual([...ALL_TYPES].sort());

    const branches = mongo.$or as Record<string, unknown>[];
    const dealBranch = branches.find((b) => JSON.stringify(b).includes('"entityType":"deal"'))!;
    // deny + condition → exclude matches ($nor), guarded by entityType.
    expect(dealBranch).toEqual({
      $and: [{ entityType: 'deal' }, { $nor: [{ amount: { $gt: 1_000_000 } }] }],
    });
    // A type with no rules contributes a bare type guard, not a copy of the rule.
    expect(branches).toContainEqual({ entityType: 'contact' });
  });

  it('does not leak one module rule onto another module rows', () => {
    const mongo = compile([dealAmountDeny])!;
    const branches = mongo.$or as Record<string, unknown>[];
    const nonDeal = branches.filter((b) => !JSON.stringify(b).includes('"entityType":"deal"'));
    expect(nonDeal.length).toBe(ALL_TYPES.length - 1);
    expect(nonDeal.some((b) => JSON.stringify(b).includes('amount'))).toBe(false);
  });

  it('drops a blanket-DENYed subject entirely (the DENY that 403s /contacts also hides them here)', () => {
    const mongo = compile([], ['contacts'])!;
    expect(typesAllowed(mongo)).not.toContain('contact');
    expect(typesAllowed(mongo).sort()).toEqual(ALL_TYPES.filter((t) => t !== 'contact').sort());
  });

  it('drops a subject whose rules cannot be compiled here — fail-closed, not fail-open', () => {
    // `user.departmentId` is not resolvable on the gateway (UNRESOLVABLE_CONTEXT_REFS):
    // for a single-subject route that degrades to "no narrowing", but a cross-entity
    // read must show less rather than surface rows a deny-rule was meant to hide.
    const rules: AbacPolicyRule[] = [
      {
        effect: 'deny',
        subject: 'orders',
        action: 'read',
        resource: '*',
        condition: {
          op: 'ne',
          left: { ref: 'record.departmentId' },
          right: { ref: 'user.departmentId' },
        },
      },
    ];
    const mongo = compile(rules)!;
    expect(typesAllowed(mongo)).not.toContain('order');
  });

  it('drops a subject whose condition does not parse', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'products',
        action: 'read',
        resource: '*',
        condition: { op: 'no-such-op', left: { ref: 'record.x' }, right: { lit: 1 } },
      },
    ];
    expect(typesAllowed(compile(rules))).not.toContain('product');
  });

  it('matches NOTHING (never "no header") when every subject is dropped', () => {
    const mongo = compile([], [...PAIRS.map(([s]) => s)])!;
    expect(mongo).toEqual({ entityType: { $in: [] } });
    expect(typesAllowed(mongo)).toEqual([]);
  });

  it('honours the action axis: a rule for another action does not narrow this read', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'deny',
        subject: 'deals',
        action: 'write',
        resource: '*',
        condition: { op: 'gt', left: { ref: 'record.amount' }, right: { lit: 10 } },
      },
    ];
    expect(compile(rules, [], 'read')).toBeUndefined();
  });

  it('a wildcard-action rule DOES narrow the read', () => {
    const rules: AbacPolicyRule[] = [{ ...dealAmountDeny, action: '*' }];
    const mongo = compile(rules, [], 'read')!;
    expect(JSON.stringify(mongo)).toContain('$nor');
  });
});
