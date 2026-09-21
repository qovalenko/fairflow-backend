import { buildRouteInventory, controllersOf } from '../bff/route-inventory.util';
import { AuthModule } from './auth.module';

/**
 * TODO-056: header-scoped profile routes use ProjectAccessGuard and must declare
 * @MembershipOnly — otherwise X-Project-Id triggers ROUTE_PERMISSION_MARKER_REQUIRED (403).
 */
describe('ProfilePublicController route gates (TODO-056)', () => {
  const inventory = buildRouteInventory(controllersOf(AuthModule), 'api');

  it('GET profile/users/:id is membership-only with ProjectAccessGuard', () => {
    const route = inventory.find(
      (e) => e.method === 'GET' && e.path.endsWith('/profile/users/:id'),
    );
    expect(route).toBeDefined();
    expect(route!.guards).toContain('ProjectAccessGuard');
    expect(route!.membershipOnly).toBe(true);
    expect(route!.requirePermission).toBeNull();
  });
});
