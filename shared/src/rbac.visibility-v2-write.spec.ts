import { normalizeVisibilityConfigV2 } from './rbac';

describe('normalizeVisibilityConfigV2 write path (FR-ACCESS-360)', () => {
  it('accepts v2 policy objects with rules array', () => {
    const raw = {
      manager: {
        rules: [{ kind: 'own_subgroups', roots: 'led' }],
      },
      member: 'only_own',
    };
    const out = normalizeVisibilityConfigV2(raw);
    expect(out.manager).toEqual({ rules: [{ kind: 'own_subgroups', roots: 'led' }] });
    expect(out.member).toBe('only_own');
  });

  it('drops invalid entries fail-closed', () => {
    const out = normalizeVisibilityConfigV2({
      member: { rules: [{ kind: 'bogus' }] },
      notarole: 'all',
    });
    expect(out.member).toBeUndefined();
    expect(out).not.toHaveProperty('notarole');
  });
});
