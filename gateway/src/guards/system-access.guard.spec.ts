import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { SystemAccessGuard, invalidateSystemAccessCache } from './system-access.guard';
import {
  REQUIRED_SYSTEM_ROLE_KEY,
  type SystemRoleRequirement,
} from './require-system-role.decorator';

/**
 * Unit tests for the gateway SYSTEM-isolation PEP (DEORG-GW-3, ex-OrgAccessGuard).
 * The control gRPC client and outbound-metadata builder are mocked; the real
 * decision logic (membership / role / manage gate / fail-closed / cache) runs.
 * box de-orgification (DEORG-GW-5) removed `:orgId` from routes — the guard resolves
 * the caller's system role by userId (control resolves the singleton itself).
 */
describe('SystemAccessGuard', () => {
  const OLD_ENV = { ...process.env };

  let getOrgRole: jest.Mock;
  const control = { getService: () => ({ getOrgRole }) };
  const outboundMeta = { build: jest.fn(() => ({})) };

  const makeReflector = (requirement?: SystemRoleRequirement) => ({
    getAllAndOverride: jest.fn((key: unknown) =>
      key === REQUIRED_SYSTEM_ROLE_KEY ? requirement : undefined,
    ),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (requirement?: SystemRoleRequirement) =>
    new SystemAccessGuard(
      makeReflector(requirement) as never,
      control as never,
      outboundMeta as never,
    );

  // Server-resolved anchor stashed by SystemOrgContextGuard; the client supplies none.
  const memberReq = (userId: string, systemOrgId = 'sys-1') => ({
    user: { userId },
    headers: {},
    __systemOrgId: systemOrgId,
  });

  beforeEach(() => {
    // Correctness tests re-resolve against the mock; caching is tested explicitly.
    process.env.GATEWAY_ORG_ACCESS_CACHE_TTL_MS = '0';
    delete process.env.GATEWAY_ORG_ACCESS_ENFORCE;
    getOrgRole = jest.fn(() => of({ role: 'platform_admin', is_member: true, is_active: true }));
    outboundMeta.build.mockClear();
    invalidateSystemAccessCache();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('passes through routes without a @RequireSystemRole requirement', async () => {
    const guard = makeGuard(undefined);
    await expect(guard.canActivate(makeContext(memberReq('u-1')))).resolves.toBe(true);
    expect(getOrgRole).not.toHaveBeenCalled();
  });

  it('enforces an annotated route even with no anchor stashed (control resolves the singleton)', async () => {
    getOrgRole.mockReturnValue(of({ role: 'employee', is_member: true, is_active: true }));
    const guard = makeGuard('manage');
    const req = { user: { userId: 'u-1' }, headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'SYSTEM_PERMISSION_DENIED' },
    });
    expect(getOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: '', user_id: 'u-1' }),
      expect.anything(),
    );
  });

  it('allows an owner/admin on a manage route', async () => {
    for (const role of ['platform_owner', 'platform_admin']) {
      getOrgRole.mockReturnValue(of({ role, is_member: true, is_active: true }));
      invalidateSystemAccessCache();
      const guard = makeGuard('manage');
      await expect(guard.canActivate(makeContext(memberReq('u-owner')))).resolves.toBe(true);
      expect(getOrgRole).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: 'sys-1', user_id: 'u-owner' }),
        expect.anything(),
      );
    }
  });

  it('denies a plain employee on a manage route (403 SYSTEM_PERMISSION_DENIED) — the whole point', async () => {
    getOrgRole.mockReturnValue(of({ role: 'employee', is_member: true, is_active: true }));
    const guard = makeGuard('manage');
    await expect(guard.canActivate(makeContext(memberReq('u-emp')))).rejects.toMatchObject({
      response: { code: 'SYSTEM_PERMISSION_DENIED' },
    });
  });

  it('allows a plain employee to READ system structure (member requirement)', async () => {
    getOrgRole.mockReturnValue(of({ role: 'employee', is_member: true, is_active: true }));
    const guard = makeGuard('member');
    await expect(guard.canActivate(makeContext(memberReq('u-emp')))).resolves.toBe(true);
  });

  it('denies a NON-member from reading system structure (403 SYSTEM_ACCESS_DENIED)', async () => {
    getOrgRole.mockReturnValue(of({ role: '', is_member: false, is_active: false }));
    const guard = makeGuard('member');
    await expect(guard.canActivate(makeContext(memberReq('stranger')))).rejects.toMatchObject({
      response: { code: 'SYSTEM_ACCESS_DENIED' },
    });
  });

  it('denies an offboarded (inactive) employee even with a manageable role', async () => {
    getOrgRole.mockReturnValue(of({ role: 'platform_admin', is_member: true, is_active: false }));
    const guard = makeGuard('member');
    await expect(guard.canActivate(makeContext(memberReq('u-gone')))).rejects.toMatchObject({
      response: { code: 'SYSTEM_ACCESS_DENIED' },
    });
  });

  it('denies when the request carries no user', async () => {
    const guard = makeGuard('manage');
    const req = { headers: {}, __systemOrgId: 'sys-1' };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'SYSTEM_ACCESS_DENIED' },
    });
    expect(getOrgRole).not.toHaveBeenCalled();
  });

  it('fail-closed: control outage while enforcing → 503 SYSTEM_ACCESS_CHECK_FAILED', async () => {
    getOrgRole.mockReturnValue(throwError(() => new Error('control down')));
    const guard = makeGuard('manage');
    const err = await guard.canActivate(makeContext(memberReq('u-1'))).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.response).toMatchObject({ code: 'SYSTEM_ACCESS_CHECK_FAILED' });
  });

  it('kill-switch: with enforcement disabled an outage does not deny', async () => {
    process.env.GATEWAY_ORG_ACCESS_ENFORCE = 'false';
    getOrgRole.mockReturnValue(throwError(() => new Error('control down')));
    const guard = makeGuard('manage');
    await expect(guard.canActivate(makeContext(memberReq('u-1')))).resolves.toBe(true);
  });

  it('cache hit: a second call within TTL does not re-resolve against control', async () => {
    process.env.GATEWAY_ORG_ACCESS_CACHE_TTL_MS = '30000';
    invalidateSystemAccessCache();
    getOrgRole.mockReturnValue(of({ role: 'platform_admin', is_member: true, is_active: true }));
    const guard = makeGuard('manage');
    await expect(guard.canActivate(makeContext(memberReq('u-1')))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(memberReq('u-1')))).resolves.toBe(true);
    expect(getOrgRole).toHaveBeenCalledTimes(1);
    invalidateSystemAccessCache();
  });

  it('denies with an unknown role even when marked a member (fail-closed on manage)', async () => {
    getOrgRole.mockReturnValue(of({ role: 'weird', is_member: true, is_active: true }));
    const guard = makeGuard('manage');
    await expect(guard.canActivate(makeContext(memberReq('u-x')))).rejects.toMatchObject({
      response: { code: 'SYSTEM_PERMISSION_DENIED' },
    });
  });
});
