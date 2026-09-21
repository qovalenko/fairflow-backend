import {
  ORG_STRUCTURE_KEYS,
  isOrgStructureKey,
  isOrgStructureGrantablePermission,
  buildOrgStructureCatalog,
  expandSystemOrgRolePermissions,
  expandAllSystemOrgRoles,
} from './org-rbac';

/**
 * Unit tests for the org-structure permission vocabulary + system org-role
 * expansion (P8 T4.1). Pure logic. The grantability gate is a security boundary:
 * it must reject any non-org key smuggled into an org role.
 */
describe('org-structure keys', () => {
  it('isOrgStructureKey recognises canonical keys and rejects others', () => {
    expect(isOrgStructureKey('org:employees:read')).toBe(true);
    expect(isOrgStructureKey('org:employees:manage')).toBe(true);
    expect(isOrgStructureKey('org:audit:read')).toBe(true);
    // org:audit is read-only — manage is NOT a valid key
    expect(isOrgStructureKey('org:audit:manage')).toBe(false);
    expect(isOrgStructureKey('deals:read')).toBe(false);
  });

  it('isOrgStructureGrantablePermission rejects non-org / malformed keys (no smuggling)', () => {
    expect(isOrgStructureGrantablePermission('org:departments:manage')).toBe(true);
    expect(isOrgStructureGrantablePermission('auth:users:manage')).toBe(false);
    expect(isOrgStructureGrantablePermission('deals:read')).toBe(false);
    expect(isOrgStructureGrantablePermission('garbage')).toBe(false);
  });

  it('ORG_STRUCTURE_KEYS is sorted + non-empty', () => {
    expect(ORG_STRUCTURE_KEYS.length).toBeGreaterThan(0);
    expect([...ORG_STRUCTURE_KEYS]).toEqual([...ORG_STRUCTURE_KEYS].sort());
  });
});

describe('buildOrgStructureCatalog', () => {
  it('is deterministic (cached, sorted) and answers membership', () => {
    const a = buildOrgStructureCatalog();
    const b = buildOrgStructureCatalog();
    expect(a).toBe(b); // cached singleton
    expect(a.has('org:employees', 'read')).toBe(true);
    expect(a.has('org:audit', 'manage')).toBe(false);
    expect(a.hasKey('org:units:manage')).toBe(true);
    expect(a.entries.map((e) => e.subject)).toEqual(
      [...a.entries.map((e) => e.subject)].sort((x, y) => x.localeCompare(y)),
    );
  });
});

describe('system org-role expansion', () => {
  it('employee gets a read-only structure view (no audit/invitations/manage)', () => {
    const emp = expandSystemOrgRolePermissions('employee');
    expect(emp).toContain('org:employees:read');
    expect(emp).toContain('org:profile:read');
    expect(emp).not.toContain('org:employees:manage');
    expect(emp).not.toContain('org:audit:read');
    expect(emp).not.toContain('org:invitations:manage');
  });

  it('platform_owner / platform_admin carry the FULL vocabulary', () => {
    const owner = expandSystemOrgRolePermissions('platform_owner');
    const admin = expandSystemOrgRolePermissions('platform_admin');
    expect(owner).toEqual([...ORG_STRUCTURE_KEYS].sort());
    // owner and admin are identical by design (old orgRoleCanManage did not distinguish)
    expect(admin).toEqual(owner);
    expect(owner).toContain('org:invitations:manage');
  });

  it('expandAllSystemOrgRoles returns all three role sets', () => {
    const all = expandAllSystemOrgRoles();
    expect(Object.keys(all).sort()).toEqual(['employee', 'platform_admin', 'platform_owner']);
    expect(all.employee.length).toBeLessThan(all.platform_owner.length);
  });
});
