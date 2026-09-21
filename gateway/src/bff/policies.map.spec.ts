import {
  conditionsToNode,
  evaluatePolicies,
  assessPolicyLockout,
  hasOwnerLockoutRisk,
  blanketDenyBlocksKey,
  grpcRuleToFe,
  moduleIdForSubject,
  nodeToConditions,
  OWNER_LOCKOUT_SUBJECTS,
  type AbacFeRule,
} from './policies.map';

describe('policies.map — subject → module resolution', () => {
  it('resolves a base subject to its module', () => {
    expect(moduleIdForSubject('contacts')).toBe('contacts');
    expect(moduleIdForSubject('deals')).toBe('deals');
  });
  it('resolves a namespaced sub-subject to its owning module', () => {
    expect(moduleIdForSubject('deals.stage')).toBe('deals');
    expect(moduleIdForSubject('contacts.integration')).toBe('contacts');
  });
  it('returns empty for an unknown subject', () => {
    expect(moduleIdForSubject('nope')).toBe('');
  });
});

describe('policies.map — condition <-> AbacNode', () => {
  it('0 conditions → {} (unconditional)', () => {
    expect(conditionsToNode([])).toEqual({});
  });
  it('1 condition → a leaf node', () => {
    expect(
      conditionsToNode([{ attribute: 'record.amount', operator: 'gte', value: 1000 }]),
    ).toEqual({ op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1000 } });
  });
  it('N conditions → an AND of leaves', () => {
    const node = conditionsToNode([
      { attribute: 'record.amount', operator: 'gte', value: 1000 },
      { attribute: 'record.status', operator: 'eq', value: 'open' },
    ]);
    expect(node).toEqual({
      op: 'and',
      nodes: [
        { op: 'gte', left: { ref: 'record.amount' }, right: { lit: 1000 } },
        { op: 'eq', left: { ref: 'record.status' }, right: { lit: 'open' } },
      ],
    });
  });
  it('round-trips leaf and AND back to a flat condition list', () => {
    const conds: AbacFeRule['conditions'] = [
      { attribute: 'record.amount', operator: 'gte', value: 1000 },
      { attribute: 'user.role', operator: 'in', value: ['admin', 'manager'] },
    ];
    expect(nodeToConditions(conditionsToNode(conds))).toEqual(conds);
  });
  it('treats empty/unsupported shapes as no editable conditions', () => {
    expect(nodeToConditions({})).toEqual([]);
    expect(nodeToConditions(undefined)).toEqual([]);
    expect(
      nodeToConditions({
        op: 'or',
        nodes: [{ op: 'eq', left: { ref: 'record.a' }, right: { lit: 1 } }],
      }),
    ).toEqual([]);
  });
});

describe('policies.map — evaluatePolicies', () => {
  const rule = (over: Partial<AbacFeRule>): AbacFeRule => ({
    subject: 'contacts',
    action: 'read',
    effect: 'allow',
    conditions: [],
    ...over,
  });

  it('accepts a valid conditional rule and assigns an id + moduleId', () => {
    const res = evaluatePolicies([
      rule({ conditions: [{ attribute: 'record.amount', operator: 'gte', value: 100 }] }),
    ]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].moduleId).toBe('contacts');
    expect(res.acceptedGrpc[0].id).toBeTruthy();
    expect(res.acceptedGrpc[0].module_id).toBe('contacts');
    expect(res.acceptedGrpc[0].resource).toBe('*');
  });

  it('maps the FE create/update synonyms onto the write catalog entry', () => {
    expect(evaluatePolicies([rule({ action: 'create' })]).rejected).toHaveLength(0);
    expect(evaluatePolicies([rule({ action: 'update' })]).rejected).toHaveLength(0);
  });

  it('rejects an unknown subject:action with MALFORMED_NODE', () => {
    const res = evaluatePolicies([rule({ action: 'fly' })]);
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ index: 0, code: 'MALFORMED_NODE' });
  });

  it('rejects an unsupported operator with OPERATOR_NOT_SUPPORTED', () => {
    const res = evaluatePolicies([
      rule({
        conditions: [{ attribute: 'record.amount', operator: 'xx' as never, value: 1 }],
      }),
    ]);
    expect(res.rejected[0]).toMatchObject({ index: 0, code: 'OPERATOR_NOT_SUPPORTED' });
  });

  it('rejects a disallowed operand namespace with OPERAND_NOT_ALLOWED', () => {
    const res = evaluatePolicies([
      rule({ conditions: [{ attribute: 'foo.bar', operator: 'eq', value: 1 }] }),
    ]);
    expect(res.rejected[0]).toMatchObject({ index: 0, code: 'OPERAND_NOT_ALLOWED' });
  });

  it('rejects a nested record path with OPERAND_NESTED_PATH_UNSUPPORTED', () => {
    const res = evaluatePolicies([
      rule({ conditions: [{ attribute: 'record.a.b', operator: 'eq', value: 1 }] }),
    ]);
    expect(res.rejected[0]).toMatchObject({ index: 0, code: 'OPERAND_NESTED_PATH_UNSUPPORTED' });
  });

  it('flags an unconditional deny as a self-lockout risk when it blocks a held key', () => {
    const res = evaluatePolicies([rule({ effect: 'deny', conditions: [] })]);
    expect(res.rejected).toHaveLength(0);
    expect(assessPolicyLockout(res.accepted, ['contacts:read']).selfLockoutWarning).toBe(true);
  });

  it('partially accepts: keeps the good rule, rejects the bad one by index', () => {
    const res = evaluatePolicies([
      rule({ conditions: [{ attribute: 'record.amount', operator: 'gte', value: 1 }] }),
      rule({ action: 'fly' }),
    ]);
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].index).toBe(1);
  });
});

