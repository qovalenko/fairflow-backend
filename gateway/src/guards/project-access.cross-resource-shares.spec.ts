/**
 * TODO-109: the global-search route reads ACROSS shareable resources, but the guard
 * resolved a scope for exactly ONE `resource` — and `search` is not a shareable
 * resource, so it resolved with `resource: ''`, which makes control return NO
 * shares at all (`sharedRecordIds` is `[]` by construction there). A record shared
 * with the viewer was therefore visible on its own list route and unfindable in
 * global search.
 *
 * The guard now fans out over SHAREABLE_RESOURCES for cross-resource subjects and
 * stamps `sharedRecordIdsByType` (keyed by the canonical singular entity type) on
 * the scope it hands to the domain. Every other route must stay byte-identical.
 */
import { of, throwError } from 'rxjs';
import { parseVisibilityScope, VISIBILITY_SCOPE_MAX_IDS } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

describe('ProjectAccessGuard cross-resource shares (TODO-109)', () => {
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

  /** Shares control holds per resource for this viewer. */
  const SHARES: Record<string, string[]> = {
    contacts: ['c-9'],
    deals: ['d-1', 'd-2'],
  };

  /** Restricted scope; `resource` decides which shares control returns. */
  const restrictedFor = (resource: string) => ({
    allowed: true,
    role: 'member',
    mode: 'restricted',
    level: 'only_own',
    owner_ids: ['u-1'],
    shared_record_ids: SHARES[resource] ?? [],
    epoch: 1,
  });

  const req = () => ({ user: { userId: 'u-1' }, headers: {}, query: { projectId: 'p-1' } });

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';

    resolveRecordVisibility = jest.fn((d: { resource?: string }) =>
      of(restrictedFor(d.resource ?? '')),
    );
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() => of({ effective_modules: [], module_policies: [] }));
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    outboundMeta.build.mockClear();
    invalidateProjectAccessCache('p-1');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  const resourcesAsked = () =>
    resolveRecordVisibility.mock.calls.map((c) => (c[0] as { resource?: string }).resource).sort();

  it('the /search route carries the shares of every shareable resource, keyed by entity type', async () => {
    const guard = makeGuard({ subject: 'search', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.sharedRecordIdsByType).toEqual({ contact: ['c-9'], deal: ['d-1', 'd-2'] });
    // The primary decision itself is unchanged (still resolved for '' = no single
    // resource) — the map is additive.
    expect(scope?.mode).toBe('restricted');
    expect(scope?.ownerIds).toEqual(['u-1']);
    expect(scope?.resource).toBe('');
    expect(resourcesAsked()).toEqual([
      '',
      'activities',
      'companies',
      'contacts',
      'deals',
      'orders',
    ]);
  });

  it('an ordinary shareable route is untouched: one resolution, no per-type map', async () => {
    const guard = makeGuard({ subject: 'contacts', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.sharedRecordIdsByType).toBeUndefined();
    expect(scope?.sharedRecordIds).toEqual(['c-9']);
    expect(resourcesAsked()).toEqual(['contacts']);
  });

  it('mode "all" skips the fan-out entirely (nothing to narrow, nothing to widen)', async () => {
    resolveRecordVisibility = jest.fn(() =>
      of({
        allowed: true,
        role: 'owner',
        mode: 'all',
        owner_ids: [],
        shared_record_ids: [],
        epoch: 1,
      }),
    );
    const guard = makeGuard({ subject: 'search', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.mode).toBe('all');
    expect(scope?.sharedRecordIdsByType).toBeUndefined();
    expect(resourcesAsked()).toEqual(['']);
  });

  it('a DEFERRED scope is not half-filled: the domain must hydrate the whole scope', async () => {
    resolveRecordVisibility = jest.fn((d: { resource?: string }) =>
      of({
        ...restrictedFor(d.resource ?? ''),
        owner_ids: [],
        shared_record_ids: [],
        deferred: true,
        descriptor: {
          unit_ids: ['unit-1'],
          rule_kinds: ['own_groups'],
          uses_sharing: true,
          org_id: 'org-1',
        },
      }),
    );
    const guard = makeGuard({ subject: 'search', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.deferred).toBe(true);
    expect(scope?.sharedRecordIdsByType).toBeUndefined();
    expect(resourcesAsked()).toEqual(['']);
  });

  it('a map over the metadata budget is dropped whole, not truncated into a half-visible read', async () => {
    // control caps ONE resource at VISIBILITY_SCOPE_MAX_IDS (2000); five of them
    // would blow the ~8 KiB gRPC metadata budget and break search outright.
    const many = Array.from({ length: VISIBILITY_SCOPE_MAX_IDS + 1 }, (_, i) => `c-${i}`);
    resolveRecordVisibility = jest.fn((d: { resource?: string }) =>
      of({
        ...restrictedFor(d.resource ?? ''),
        shared_record_ids: d.resource === 'contacts' ? many : [],
      }),
    );
    const guard = makeGuard({ subject: 'search', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.sharedRecordIdsByType).toBeUndefined();
    // Own records still resolve — the degradation is "no shares", never "no scope".
    expect(scope?.ownerIds).toEqual(['u-1']);
  });

  it('an ops action on the same subject (search:manage) does not fan out — it returns no records', async () => {
    // `manage` is an admin-only action — resolve as an admin whose records are
    // still restricted, so only the action (not the role) decides the fan-out.
    resolveRecordVisibility = jest.fn((d: { resource?: string }) =>
      of({ ...restrictedFor(d.resource ?? ''), role: 'admin' }),
    );
    const guard = makeGuard({ subject: 'search', action: 'manage' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.sharedRecordIdsByType).toBeUndefined();
    expect(resourcesAsked()).toEqual(['']);
  });

  it('a failing fan-out call degrades to "no shares for that resource", it does not 503 the route', async () => {
    resolveRecordVisibility = jest.fn((d: { resource?: string }) =>
      d.resource === 'deals'
        ? throwError(() => new Error('control down'))
        : of(restrictedFor(d.resource ?? '')),
    );
    const guard = makeGuard({ subject: 'search', action: 'read' });
    const request = req();
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const scope = parseVisibilityScope(request['__visibilityScope' as never]);
    expect(scope?.sharedRecordIdsByType).toEqual({ contact: ['c-9'] });
  });
});
