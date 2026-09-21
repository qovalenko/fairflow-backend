import { resolveProfileVisibilityLevel } from './profile-visibility';

describe('resolveProfileVisibilityLevel', () => {
  it('maps platform roles to level 3', () => {
    expect(resolveProfileVisibilityLevel('', 'platform_owner')).toBe(3);
    expect(resolveProfileVisibilityLevel('', 'platform_admin')).toBe(3);
  });

  it('maps project roles per §19 matrix', () => {
    expect(resolveProfileVisibilityLevel('owner')).toBe(2);
    expect(resolveProfileVisibilityLevel('admin')).toBe(2);
    expect(resolveProfileVisibilityLevel('member')).toBe(1);
    expect(resolveProfileVisibilityLevel('manager')).toBe(1);
    expect(resolveProfileVisibilityLevel('viewer')).toBe(0);
  });
});
