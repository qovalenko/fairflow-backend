import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';
import { MEMBERSHIP_ONLY_KEY } from './membership-only.decorator';
import { REQUIRED_SYSTEM_ROLE_KEY } from './require-system-role.decorator';

/**
 * Unit tests for the gateway project-isolation PEP. These exercise the real
 * decision logic (membership / role resolution / fail-closed) — the control
 * gRPC client and outbound-metadata builder are mocked, everything else runs
 * for real.
 */
describe('ProjectAccessGuard', () => {
  const OLD_ENV = { ...process.env };

  // --- test doubles -----------------------------------------------------------
  let resolveRecordVisibility: jest.Mock;
  let getProjectAccessEpoch: jest.Mock;
  let getProject: jest.Mock;
  /**
   * TODO-027: control's PDP (`RoleGrpc.CheckPermissions`). The default double
   * answers "allow" for every asked pair, so the pre-existing expectations here
   * keep measuring the flat-matrix layer; the granular layer has its own suite
   * (project-access.pdp.spec.ts).
   */
  let checkPermissions: jest.Mock;
  let resolveEffectivePermissions: jest.Mock;

  const control = {
    getService: () => ({
      resolveRecordVisibility,
      getProjectAccessEpoch,
      getProject,
      checkPermissions,
      resolveEffectivePermissions,
    }),
  };

  const outboundMeta = { build: jest.fn(() => ({})) };

  /**
   * Reflector stub: returns the @RequirePermission metadata (and, optionally, the
   * @SkipProjectScope marker) we hand it.
   */
  const makeReflector = (required?: unknown, skipProjectScope?: boolean) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === SKIP_PROJECT_SCOPE_KEY) return skipProjectScope;
      if (key === REQUIRED_SYSTEM_ROLE_KEY) return undefined;
      // TODO-056: tests without @RequirePermission model a @MembershipOnly route.
      if (key === MEMBERSHIP_ONLY_KEY) return required === undefined && !skipProjectScope;
      return undefined;
    }),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (required?: unknown) =>
    new ProjectAccessGuard(
      makeReflector(required) as never,
      control as never,
      outboundMeta as never,
    );

  /** Routes with no @RequirePermission and no @MembershipOnly (org/list/create). */
  const makeOpenGuard = () =>
    new ProjectAccessGuard(
      {
        getAllAndOverride: jest.fn((key: unknown) => {
          if (key === REQUIRED_PERMISSION_KEY) return undefined;
          if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
          if (key === REQUIRED_SYSTEM_ROLE_KEY) return undefined;
          if (key === MEMBERSHIP_ONLY_KEY) return false;
          return undefined;
        }),
      } as never,
      control as never,
      outboundMeta as never,
    );

  /** Guard whose route carries @SkipProjectScope (create-a-new-project et al). */
  const makeSkipGuard = (required?: unknown) =>
    new ProjectAccessGuard(
      makeReflector(required, true) as never,
      control as never,
      outboundMeta as never,
    );

  beforeEach(() => {
    // Disable all caches so every test re-resolves against the mock (correctness,
    // not cache behaviour, is what these tests assert).
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';

    resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'owner', epoch: 1 }));
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() =>
      of({ effective_modules: [], module_policies: [], status: 'active' }),
    );
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    resolveEffectivePermissions = jest.fn(() => of({ allow: ['chat:moderate'], epoch: 1 }));
    outboundMeta.build.mockClear();
    // Wipe cross-test cache state (module-level maps).
    invalidateProjectAccessCache('p-own');
    invalidateProjectAccessCache('p-foreign');
    invalidateProjectAccessCache('p-arch');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('passes through routes without a project context (no projectId)', async () => {
    const guard = makeOpenGuard();
    const req = { user: { userId: 'u-1' }, headers: {} };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    // No membership resolution attempted for a project-less route.
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  // TODO-018 (fail-closed): a @RequirePermission route with NO projectId anywhere
  // used to silently skip membership/RBAC/module checks (early `return true`).
  it('@RequirePermission route without any projectId → 400 PROJECT_ID_REQUIRED (fail-closed)', async () => {
    const guard = makeGuard({ subject: 'products', action: 'write' });
    const req = { user: { userId: 'u-1' }, headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ID_REQUIRED' },
    });
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  it('@MembershipOnly route without any projectId → 400 PROJECT_ID_REQUIRED (FR-PROJ-030)', async () => {
    const guard = makeGuard();
    const req = { user: { userId: 'u-1' }, headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ID_REQUIRED' },
    });
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  it('@SkipProjectScope + @RequirePermission without projectId keeps the pass-through', async () => {
    const guard = makeSkipGuard({ subject: 'project', action: 'write' });
    const req = { user: { userId: 'u-1' }, headers: {} };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('@SkipProjectScope: a foreign x-project-id header is ignored → pass-through, control not called (T-001-BE)', async () => {
    // Create-a-new-project: the client still carries the ambient (stale/foreign)
    // x-project-id header, but the route is marked @SkipProjectScope so the guard
    // must NOT derive the project from it → no membership resolution, no 403.
    const guard = makeSkipGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'fresh-user' },
      headers: { 'x-project-id': 'p-foreign' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
    expect(getProjectAccessEpoch).not.toHaveBeenCalled();
    // No role/scope resolved either — the route operates outside any project.
    expect(req.__projectRole).toBeUndefined();
  });

  it('@SkipProjectScope: an explicit :projectId path param still scopes (header-only is skipped)', async () => {
    // The marker only suppresses the HEADER fallback; a genuine path param wins,
    // so a marked route that DOES carry :projectId is still enforced normally.
    resolveRecordVisibility.mockReturnValue(of({ allowed: false, role: '', epoch: 1 }));
    const guard = makeSkipGuard();
    const req = {
      user: { userId: 'u-1' },
      params: { projectId: 'p-foreign' },
      headers: { 'x-project-id': 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ACCESS_DENIED' },
    });
    expect(resolveRecordVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p-foreign' }),
      expect.anything(),
    );
  });

  it('unmarked route: header behaviour is unchanged — membership is still resolved', async () => {
    // Regression guard: a normal (non-skip) route with an x-project-id header must
    // keep enforcing membership exactly as before the T-001-BE fix.
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    const guard = makeGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.__projectRole).toBe('manager');
    expect(resolveRecordVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p-own', user_id: 'u-1' }),
      expect.anything(),
    );
  });

  it('allows a member of their own project and resolves the real role', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    const guard = makeGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.__projectRole).toBe('manager');
    // The membership check was scoped to the requested project + user.
    expect(resolveRecordVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p-own', user_id: 'u-1' }),
      expect.anything(),
    );
  });

  it('denies a non-member (allowed=false) with PROJECT_ACCESS_DENIED', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: false, role: '', epoch: 1 }));
    const guard = makeGuard();
    const req = { user: { userId: 'stranger' }, headers: { 'x-project-id': 'p-foreign' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ACCESS_DENIED' },
    });
  });

  it('FR-PROJ-120: mutating route on archived project → PROJECT_READ_ONLY', async () => {
    getProject.mockReturnValue(
      of({ effective_modules: [], module_policies: [], status: 'archived' }),
    );
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'owner', epoch: 1 }));
    const guard = makeGuard({ subject: 'project', action: 'manage' });
    const req = {
      user: { userId: 'u-1' },
      method: 'PATCH',
      url: '/api/v1/projects/p-own',
      headers: { 'x-project-id': 'p-own' },
      params: { projectId: 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_READ_ONLY' },
    });
  });

  it('FR-PROJ-120: lifecycle restore on archived project is exempt from read-only', async () => {
    getProject.mockReturnValue(
      of({ effective_modules: [], module_policies: [], status: 'archived' }),
    );
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'owner', epoch: 1 }));
    const guard = makeGuard({ subject: 'project', action: 'manage' });
    const req = {
      user: { userId: 'u-1' },
      method: 'POST',
      url: '/api/v1/projects/p-own/restore',
      headers: { 'x-project-id': 'p-own' },
      params: { projectId: 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('FR-PROJ-120: record-level /restore (deals) is NOT exempt — archived project stays read-only', async () => {
    // The exemption is anchored to /projects/:id/<transition>; a CRM route that
    // merely shares the suffix must still be blocked on an archived project.
    getProject.mockReturnValue(
      of({ effective_modules: [], module_policies: [], status: 'archived' }),
    );
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'owner', epoch: 1 }));
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req = {
      user: { userId: 'u-1' },
      method: 'POST',
      url: '/api/v1/deals/d-1/restore',
      headers: { 'x-project-id': 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_READ_ONLY' },
    });
  });

  it('FR-PROJ-120: phase check runs AFTER membership — non-member on archived project gets PROJECT_ACCESS_DENIED, not PROJECT_READ_ONLY', async () => {
    getProject.mockReturnValue(
      of({ effective_modules: [], module_policies: [], status: 'archived' }),
    );
    resolveRecordVisibility.mockReturnValue(of({ allowed: false, role: '', epoch: 1 }));
    const guard = makeGuard({ subject: 'project', action: 'manage' });
    const req = {
      user: { userId: 'stranger' },
      method: 'PATCH',
      url: '/api/v1/projects/p-foreign',
      headers: { 'x-project-id': 'p-foreign' },
      params: { projectId: 'p-foreign' },
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ACCESS_DENIED' },
    });
  });

  it('cross-tenant: a foreign projectId in the header is resolved as that project (isolation boundary is the resolver)', async () => {
    // A user asking for a project they are not in must be denied — the guard
    // always resolves against the header project, never trusts the caller.
    resolveRecordVisibility.mockReturnValue(of({ allowed: false, role: '', epoch: 1 }));
    const guard = makeGuard();
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-foreign' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(resolveRecordVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p-foreign' }),
      expect.anything(),
    );
  });

  it('denies when a projectId is present but the request carries no user', async () => {
    const guard = makeGuard();
    const req = { headers: { 'x-project-id': 'p-own' } }; // no user
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PROJECT_ACCESS_DENIED' },
    });
    // Never even reached the membership resolver.
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  it('fail-closed: control outage while enforcing throws PROJECT_ACCESS_CHECK_FAILED (503)', async () => {
    resolveRecordVisibility.mockReturnValue(throwError(() => new Error('control down')));
    const guard = makeGuard();
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    const err = await guard.canActivate(makeContext(req)).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.response).toMatchObject({ code: 'PROJECT_ACCESS_CHECK_FAILED' });
  });

  it('fail-open kill-switch: with enforcement disabled an outage does not deny', async () => {
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'false';
    resolveRecordVisibility.mockReturnValue(throwError(() => new Error('control down')));
    const guard = makeGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-own' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    // Role falls back to empty (no decision could be resolved).
    expect(req.__projectRole).toBe('');
  });

  it('enforces RBAC: a role that cannot perform the required action is denied', async () => {
    // member cannot delete deals per the RBAC matrix → PERMISSION_DENIED.
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'member', epoch: 1 }));
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED', subject: 'deals', action: 'delete' },
    });
  });

  // Granular member grant (owner decision 2026-08-16): member generates
  // documents via the key allow-list, WITHOUT gaining `execute` on any other
  // subject (the trap: a flat `execute` for member would widen
  // automation:execute / companies:execute too).
  it('granular grant: member passes @RequirePermission(documents.generate, execute)', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'member', epoch: 1 }));
    const guard = makeGuard({ subject: 'documents.generate', action: 'execute' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('granular grant does NOT widen: member is still denied execute on automation', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'member', epoch: 1 }));
    const guard = makeGuard({ subject: 'automation', action: 'execute' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED', subject: 'automation', action: 'execute' },
    });
  });

  it('granular grant does NOT leak to viewer on the same key', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'viewer', epoch: 1 }));
    const guard = makeGuard({ subject: 'documents.generate', action: 'execute' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED' },
    });
  });

  it('module-policy DENY overlay still beats the granular grant', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'member', epoch: 1 }));
    getProject.mockReturnValue(
      of({
        effective_modules: [],
        module_policies: [{ effect: 'deny', subject: 'documents.generate', action: 'execute' }],
      }),
    );
    const guard = makeGuard({ subject: 'documents.generate', action: 'execute' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });
  });

  it('TODO-056: project-scoped route without any permission marker → 403', async () => {
    const reflector = {
      getAllAndOverride: jest.fn(() => undefined),
    };
    const guard = new ProjectAccessGuard(
      reflector as never,
      control as never,
      outboundMeta as never,
    );
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'ROUTE_PERMISSION_MARKER_REQUIRED' },
    });
  });

  it('module-policy DENY overlay blocks an otherwise-permitted action (non-owner)', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    getProject.mockReturnValue(
      of({
        effective_modules: [],
        module_policies: [{ effect: 'deny', subject: 'deals', action: 'delete' }],
      }),
    );
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req = { user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });
  });

  describe('NFR-560 — BOX deploy config for GATEWAY_PROJECT_ACCESS_ENFORCE', () => {
    const BOX_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...BOX_ENV };
    });

    it('requires explicit true on startup in BOX edition', () => {
      process.env.FAIRFLOW_EDITION = 'box';
      delete process.env.GATEWAY_PROJECT_ACCESS_ENFORCE;
      const guard = makeGuard();
      expect(() => guard.onModuleInit()).toThrow(/NFR-560/);
    });

    it('allows startup when deploy config sets true in BOX edition', () => {
      process.env.FAIRFLOW_EDITION = 'box';
      process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
      const guard = makeGuard();
      expect(() => guard.onModuleInit()).not.toThrow();
    });

    it('rejects false on startup in BOX edition (FR-PROJ-065)', () => {
      process.env.FAIRFLOW_EDITION = 'box';
      process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'false';
      const guard = makeGuard();
      expect(() => guard.onModuleInit()).toThrow(/FR-PROJ-065/);
    });

    it('does not require explicit true in cloud edition', () => {
      process.env.FAIRFLOW_EDITION = 'cloud';
      delete process.env.GATEWAY_PROJECT_ACCESS_ENFORCE;
      const guard = makeGuard();
      expect(() => guard.onModuleInit()).not.toThrow();
    });
  });
});
