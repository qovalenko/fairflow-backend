import { RolesBffController } from './roles-bff.controller';

describe('RolesBffController listProjectRoleAssignments (FR-ACCESS-590)', () => {
  it('exposes GET projects/:projectId/role-assignments handler', () => {
    const names = Object.getOwnPropertyNames(RolesBffController.prototype);
    expect(names).toContain('listProjectRoleAssignments');
  });
});
