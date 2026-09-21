/**
 * review-1 (gateway PEP): the guard must PRODUCE the cross-entity ABAC predicate
 * for the global-search route, not just be able to compile one.
 *
 * The wave materialized the ABAC attributes into the search index and made the
 * domain AND `x-access-predicate` into its read filter — but the header was never
 * emitted for `/search/query`, because the route's subject is `search` while the
 * rules are written for `deals`/`contacts`/… . The channel existed with no
 * producer: the defence looked enabled and was dead.
 *
 * These tests pin the producer end-to-end through `ProjectAccessGuard`, and pin
 * that every ordinary (single-subject) route is unaffected.
 */
import { of } from 'rxjs';
import { parseCompiledPredicate } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

describe('ProjectAccessGuard cross-entity ABAC predicate (review-1)', () => {
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

  const req = () => ({ user: { userId: 'u-1' }, headers: {}, query: { projectId: 'p-1' } });

  /**
   * "may read deals under a million" — a restricting conditional ALLOW, the shape
   * that actually reaches the ABAC push-down. (A conditional DENY never gets that
   * far today: `isDeniedByPolicy` matches ANY deny on the (subject, action) pair,
   * condition or not, so it 403s the module route outright — see the dedicated
   * test below, which pins that interaction rather than papering over it.)
   */
  const DEAL_AMOUNT_ALLOW = {
    effect: 'allow',
    subject: 'deals',
    action: 'read',
    resource: '*',
    condition: { op: 'lt', left: { ref: 'record.amount' }, right: { lit: 1_000_000 } },
  };

  const withPolicies = (module_policies: unknown[]) => {
    getProject = jest.fn(() => of({ effective_modules: [], module_policies }));
  };

  const predicateOf = (request: Record<string, unknown>) =>
    parseCompiledPredicate(request.__accessPredicate as string | undefined).mongo;

  const branchesOf = (mongo: Record<string, unknown> | null) => {
    expect(mongo).toBeTruthy();
    return (mongo!.$or as Record<string, unknown>[]) ?? [mongo!];
  };

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';

    resolveRecordVisibility = jest.fn(() =>
      of({
        allowed: true,
        role: 'member',
        mode: 'all',
        level: 'custom',
        owner_ids: [],
        shared_record_ids: [],
        epoch: 1,
      }),
    );
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    checkPermissions = jest.fn((req: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: req.checks.map((c) => ({ ...c, decision: 'allow', reason: 'OK' })),
        epoch: 1,
      }),
    );
    withPolicies([]);
    outboundMeta.build.mockClear();
    invalidateProjectAccessCache('p-1');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('AS-WAS regression: a deals ABAC rule now reaches /search/query (it used to be dropped)', async () => {
    withPolicies([DEAL_AMOUNT_ALLOW]);
    const request = req();
    await expect(
      makeGuard({ subject: 'search', action: 'read' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);

    const mongo = predicateOf(request as never);
    expect(mongo).toBeTruthy();
    expect(branchesOf(mongo)).toContainEqual({
      $and: [{ entityType: 'deal' }, { amount: { $lt: 1_000_000 } }],
    });
    // The other modules keep an open disjunct — the deals rule narrows deals only.
    expect(branchesOf(mongo)).toContainEqual({ entityType: 'contact' });
    expect(JSON.stringify(branchesOf(mongo))).toContain('"entityType":"product"');
  });

  it('a project-wide DENY on contacts:read removes contacts from the searchable types', async () => {
    withPolicies([{ effect: 'deny', subject: 'contacts', action: 'read', resource: '*' }]);
    const request = req();
    await expect(
      makeGuard({ subject: 'search', action: 'read' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);

    const branches = branchesOf(predicateOf(request as never));
    expect(JSON.stringify(branches)).not.toContain('"contact"');
    expect(branches).toContainEqual({ entityType: 'deal' });
  });

  it('emits no header when the project has no conditional rule and no DENY', async () => {
    const request = req();
    await expect(
      makeGuard({ subject: 'search', action: 'read' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    expect((request as Record<string, unknown>).__accessPredicate).toBeUndefined();
  });

  it('search:manage (status/reindex) keeps the single-subject path — it returns no rows', async () => {
    withPolicies([DEAL_AMOUNT_ALLOW]);
    // `manage` is an owner-only key (projectRoleCanKey) — the point of the test is
    // the predicate path, not the RBAC matrix.
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
    const request = req();
    await expect(
      makeGuard({ subject: 'search', action: 'manage' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    expect((request as Record<string, unknown>).__accessPredicate).toBeUndefined();
  });

  it('an ordinary single-subject route is byte-identical to before', async () => {
    withPolicies([DEAL_AMOUNT_ALLOW]);
    const request = req();
    await expect(
      makeGuard({ subject: 'deals', action: 'read' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    // No entityType guard, no $or fan-out — just the rule itself.
    expect(predicateOf(request as never)).toEqual({ amount: { $lt: 1_000_000 } });
  });

  /**
   * TODO-108 (fix/cursor-access): conditional denies are row-level ABAC, not blanket
   * module-policy blocks — `isDeniedByPolicy` ignores them so they compile into
   * `x-access-predicate` (and fail-closed when the domain cannot enforce them).
   * Search inherits the same per-subject narrowing instead of treating a conditional
   * deny as a type-wide removal.
   */
  it('a conditional DENY narrows the module route and search by the same rule', async () => {
    const conditionalDeny = { ...DEAL_AMOUNT_ALLOW, effect: 'deny' };
    withPolicies([conditionalDeny]);

    const dealsRequest = req();
    await expect(
      makeGuard({ subject: 'deals', action: 'read' }).canActivate(makeContext(dealsRequest)),
    ).resolves.toBe(true);
    expect(predicateOf(dealsRequest as never)).toEqual({
      $or: [{ $nor: [{ amount: { $lt: 1_000_000 } }] }, { ownerId: 'u-1' }],
    });

    const request = req();
    await expect(
      makeGuard({ subject: 'search', action: 'read' }).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    expect(branchesOf(predicateOf(request as never))).toContainEqual({
      $and: [{ entityType: 'deal' }, { $nor: [{ amount: { $lt: 1_000_000 } }] }],
    });
  });
});
