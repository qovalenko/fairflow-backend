import { projectRoleCanKey } from './rbac';
import { buildProjectCatalogWithSystem, expandSystemRolePermissions } from './permission-rbac';

describe('products RBAC overlays (FR-PRODUCTS-250)', () => {
  it('member may read products but not write', () => {
    expect(projectRoleCanKey('member', 'products', 'read')).toBe(true);
    expect(projectRoleCanKey('member', 'products', 'write')).toBe(false);
  });

  it('manager may write products but not delete', () => {
    expect(projectRoleCanKey('manager', 'products', 'write')).toBe(true);
    expect(projectRoleCanKey('manager', 'products', 'delete')).toBe(false);
    expect(projectRoleCanKey('manager', 'deals', 'delete')).toBe(true);
  });

  it('admin retains products write and delete', () => {
    expect(projectRoleCanKey('admin', 'products', 'write')).toBe(true);
    expect(projectRoleCanKey('admin', 'products', 'delete')).toBe(true);
  });

  it('bootstrap expansion drops the same overlays (FE can() source)', () => {
    const catalog = buildProjectCatalogWithSystem(['products', 'deals']);
    const member = expandSystemRolePermissions('member', catalog);
    const manager = expandSystemRolePermissions('manager', catalog);
    expect(member).toContain('products:read');
    expect(member).not.toContain('products:write');
    expect(manager).toContain('products:write');
    expect(manager).not.toContain('products:delete');
    expect(manager).toContain('deals:delete');
  });
});

