type PolicyRule = {
  effect: 'allow' | 'deny';
  subject: string;
  action: string;
  resource?: string;
};

/** Minimal mirror of ProjectAccessGuard.isDeniedByPolicy owner short-circuit (FR-ACCESS-485). */
function isDeniedByPolicy(
  rules: PolicyRule[],
  subject: string,
  action: string,
  role?: string,
): boolean {
  if (role === 'owner') return false;
  return rules.some(
    (r) =>
      r.effect === 'deny' &&
      r.subject === subject &&
      (r.action === action || r.action === '*') &&
      (!r.resource || r.resource === '*'),
  );
}

describe('FR-ACCESS-485 owner short-circuit on blanket deny', () => {
  const rules: PolicyRule[] = [{ effect: 'deny', subject: 'deals', action: 'read', resource: '*' }];

  it('blocks non-owner on blanket deny', () => {
    expect(isDeniedByPolicy(rules, 'deals', 'read', 'member')).toBe(true);
  });

  it('does not block project owner', () => {
    expect(isDeniedByPolicy(rules, 'deals', 'read', 'owner')).toBe(false);
  });

  it('owner short-circuit also applies to write (create-deny must not lock out owner)', () => {
    expect(isDeniedByPolicy(rules, 'deals', 'write', 'owner')).toBe(false);
  });
});
