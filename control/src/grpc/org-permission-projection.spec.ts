import { ControlGrpcController } from './control.grpc.controller';
import { OrgPdpService } from '../organizations/org-pdp.service';

/**
 * P8-T4.3 — GetOrgPermissionProjection grpc method. The controller is a thin
 * reshaper over OrgPdpService.resolveOrgEffective: `allow` → `allowed`, plus
 * `org_role` / `is_member` (keepCase wire). We mock the PDP so the test asserts
 * the CONTRACT (field mapping + fail-closed on non-member + the HR custom-role
 * key flowing through), not the PDP internals (covered by org-pdp.service.spec).
 */
describe('ControlGrpcController.getOrgPermissionProjection', () => {
  function makeController(pdp: Partial<OrgPdpService>): ControlGrpcController {
    // Only orgPdp is exercised by this method; the rest stay undefined. Except:
    // DEORG-BE-16 — the method now resolves the system singleton via
    // OrganizationsService.resolveSystemAnchorId (ignoring the client
    // organization_id), so a minimal stub returning the anchor id is supplied.
    const organizations = {
      resolveSystemAnchorId: jest.fn().mockResolvedValue('org-1'),
    };
    return new ControlGrpcController(
      undefined as never, // projects
      undefined as never, // moduleDisableImpact
      undefined as never, // lifecycle
      organizations as never, // organizations
      undefined as never, // structure
      undefined as never, // departmentBindings
      undefined as never, // invitations
      undefined as never, // orgAudit
      undefined as never, // visibility
      undefined as never, // shares
      undefined as never, // users
      undefined as never, // roles
      undefined as never, // accessUnits
      undefined as never, // accessEpoch
      undefined as never, // pdp
      undefined as never, // integrations
      undefined as never, // seats
      pdp as OrgPdpService,
      undefined as never, // projectInvitations
    );
  }

  it('reshapes the PDP allow-set into { allowed, org_role, is_member }', async () => {
    const resolveOrgEffective = jest.fn().mockResolvedValue({
      allow: ['org:employees:read', 'org:departments:read'],
      deny: [],
      orgRole: 'employee',
      isMember: true,
    });
    const c = makeController({ resolveOrgEffective });

    const res = await c.getOrgPermissionProjection({ organization_id: 'org-1', user_id: 'emp-u' });

    expect(resolveOrgEffective).toHaveBeenCalledWith('org-1', 'emp-u');
    expect(res).toEqual({
      allowed: ['org:employees:read', 'org:departments:read'],
      org_role: 'employee',
      is_member: true,
    });
    // employee projection carries NO manage key.
    expect(res.allowed.some((k) => k.endsWith(':manage'))).toBe(false);
  });

  it('HR custom role surfaces org:employees:manage in allowed (T4.1 grants flow through)', async () => {
    const resolveOrgEffective = jest.fn().mockResolvedValue({
      allow: ['org:employees:read', 'org:employees:manage'],
      deny: [],
      orgRole: 'employee',
      isMember: true,
    });
    const c = makeController({ resolveOrgEffective });

    const res = await c.getOrgPermissionProjection({ organization_id: 'org-1', user_id: 'hr-u' });

    expect(res.allowed).toContain('org:employees:manage');
    expect(res.allowed).not.toContain('org:departments:manage');
  });

  it('non-member → empty allowed, empty role, is_member=false (fail-closed)', async () => {
    const resolveOrgEffective = jest.fn().mockResolvedValue({
      allow: [],
      deny: [],
      orgRole: '',
      isMember: false,
    });
    const c = makeController({ resolveOrgEffective });

    const res = await c.getOrgPermissionProjection({ organization_id: 'org-1', user_id: 'ghost' });

    expect(res).toEqual({ allowed: [], org_role: '', is_member: false });
  });

  it('ignores the client organization_id — resolves the system singleton (DEORG-BE-16)', async () => {
    const resolveOrgEffective = jest.fn().mockResolvedValue({
      allow: [],
      deny: [],
      orgRole: '',
      isMember: false,
    });
    const c = makeController({ resolveOrgEffective });
    // No organization_id in the body: box is single-tenant, the controller
    // resolves the singleton anchor ('org-1') and scopes to it regardless.
    await c.getOrgPermissionProjection({ user_id: 'u' });
    expect(resolveOrgEffective).toHaveBeenCalledWith('org-1', 'u');
  });
});
