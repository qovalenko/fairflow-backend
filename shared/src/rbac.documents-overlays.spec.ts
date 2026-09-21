import { projectRoleCanKey } from './rbac';

describe('documents RBAC overlays (FR-DOCS-212/215)', () => {
  it('manager may manage document templates via granular allow-list', () => {
    expect(projectRoleCanKey('manager', 'documents', 'manage')).toBe(true);
  });

  it('manager may not delete documents (admin+ only)', () => {
    expect(projectRoleCanKey('manager', 'documents', 'delete')).toBe(false);
    expect(projectRoleCanKey('manager', 'deals', 'delete')).toBe(true);
  });

  it('admin retains documents delete and manage', () => {
    expect(projectRoleCanKey('admin', 'documents', 'delete')).toBe(true);
    expect(projectRoleCanKey('admin', 'documents', 'manage')).toBe(true);
  });
});
