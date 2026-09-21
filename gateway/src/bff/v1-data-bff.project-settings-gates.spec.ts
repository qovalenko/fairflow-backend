import { buildRouteInventory, controllersOf, type RouteEntry } from './route-inventory.util';
import { BffApiModule } from './bff-api.module';

/**
 * TODO-279 — permission gates of the project-settings surface.
 *
 * `ProjectAccessGuard` alone only proves MEMBERSHIP: without `@RequirePermission`
 * a route is open to every member of the project (viewer included). Several
 * project-administration routes relied on that plus a client-side tab gate:
 * record sharing (handing out access to a record!), the integration/API-key
 * registries and the module state matrix.
 *
 * This suite freezes the gate of each project-settings route — both directions:
 * the administration routes MUST carry `project:manage`, and the two routes the
 * canon deliberately keeps membership-scoped (`GET /projects/:projectId`,
 * `GET /projects/:projectId/members`, see docs/20-requirements/33-projects.md §7)
 * MUST NOT be tightened by accident. Reads decorator metadata only — no
 * bootstrap, no gRPC.
 */
describe('project-settings route gates (TODO-279)', () => {
  const inventory = buildRouteInventory(controllersOf(BffApiModule), 'api');

  const find = (method: string, path: string): RouteEntry => {
    const entry = inventory.find((e) => e.method === method && e.path === path);
    if (!entry) throw new Error(`route not found in BFF inventory: ${method} ${path}`);
    return entry;
  };

  const MANAGE_GATED: Array<[string, string]> = [
    // Integration registry + per-project API keys: endpoint URLs and issued
    // credentials — administration data behind the manage-gated settings tab.
    ['GET', '/api/v1/projects/:projectId/integrations'],
    ['GET', '/api/v1/projects/:projectId/integrations/:integrationId'],
    ['GET', '/api/v1/projects/:projectId/api-keys'],
    // Disable-impact preview is manage-gated (mutation precursor).
    ['GET', '/api/v1/projects/:projectId/modules/:moduleId/disable-impact'],
  ];

  const MEMBERSHIP_GATED_SHARES: Array<[string, string]> = [
    // FR-ACCESS-400/420: record sharing is membership-scoped at the gateway;
    // control enforces record-owner / manager authorization fail-closed.
    ['POST', '/api/v1/projects/:projectId/shares'],
    ['GET', '/api/v1/projects/:projectId/shares'],
    ['DELETE', '/api/v1/projects/:projectId/shares/:shareId'],
  ];

  it.each(MANAGE_GATED)('%s %s requires project:manage', (method, path) => {
    const entry = find(method, path);
    expect(entry.requirePermission).toBe('project:manage');
    expect(entry.public).toBe(false);
  });

  it('keeps the already-gated neighbours at project:manage (no regression)', () => {
    for (const [method, path] of [
      ['PATCH', '/api/v1/projects/:projectId'],
      ['GET', '/api/v1/projects/:projectId/audit/events'],
      ['POST', '/api/v1/projects/:projectId/integrations'],
      ['POST', '/api/v1/projects/:projectId/api-keys'],
      ['DELETE', '/api/v1/projects/:projectId/api-keys/:keyId'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/install'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/uninstall'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/enable'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/disable'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/upgrade'],
      ['POST', '/api/v1/projects/:projectId/modules/:moduleId/upgrade/preview'],
    ] as Array<[string, string]>) {
      expect([method, path, find(method, path).requirePermission]).toEqual([
        method,
        path,
        'project:manage',
      ]);
    }
  });

  /**
   * Counter-direction: these two stay membership-scoped by canon
   * (docs/20-requirements/33-projects.md §7 — «членство»). Every member needs the
   * project card and the member list (assignee pickers, share grantee picker), so
   * tightening them would break the app for non-admins.
   */
  it('leaves the member-facing project reads on membership only', () => {
    expect(find('GET', '/api/v1/projects/:projectId').requirePermission).toBeNull();
    expect(find('GET', '/api/v1/projects/:projectId/members').requirePermission).toBeNull();
    // FR-PLATFORM-250 / FR-LIFE-36: module matrix is read-only for any member.
    expect(find('GET', '/api/v1/projects/:projectId/modules').requirePermission).toBeNull();
  });

  it.each(MEMBERSHIP_GATED_SHARES)('%s %s is membership-only (FR-ACCESS-400)', (method, path) => {
    const entry = find(method, path);
    expect(entry.requirePermission).toBeNull();
    expect(entry.membershipOnly).toBe(true);
    expect(entry.public).toBe(false);
  });

  it('runs every project-settings route through ProjectAccessGuard', () => {
    for (const [method, path] of [...MANAGE_GATED, ...MEMBERSHIP_GATED_SHARES]) {
      expect([path, find(method, path).guards]).toEqual([
        path,
        expect.arrayContaining(['ProjectAccessGuard']),
      ]);
    }
  });
});
