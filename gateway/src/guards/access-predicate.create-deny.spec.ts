import { hasConditionalDenyForAction, type AbacPolicyRule } from './access-predicate';

describe('FR-ACCESS-220 conditional deny on create', () => {
  const conditionalDeny: AbacPolicyRule = {
    effect: 'deny',
    subject: 'contacts',
    action: 'write',
    condition: { eq: [{ ref: 'user.role' }, { lit: 'member' }] },
  };

  it('detects conditional deny targeting write', () => {
    expect(hasConditionalDenyForAction([conditionalDeny], 'contacts', 'write')).toBe(true);
  });

  it('ignores unconditional deny (handled by isDeniedByPolicy)', () => {
    expect(
      hasConditionalDenyForAction(
        [{ effect: 'deny', subject: 'contacts', action: 'write' }],
        'contacts',
        'write',
      ),
    ).toBe(false);
  });

  it('does not match a different subject', () => {
    expect(hasConditionalDenyForAction([conditionalDeny], 'deals', 'write')).toBe(false);
  });
});
