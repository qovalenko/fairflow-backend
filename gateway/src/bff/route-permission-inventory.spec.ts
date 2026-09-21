import { buildRouteInventory, controllersOf } from './route-inventory.util';
import { BffApiModule } from './bff-api.module';
import { AuthModule } from '../auth/auth.module';

/**
 * TODO-056 — every project-scoped BFF/auth route must declare an explicit gate:
 * @RequirePermission, @RequireSystemRole, or @MembershipOnly.
 *
 * Header-scoped routes (X-Project-Id, no `:projectId` in the path) are in
 * scope too: the frontend interceptor attaches the header on almost every
 * /api call, so an unmarked ProjectAccessGuard handler 403s with
 * ROUTE_PERMISSION_MARKER_REQUIRED (GET /profile/users/:id live bug).
 */
describe('BFF route permission markers (TODO-056)', () => {
  const inventory = [
    ...buildRouteInventory(controllersOf(BffApiModule), 'api'),
    ...buildRouteInventory(controllersOf(AuthModule), 'api'),
  ];

  const projectScoped = inventory.filter(
    (e) => !e.public && !e.skipProjectScope && e.guards.includes('ProjectAccessGuard'),
  );

  it('marks every ProjectAccessGuard route with perm, system role, or membership-only', () => {
    const unmarked = projectScoped.filter(
      (e) => !e.requirePermission && !e.requireSystemRole && !e.membershipOnly,
    );
    expect(unmarked.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });
});
