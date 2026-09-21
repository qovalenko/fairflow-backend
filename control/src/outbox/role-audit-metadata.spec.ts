import { diffPermissionKeySets } from '../roles/role-audit-list.util';

describe('FR-ACCESS-640 role audit metadata', () => {
  it('derives permissionDiff from before/after role payloads', () => {
    const diff = diffPermissionKeySets(
      { name: 'Sales', permissions: ['deals:read'] },
      { name: 'Sales', permissions: ['deals:read', 'deals:write'] },
    );
    expect(diff).toEqual({ added: ['deals:write'], removed: [] });
  });

  it('returns null when permissions are unchanged', () => {
    const payload = { permissions: ['deals:read'] };
    expect(diffPermissionKeySets(payload, payload)).toBeNull();
  });
});
