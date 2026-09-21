import { compileAccessPredicate, type AbacPolicyRule } from './access-predicate';
import { parseCompiledPredicate, type AbacEvalContext } from '@fairflow/shared';

/**
 * Component coverage (QA-CI T-036.3) for the ref-collection tree walk in
 * access-predicate (and / or / not recursion) that the base spec's flat
 * conditions do not reach. This is the resolvability gate that keeps a predicate
 * referencing an unavailable context attribute (e.g. department) from ever being
 * serialized into x-access-predicate.
 */
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

describe('compileAccessPredicate — nested condition trees', () => {
  it('compiles an AND of resolvable leaves (walks the and-branch)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: {
          op: 'and',
          nodes: [
            { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1000 } },
            { op: 'eq', left: { ref: 'record.ownerId' }, right: { ref: 'user.id' } },
          ],
        },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toEqual({
      $and: [{ amount: { $lt: 1000 } }, { ownerId: { $eq: 'u1' } }],
    });
  });

  it('compiles an OR of resolvable leaves (walks the or-branch)', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: {
          op: 'or',
          nodes: [
            { op: 'eq', left: { ref: 'record.status' }, right: { lit: 'open' } },
            { op: 'eq', left: { ref: 'record.status' }, right: { lit: 'won' } },
          ],
        },
      },
    ];
    const p = decode(compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }));
    expect(p.mongo).toBeDefined();
  });

  it('walks a NOT-wrapped leaf and still resolves', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: {
          op: 'not',
          node: { op: 'eq', left: { ref: 'record.status' }, right: { lit: 'archived' } },
        },
      },
    ];
    const out = compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX });
    // Whatever the compiled shape, a NOT over a resolvable leaf must not be dropped.
    expect(out).toBeDefined();
  });

  it('defers when an unresolvable ref is buried inside a nested tree', () => {
    const rules: AbacPolicyRule[] = [
      {
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: {
          op: 'and',
          nodes: [
            { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1000 } },
            // department is not resolvable on the gateway → whole predicate deferred.
            { op: 'eq', left: { ref: 'record.dept' }, right: { ref: 'user.departmentId' } },
          ],
        },
      },
    ];
    expect(
      compileAccessPredicate({ rules, subject: 'deals', action: 'read', ctx: CTX }),
    ).toBeUndefined();
  });
});
