import {
  compileAccessPredicate,
  compileAccessPredicateResult,
  type AbacPolicyRule,
} from './access-predicate';
import { parseCompiledPredicate, type AbacEvalContext } from '@fairflow/shared';

const CTX: AbacEvalContext = {
  user: {
    id: 'u1',
    departmentId: null,
    departmentChain: [],
    leaderOfDepartmentIds: [],
    role: 'member',
  },
  project: { id: 'p1', ownerType: 'ORGANIZATION', ownerId: 'org1' },
};

function decode(serialized: string | undefined) {
  expect(serialized).toBeDefined();
  return parseCompiledPredicate(serialized);
}

describe('compileAccessPredicate', () => {
  it('returns undefined when there are no rules', () => {
    expect(
      compileAccessPredicate({ rules: [], subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });

  it('returns undefined when no rule applies to the (subject, action)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'contacts',
        action: 'read',
        resource: '*',
        condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 100 } },
      },
    ];
    expect(
      compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });

  it('ignores unconditional (blanket) rules — they are RBAC-layer, not row predicates', () => {
    const rules: AbacPolicyRule[] = [
      { effect: 'deny', subject: 'deals', action: 'read', resource: '*', condition: {} },
      { effect: 'allow', subject: 'deals', action: 'read', resource: '*' },
    ];
    expect(
      compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });

  it('compiles an ALLOW condition into the readable-set fragment (AND condition)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.ir).toBeNull();
    expect(p.mongo).toEqual({ amount: { $lt: 1_000_000 } });
  });

  it('compiles a DENY condition into an exclusion (AND NOT condition) via $nor', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'deny',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toEqual({
      $or: [{ $nor: [{ amount: { $gte: 1_000_000 } }] }, { ownerId: 'u1' }],
    });
  });

  it('combines allow + deny under $and (deny wins by exclusion)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 5_000_000 } },
      },
      {
        effect: 'deny',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toEqual({
      $or: [
        {
          $and: [{ amount: { $lt: 5_000_000 } }, { $nor: [{ amount: { $gte: 1_000_000 } }] }],
        },
        { ownerId: 'u1' },
      ],
    });
  });

  it('substitutes resolvable user.* context refs (partial-eval)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'eq', left: { ref: 'record.ownerId' }, right: { ref: 'user.id' } },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toEqual({ ownerId: { $eq: 'u1' } });
  });

  it('matches rules with action "*"', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: '*',
        resource: '*',
        condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 10 } },
      },
    ];
    const p = decode(
      compileAccessPredicate({ rules, subject: 'deals', action: 'write', ctx: CTX }),
    );
    expect(p.mongo).toEqual({ amount: { $lt: 10 } });
  });

  it('fail-closed when a conditional deny references an unresolvable context attribute', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'deny',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: {
          op: 'ne',
          left: { ref: 'record.region' },
          right: { ref: 'user.departmentId' },
        },
      },
    ];
    const result = compileAccessPredicateResult({
      rules,
      subject: 'deals',
      action: 'read',
      ctx: CTX,
    });
    expect(result.predicate).toBeUndefined();
    expect(result.failClosed).toBe(true);
    expect(
      compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });

  it('skips an uncompilable allow while still compiling a resolvable deny', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'bogus', left: { ref: 'record.amount' }, right: { lit: 1 } },
      },
      {
        effect: 'deny',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toEqual({
      $or: [{ $nor: [{ amount: { $gte: 1_000_000 } }] }, { ownerId: 'u1' }],
    });
  });

  it('marks denyCompiled when a deny fragment lands in the predicate, and not for allow-only', () => {
    const deny: AbacPolicyRule = {
      effect: 'deny',
      subject: 'deals',
      action: 'read',
      resource: '*',
      condition: { op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
    };
    const allow: AbacPolicyRule = {
      effect: 'allow',
      subject: 'deals',
      action: 'read',
      resource: '*',
      condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 10 } },
    };
    const withDeny = compileAccessPredicateResult({
      rules: [allow, deny],
      subject: 'deals',
      action: 'read',
      ctx: CTX,
    });
    expect(withDeny.predicate).toBeDefined();
    expect(withDeny.denyCompiled).toBe(true);
    const allowOnly = compileAccessPredicateResult({
      rules: [allow],
      subject: 'deals',
      action: 'read',
      ctx: CTX,
    });
    expect(allowOnly.predicate).toBeDefined();
    expect(allowOnly.denyCompiled).toBe(false);
  });

  it('defers (returns undefined) on an uncompilable/garbage condition rather than emitting malformed', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'bogus', left: { ref: 'record.amount' }, right: { lit: 1 } },
      },
    ];
    expect(
      compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });

  it('returns undefined when the route carries no subject', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1 } },
      },
    ];
    expect(
      compileAccessPredicate({ rules, subject: '', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });
});
