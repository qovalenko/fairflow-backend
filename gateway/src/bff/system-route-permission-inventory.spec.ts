import { buildRouteInventory, controllersOf } from './route-inventory.util';
import { BffApiModule } from './bff-api.module';

/**
 * FR-ORG-740: system org routes must declare defense-in-depth org-structure PDP keys.
 */
describe('System route org-structure permission markers (FR-ORG-740)', () => {
  const inventory = buildRouteInventory(controllersOf(BffApiModule), 'api');

  const systemOrgRoutes = inventory.filter(
    (e) =>
      !e.public &&
      e.requireSystemRole &&
      e.path.includes('/system/') &&
      !e.path.includes('/system/me'),
  );

  const routesRequiringOrgPerm = [
    'GET /api/v1/system/employees',
    'GET /api/v1/system/colleagues',
    'GET /api/v1/system/departments',
    'GET /api/v1/system/audit',
    'POST /api/v1/system/employees',
    'PATCH /api/v1/system/employees/:userId',
    'DELETE /api/v1/system/employees/:userId',
    'POST /api/v1/system/employees/:userId/deactivate',
    'POST /api/v1/system/employees/:userId/reactivate',
    'POST /api/v1/system/employees/:userId/offboard',
    'GET /api/v1/system/employees/:userId/offboard/preview',
    'POST /api/v1/system/transfer-ownership',
    'POST /api/v1/system/reorg/preview',
    'POST /api/v1/system/departments',
    'DELETE /api/v1/departments/:deptId',
    'GET /api/v1/system/departments/:deptId/bindings',
    'POST /api/v1/system/departments/:deptId/bindings',
    'PATCH /api/v1/system/departments/:deptId/bindings/:bindingId',
    'DELETE /api/v1/system/departments/:deptId/bindings/:bindingId',
    'GET /api/v1/system/invitations',
    'POST /api/v1/system/invitations',
    'POST /api/v1/system/invitations/:id/resend',
    'DELETE /api/v1/system/invitations/:id',
  ];

  it('marks sensitive system org routes with @RequireOrgStructurePermission', () => {
    const missing = routesRequiringOrgPerm.filter((route) => {
      const entry = inventory.find((e) => `${e.method} ${e.path}` === route);
      if (!entry) return true;
      return !String(entry.requirePermission ?? '').startsWith('org:');
    });
    expect(missing).toEqual([]);
  });

  it('does not leave annotated system org routes without a system role gate', () => {
    const withOrgPerm = systemOrgRoutes.filter((e) =>
      String(e.requirePermission ?? '').startsWith('org:'),
    );
    const withoutSysRole = withOrgPerm.filter((e) => !e.requireSystemRole);
    expect(withoutSysRole.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });
});