describe('policies.map — grpcRuleToFe', () => {
  it('maps a stored rule back to the FE shape and marks inactive when module is off', () => {
    const fe = grpcRuleToFe(
      {
        id: 'r1',
        module_id: 'deals',
        effect: 'deny',
        subject: 'deals',
        action: 'read',
        resource: '*',
        condition: { op: 'eq', left: { ref: 'record.status' }, right: { lit: 'won' } },
      },
      ['contacts'],
    );
    expect(fe).toMatchObject({
      id: 'r1',
      subject: 'deals',
      action: 'read',
      effect: 'deny',
      moduleId: 'deals',
      inactive: true,
      conditions: [{ attribute: 'record.status', operator: 'eq', value: 'won' }],
    });
  });

  it('is not inactive when the module is effectively enabled', () => {
    const fe = grpcRuleToFe(
      {
        id: 'r2',
        module_id: 'deals',
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        condition: {},
      },
      ['deals', 'contacts'],
    );
    expect(fe.inactive).toBe(false);
    expect(fe.conditions).toEqual([]);
  });
});

describe('policies.map — assessPolicyLockout (FR-ACCESS-485)', () => {
  const denyRule = (subject: string, action = 'read'): AbacFeRule => ({
    subject,
    action,
    effect: 'deny',
    conditions: [],
  });

  it('OWNER_LOCKOUT when a blanket deny targets access-control subjects', () => {
    for (const subject of OWNER_LOCKOUT_SUBJECTS) {
      expect(assessPolicyLockout([denyRule(subject)]).ownerLockout).toBe(true);
    }
  });

  it('does not OWNER_LOCKOUT a blanket deny on a CRM subject', () => {
    expect(assessPolicyLockout([denyRule('contacts')]).ownerLockout).toBe(false);
  });

  it('selfLockoutWarning only when the deny overlaps author allow keys', () => {
    expect(assessPolicyLockout([denyRule('contacts')], ['contacts:read']).selfLockoutWarning).toBe(
      true,
    );
    expect(assessPolicyLockout([denyRule('contacts')], ['deals:read']).selfLockoutWarning).toBe(
      false,
    );
    expect(assessPolicyLockout([denyRule('contacts')]).selfLockoutWarning).toBe(false);
  });

  it('hasOwnerLockoutRisk detects blanket deny on access-control subjects before catalog', () => {
    expect(
      hasOwnerLockoutRisk([{ subject: 'roles', action: 'read', effect: 'deny', conditions: [] }]),
    ).toBe(true);
  });

  it('blanketDenyBlocksKey matches action or wildcard', () => {
    const rule = denyRule('deals', '*');
    expect(blanketDenyBlocksKey(rule, 'deals:read')).toBe(true);
    expect(blanketDenyBlocksKey(rule, 'deals.stage:move')).toBe(false);
    expect(blanketDenyBlocksKey(rule, 'contacts:read')).toBe(false);
  });
});
