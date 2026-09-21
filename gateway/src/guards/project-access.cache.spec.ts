import { of, throwError } from 'rxjs';
import { parseCompiledPredicate } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';
import { MEMBERSHIP_ONLY_KEY } from './membership-only.decorator';
import { REQUIRED_SYSTEM_ROLE_KEY } from './require-system-role.decorator';

/**
 * Component coverage (QA-CI T-036.3, gateway P0) for the K3-invalidation caching
 * layers of the project-isolation PEP: the epoch / access-decision / module-policy
 * caches, the fail-closed policy last-known-good replay, the deferred-scope
 * descriptor, ABAC predicate serialisation into `x-access-predicate`, and the
 * effective-module extraction fallbacks. The base membership/RBAC path is covered
 * by project-access.guard.spec.ts — this file exercises the surrounding machinery
 * the first suite disables (it runs with every cache TTL=0).
 */
describe('ProjectAccessGuard caching & policy layers', () => {
  const OLD_ENV = { ...process.env };

  let resolveRecordVisibility: jest.Mock;
  let getProjectAccessEpoch: jest.Mock;
  let getProject: jest.Mock;
  // TODO-027: control's PDP (RoleGrpc.CheckPermissions). This suite is about the
  // caching/policy machinery, so the granular layer just echoes "allow".
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

  const makeReflector = (required?: unknown, skipProjectScope?: boolean) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === SKIP_PROJECT_SCOPE_KEY) return skipProjectScope;
      if (key === REQUIRED_SYSTEM_ROLE_KEY) return undefined;
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

  /** Set every cache TTL individually; a test opts into just the cache it exercises. */
  const setTtls = (
    opts: { access?: string; policy?: string; epoch?: string; pdp?: string } = {},
  ) => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = opts.access ?? '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = opts.policy ?? '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = opts.epoch ?? '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = opts.pdp ?? '0';
  };

  beforeEach(() => {
    setTtls();
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
    resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'owner', epoch: 1 }));
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() => of({ effective_modules: [], module_policies: [] }));
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    resolveEffectivePermissions = jest.fn(() => of({ allow: [], epoch: 1 }));
    outboundMeta.build.mockClear();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('serves the access decision from cache within TTL while the epoch matches', async () => {
    setTtls({ access: '30000' });
    invalidateProjectAccessCache('p-cache');
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-cache' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    // Second request hit the decision cache — the resolver ran only once.
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the project access epoch is bumped (K3 invalidation)', async () => {
    setTtls({ access: '30000' });
    invalidateProjectAccessCache('p-epoch');
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-epoch' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(1);

    // An access mutation bumps the epoch → the cached decision no longer matches.
    getProjectAccessEpoch.mockReturnValue(of({ epoch: 2 }));
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(2);
  });

  it('caches the current epoch so it is not re-read within its TTL', async () => {
    setTtls({ epoch: '30000' });
    invalidateProjectAccessCache('p-epochcache');
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-epochcache' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    // Only one epoch round-trip across both requests.
    expect(getProjectAccessEpoch).toHaveBeenCalledTimes(1);
  });

  it('fail-closed: an epoch read failure forces re-resolution (sentinel never matches)', async () => {
    setTtls({ access: '30000', epoch: '30000' });
    invalidateProjectAccessCache('p-epochfail');
    getProjectAccessEpoch.mockReturnValue(throwError(() => new Error('epoch down')));
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-epochfail' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    // The negative sentinel is never cached and never equals a stored epoch (>=0),
    // so both requests re-resolve the decision.
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(2);
  });

  it('carries a deferred oversized scope + descriptor through as a serialized x-visibility-scope', async () => {
    invalidateProjectAccessCache('p-deferred');
    resolveRecordVisibility.mockReturnValue(
      of({
        allowed: true,
        role: 'member',
        epoch: 1,
        deferred: true,
        descriptor: {
          unit_ids: ['un-1'],
          led_unit_ids: ['un-lead'],
          selected_group_ids: ['grp-1'],
          rule_kinds: ['unit'],
          uses_sharing: true,
          org_id: 'org-1',
        },
      }),
    );
    const guard = makeGuard({ subject: 'deals', action: 'read' });
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-deferred' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(typeof req.__visibilityScope).toBe('string');
    expect((req.__visibilityScope as string).length).toBeGreaterThan(0);
  });

  it('reuses the module-guard policy snapshot instead of re-fetching getProject', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    invalidateProjectAccessCache('p-snap');
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-snap' },
      // GatewayModuleGuard ran first and attached the project's policy snapshot.
      __policySnapshot: JSON.stringify([{ effect: 'deny', subject: 'deals', action: 'delete' }]),
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });
    // The snapshot was authoritative — no getProject round-trip.
    expect(getProject).not.toHaveBeenCalled();
  });

  it('serves module policies from the policy cache within TTL', async () => {
    setTtls({ policy: '30000' });
    invalidateProjectAccessCache('p-polcache');
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-polcache' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    // Second request served the policy overlay from cache.
    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it('fail-closed policies: replays the last-known-good DENY set on a control outage', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    setTtls();
    const PROJECT = 'p-lkg-' + Math.random().toString(36).slice(2);
    // 1st request: getProject succeeds and seeds the last-known-good DENY rule.
    getProject.mockReturnValueOnce(
      of({
        effective_modules: [],
        module_policies: [
          { effect: 'deny', subject: 'deals', action: 'delete' },
          { effect: 'allow', subject: 'deals', action: 'read' },
        ],
      }),
    );
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': PROJECT } });

    await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });

    // 2nd request: control is now down. The DENY must NOT be dropped (fail-closed).
    getProject.mockReturnValue(throwError(() => new Error('control down')));
    await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });
  });

  it('fail-closed policies: FULL outage (epoch unreadable, sentinel -1) still replays the DENY set within TTL', async () => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role: 'manager', epoch: 1 }));
    setTtls();
    const PROJECT = 'p-lkg-full-' + Math.random().toString(36).slice(2);
    // 1st request: control is healthy and seeds the last-known-good DENY rule at epoch 1.
    getProject.mockReturnValueOnce(
      of({
        effective_modules: [],
        module_policies: [{ effect: 'deny', subject: 'deals', action: 'delete' }],
      }),
    );
    const guard = makeGuard({ subject: 'deals', action: 'delete' });
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': PROJECT } });

    await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });

    // 2nd request: control is FULLY down — getProject AND the epoch read fail, so the
    // epoch resolves to the -1 sentinel. The TTL-fresh DENY set must still replay
    // (TODO-304 gates on a KNOWN different epoch, not on "freshness unconfirmable").
    getProject.mockReturnValue(throwError(() => new Error('control down')));
    getProjectAccessEpoch.mockReturnValue(throwError(() => new Error('control down')));
    await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
      response: { code: 'MODULE_POLICY_DENIED' },
    });
  });

  it('compiles conditional module policies into a serialized x-access-predicate', async () => {
    invalidateProjectAccessCache('p-abac');
    getProject.mockReturnValue(
      of({
        effective_modules: [],
        module_policies: [
          {
            effect: 'allow',
            subject: 'deals',
            action: 'read',
            resource: '*',
            condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
          },
        ],
      }),
    );
    const guard = makeGuard({ subject: 'deals', action: 'read' });
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-abac' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(typeof req.__accessPredicate).toBe('string');
    const compiled = parseCompiledPredicate(req.__accessPredicate as string);
    expect(compiled.mongo).toEqual({ amount: { $lt: 1_000_000 } });
  });

  it('propagates effective modules from module_configs (enabled flag honoured)', async () => {
    invalidateProjectAccessCache('p-cfg');
    getProject.mockReturnValue(
      of({
        module_configs: [
          { module_id: 'orders', enabled: true },
          { module_id: 'products', enabled: false },
        ],
      }),
    );
    const guard = makeGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-cfg' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    const modules = req.__enabledModules as string[];
    expect(modules).toContain('orders');
    expect(modules).not.toContain('products');
  });

  it('propagates effective modules from a bare modules[] list (dependency-resolved)', async () => {
    invalidateProjectAccessCache('p-mods');
    getProject.mockReturnValue(of({ modules: ['orders'] }));
    const guard = makeGuard();
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-mods' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    const modules = req.__enabledModules as string[];
    expect(modules).toContain('orders');
    // orders depends on the locked `deals` module → resolved transitively.
    expect(modules).toContain('deals');
  });

  it('pass-through when a projectId is present but there is no user and enforcement is off', async () => {
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'false';
    const guard = makeGuard();
    const req = { headers: { 'x-project-id': 'p-nouser' } };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  it('invalidateProjectAccessCache(projectId, userId) evicts only that user and forces re-resolve', async () => {
    setTtls({ access: '30000' });
    invalidateProjectAccessCache('p-inv');
    const guard = makeGuard();
    const req = () => ({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-inv' } });

    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(1);

    invalidateProjectAccessCache('p-inv', 'u-1');
    await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    expect(resolveRecordVisibility).toHaveBeenCalledTimes(2);
  });
});
