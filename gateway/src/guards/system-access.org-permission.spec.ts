import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { SystemAccessGuard, invalidateSystemAccessCache } from './system-access.guard';
import {
  REQUIRED_SYSTEM_ROLE_KEY,
  type SystemRoleRequirement,
} from './require-system-role.decorator';
import {
  REQUIRED_ORG_STRUCTURE_PERMISSION_KEY,
  type RequiredOrgStructurePermission,
} from './require-org-structure-permission.decorator';

describe('SystemAccessGuard — owner + org-structure PDP (FR-ORG-040/740)', () => {
  const OLD_ENV = { ...process.env };

  let getOrgRole: jest.Mock;
  let getOrgPermissionProjection: jest.Mock;
  const control = {
    getService: () => ({ getOrgRole, getOrgPermissionProjection }),
  };
  const outboundMeta = { build: jest.fn(() => ({})) };

  const makeReflector = (
    requirement?: SystemRoleRequirement,
    orgPerm?: RequiredOrgStructurePermission,
  ) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_SYSTEM_ROLE_KEY) return requirement;
      if (key === REQUIRED_ORG_STRUCTURE_PERMISSION_KEY) return orgPerm;
      return undefined;
    }),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (
    requirement?: SystemRoleRequirement,
    orgPerm?: RequiredOrgStructurePermission,
  ) =>
    new SystemAccessGuard(
      makeReflector(requirement, orgPerm) as never,
      control as never,
      outboundMeta as never,
    );

  const memberReq = (userId: string, systemOrgId = 'sys-1') => ({
    user: { userId },
    headers: {},
    __systemOrgId: systemOrgId,
  });

  beforeEach(() => {
    process.env.GATEWAY_ORG_ACCESS_CACHE_TTL_MS = '0';
    delete process.env.GATEWAY_ORG_ACCESS_ENFORCE;
    getOrgRole = jest.fn(() => of({ role: 'platform_owner', is_member: true, is_active: true }));
    getOrgPermissionProjection = jest.fn(() =>
      of({ allowed: ['org:employees:read', 'org:employees:manage'] }),
    );
    outboundMeta.build.mockClear();
    invalidateSystemAccessCache();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('owner route allows platform_owner and denies platform_admin (FR-ORG-040)', async () => {
    const guard = makeGuard('owner');
    await expect(guard.canActivate(makeContext(memberReq('u-owner')))).resolves.toBe(true);

    getOrgRole.mockReturnValue(of({ role: 'platform_admin', is_member: true, is_active: true }));
    invalidateSystemAccessCache();
    await expect(guard.canActivate(makeContext(memberReq('u-admin')))).rejects.toMatchObject({
      response: { code: 'SYSTEM_PERMISSION_DENIED' },
    });
  });

  it('org-structure permission denies when PDP allow-set lacks the key (FR-ORG-740)', async () => {
    getOrgRole.mockReturnValue(of({ role: 'employee', is_member: true, is_active: true }));
    getOrgPermissionProjection.mockReturnValue(of({ allowed: [] }));
    const guard = makeGuard('member', { subject: 'org:employees', action: 'read' });
    await expect(guard.canActivate(makeContext(memberReq('u-emp')))).rejects.toMatchObject({
      response: { code: 'ORG_STRUCTURE_PERMISSION_DENIED' },
    });
  });

  it('org-structure permission allows when PDP carries the required key', async () => {
    getOrgRole.mockReturnValue(of({ role: 'employee', is_member: true, is_active: true }));
    getOrgPermissionProjection.mockReturnValue(of({ allowed: ['org:employees:read'] }));
    const guard = makeGuard('member', { subject: 'org:employees', action: 'read' });
    await expect(guard.canActivate(makeContext(memberReq('u-emp')))).resolves.toBe(true);
  });

  it('fail-closed when PDP projection is unreachable', async () => {
    getOrgPermissionProjection.mockReturnValue(throwError(() => new Error('down')));
    const guard = makeGuard('member', { subject: 'org:employees', action: 'read' });
    await expect(guard.canActivate(makeContext(memberReq('u-emp')))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
