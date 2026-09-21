import { of, throwError } from 'rxjs';
import { parseVisibilityScope } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { REQUIRED_DONOR_SUBJECTS_KEY } from './require-donor-subjects.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

/**
 * FR-COMPANIES-375 — per-donor visibility on composite (card) routes.
 *
 * `GET /companies/:id/card` serves data owned by four other modules. The guard
 * resolves the route's own subject (`companies`) — so before this, the composite
 * handed the companies scope + companies ABAC predicate to contact/pipe/orders/
 * activity, and `companies:read` silently became the read gate of four modules.
 * These tests pin the donor subjects being resolved INDEPENDENTLY and fail-closed.
 */
describe('ProjectAccessGuard — @RequireDonorSubjects (FR-COMPANIES-375)', () => {
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

  const makeReflector = (required?: unknown, donors?: string[]) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === REQUIRED_DONOR_SUBJECTS_KEY) return donors;
      if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
      return undefined;
    }),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (donors?: string[]) =>
    new ProjectAccessGuard(
      makeReflector({ subject: 'companies', action: 'read' }, donors) as never,
      control as never,
      outboundMeta as never,
    );

  const request = () => ({ query: { projectId: 'p1' }, headers: {}, user: { userId: 'u1' } });

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
    invalidateProjectAccessCache('p1');
    outboundMeta.build.mockClear();
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    // Donor gating is module-aware: a donor whose module is off contributes null,
    // so the fixture enables every module the tests fan out to.
    getProject = jest.fn(() =>
      of({
        effective_modules: ['companies', 'contacts', 'deals', 'orders', 'activities'],
        module_policies: [],
      }),
    );
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    // Every resource gets its OWN owner set — that is the whole point: `companies`
    // visibility is wide, `deals` visibility is narrow.
    resolveRecordVisibility = jest.fn((req: { resource?: string }) =>
      of({
        allowed: true,
        role: 'member',
        level: 'custom',
        mode: 'restricted',
        owner_ids: [`owner-of-${req.resource || 'none'}`],
        epoch: 1,
      }),
    );
  });

  it('резолвит scope на КАЖДЫЙ донорский субъект отдельно, а не переиспользует companies', async () => {
    const req = request();
    await makeGuard(['contacts', 'deals', 'orders', 'activities']).canActivate(
      makeContext(req) as never,
    );

    const resources = resolveRecordVisibility.mock.calls.map((c) => c[0].resource);
    expect(resources).toEqual(
      expect.arrayContaining(['companies', 'contacts', 'deals', 'orders', 'activities']),
    );

    const donors = (req as unknown as { __donorAccess?: Record<string, { scope: string } | null> })
      .__donorAccess;
    expect(Object.keys(donors ?? {}).sort()).toEqual(['activities', 'contacts', 'deals', 'orders']);
    // Каждый донор несёт свои ownerIds — companies-скоуп до них не доезжает.
    expect(parseVisibilityScope(donors!.deals!.scope)?.ownerIds).toEqual(['owner-of-deals']);
    expect(parseVisibilityScope(donors!.contacts!.scope)?.ownerIds).toEqual(['owner-of-contacts']);
    expect(parseVisibilityScope(donors!.deals!.scope)?.resource).toBe('deals');
    // …и ни один из них не равен скоупу маршрута.
    const routeScope = (req as unknown as { __visibilityScope?: string }).__visibilityScope;
    expect(parseVisibilityScope(routeScope)?.ownerIds).toEqual(['owner-of-companies']);
    expect(donors!.deals!.scope).not.toBe(routeScope);
  });

  it('project-wide DENY на deals:read гасит ТОЛЬКО донора deals', async () => {
    getProject = jest.fn(() =>
      of({
        effective_modules: ['companies', 'contacts', 'deals'],
        module_policies: [{ effect: 'deny', subject: 'deals', action: 'read' }],
      }),
    );
    const req = request();
    await makeGuard(['contacts', 'deals']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.deals).toBeNull();
    expect(donors!.contacts).not.toBeNull();
  });

  it('fail-closed: недоступный control по донору ⇒ null, а не скоуп маршрута', async () => {
    resolveRecordVisibility = jest.fn((r: { resource?: string }) =>
      r.resource === 'orders'
        ? throwError(() => new Error('control down'))
        : of({ allowed: true, role: 'member', mode: 'restricted', owner_ids: ['u1'], epoch: 1 }),
    );
    const req = request();
    await makeGuard(['orders', 'deals']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.orders).toBeNull();
    expect(donors!.deals).not.toBeNull();
  });

  it('не участник по донорскому ресурсу ⇒ null', async () => {
    resolveRecordVisibility = jest.fn((r: { resource?: string }) =>
      of({
        allowed: r.resource !== 'activities',
        role: 'member',
        mode: 'restricted',
        owner_ids: ['u1'],
        epoch: 1,
      }),
    );
    const req = request();
    await makeGuard(['activities', 'contacts']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.activities).toBeNull();
    expect(donors!.contacts).not.toBeNull();
  });

  it('маршрут без @RequireDonorSubjects не получает __donorAccess (ничего не меняется)', async () => {
    const req = request();
    await makeGuard(undefined).canActivate(makeContext(req) as never);
    expect((req as unknown as { __donorAccess?: unknown }).__donorAccess).toBeUndefined();
  });

  it('адресный PDP-deny на deals:read гасит донора deals, не трогая маршрут и других доноров', async () => {
    // TODO-027 симметрия: PermissionGrant{effect:'deny'} 403-ит /v1/deals — тот же
    // вердикт обязан оставить пустым и блок deals в композитной карточке.
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) =>
          c.subject === 'deals'
            ? { ...c, decision: 'deny', reason: 'GRANT_DENY' }
            : { ...c, decision: 'allow', reason: 'OK' },
        ),
        epoch: 1,
      }),
    );
    const req = request();
    await makeGuard(['contacts', 'deals']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.deals).toBeNull();
    expect(donors!.contacts).not.toBeNull();
  });

  it('PDP недоступен по донору ⇒ null (fail-closed), остальные доноры живы', async () => {
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      req.checks[0]?.subject === 'orders'
        ? throwError(() => new Error('pdp down'))
        : of({
            decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
            epoch: 1,
          }),
    );
    const req = request();
    await makeGuard(['orders', 'contacts']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.orders).toBeNull();
    expect(donors!.contacts).not.toBeNull();
  });

  it('выключенный модуль донора ⇒ null, как 403 @RequireModule на его собственном маршруте', async () => {
    getProject = jest.fn(() =>
      of({
        effective_modules: ['companies', 'contacts', 'deals'], // activities выключен
        module_policies: [],
      }),
    );
    const req = request();
    await makeGuard(['activities', 'contacts']).canActivate(makeContext(req) as never);

    const donors = (req as unknown as { __donorAccess?: Record<string, unknown> }).__donorAccess;
    expect(donors!.activities).toBeNull();
    expect(donors!.contacts).not.toBeNull();
  });
});
