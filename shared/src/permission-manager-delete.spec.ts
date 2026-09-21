import { buildProjectCatalogWithSystem, expandSystemRolePermissions } from './permission-rbac';

describe('FR-ACCESS-145 manager project:delete deny', () => {
  const catalog = buildProjectCatalogWithSystem(['deals']);

  it('manager expansion must not emit project:delete', () => {
    const manager = expandSystemRolePermissions('manager', catalog);
    expect(manager).not.toContain('project:delete');
    expect(manager).not.toContain('project:manage');
  });

  it('owner still receives project:delete', () => {
    const owner = expandSystemRolePermissions('owner', catalog);
    expect(owner).toContain('project:delete');
  });
});
