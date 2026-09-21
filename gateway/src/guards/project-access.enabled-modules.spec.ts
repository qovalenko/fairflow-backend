/**
 * [review-1] `x-enabled-modules` must never silently disappear on a project-scoped
 * route.
 *
 * Why this is a security test and not hygiene: /search/query deliberately carries
 * NO @RequireModule('search') (T-018 — search is cross-cutting and no project
 * enables a `search` module), so the only module gate on that read is the domain's
 * `entityType ∩ enabledModules` intersection. That gate exists only while the
 * header exists. ProjectAccessGuard's policy resolution is best-effort and used to
 * leave `__enabledModules` unset when control was unreachable and the project had
 * no last-known-good — the header vanished and the gate with it, at the exact
 * moment every other route fails closed.
 */
import { of, throwError } from 'rxjs';
import { ensureLockedModules } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';
import { MEMBERSHIP_ONLY_KEY } from './membership-only.decorator';
import { REQUIRED_SYSTEM_ROLE_KEY } from './require-system-role.decorator';

describe('ProjectAccessGuard — x-enabled-modules is always resolved', () => {
  const OLD_ENV = { ...process.env };

  let resolveRecordVisibility: jest.Mock;
  let getProjectAccessEpoch: jest.Mock;
  let getProject: jest.Mock;
  let checkPermissions: jest.Mock;

  const control = {
    getService: () => ({
      resolveRecordVisibility,
      getProjectAccessEpoch,
      getProject,
      checkPermissions,
    }),
  };
  const outboundMeta = { build: jest.fn(() => ({})) };

  const makeReflector = (required?: unknown) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
      if (key === REQUIRED_SYSTEM_ROLE_KEY) return undefined;
      if (key === MEMBERSHIP_ONLY_KEY) return required === undefined;
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

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
    resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'owner', epoch: 1 }));
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() => of({ effective_modules: ['contacts'], module_policies: [] }));
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    outboundMeta.build.mockClear();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('healthy control: the real effective set lands on the request', async () => {
    invalidateProjectAccessCache('p-em-ok');
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-em-ok' },
    };
    await expect(makeGuard().canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.__enabledModules).toEqual(expect.arrayContaining(['contacts']));
  });

  it('control unreachable and NO last-known-good: falls back to the locked/system set, never undefined', async () => {
    invalidateProjectAccessCache('p-em-outage');
    getProject.mockReturnValue(throwError(() => new Error('control down')));
    const req: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-em-outage' },
    };

    await expect(makeGuard().canActivate(makeContext(req))).resolves.toBe(true);

    // The header is emitted (defined array), so the domain-side gate stays armed;
    // only locked modules — enabled by definition for every project — survive the
    // outage, mirroring GatewayModuleGuard's own degraded fallback.
    expect(Array.isArray(req.__enabledModules)).toBe(true);
    expect(req.__enabledModules).toEqual(ensureLockedModules([]));
    expect(req.__enabledModules).not.toContain('contacts');
  });

  it('the module-guard snapshot seeds the last-known-good, so a later outage replays the REAL set (not [])', async () => {
    invalidateProjectAccessCache('p-em-lkg');
    // Request 1: GatewayModuleGuard ran first — snapshot + resolved modules present.
    const first: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-em-lkg' },
      __policySnapshot: '[]',
      __enabledModules: ['contacts', 'deals'],
    };
    await expect(makeGuard().canActivate(makeContext(first))).resolves.toBe(true);
    expect(getProject).not.toHaveBeenCalled();

    // Request 2: a route the module guard skips, with control down. The LKG must
    // carry the modules seen in request 1 — storing `[]` there used to blank the
    // set out for the whole project.
    getProject.mockReturnValue(throwError(() => new Error('control down')));
    const second: Record<string, unknown> = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p-em-lkg' },
    };
    await expect(makeGuard().canActivate(makeContext(second))).resolves.toBe(true);
    expect(second.__enabledModules).toEqual(['contacts', 'deals']);
  });
});
