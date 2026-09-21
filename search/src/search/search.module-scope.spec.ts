/**
 * [review-1] FR-MSRCH-11 — the enabled-modules type gate is THREE-state, and the
 * middle state is the one that matters.
 *
 * `/search/query` deliberately carries no @RequireModule('search') (T-018: search
 * is a cross-cutting capability; no project enables a `search` module, so the
 * class gate 403'd every query). The compensating control is this intersection —
 * the read is narrowed to the project's enabled entity types INSIDE the domain.
 * That makes the semantics of an empty set load-bearing:
 *   - `undefined` (no x-enabled-modules at all) → old contract, no narrowing;
 *   - `[]` (gateway resolved the set; it is empty) → nothing searchable.
 * Reading `[]` as "don't filter" made the only gate on the route vanish exactly
 * when the gateway degraded.
 */
import type { VisibilityScope } from '@fairflow/shared';
import { GW_METADATA } from '@fairflow/shared';
import { SearchService } from './search.service';
import { SearchGrpcController } from './search.grpc.controller';
import { buildMongo } from './fake-mongo.testkit';

const PID = 'proj-1';

const SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: ['user-1'],
  sharedRecordIds: [],
};

/** One contact + one deal, both visible to the viewer, both matching "acme". */
async function seed(svc: SearchService) {
  await svc.projectUpsert({
    projectId: PID,
    entityType: 'contact',
    entityId: 'c-1',
    title: 'Acme contact',
    ownerId: 'user-1',
    sourceUpdatedAt: 10,
    version: 10,
  });
  await svc.projectUpsert({
    projectId: PID,
    entityType: 'deal',
    entityId: 'd-1',
    title: 'Acme deal',
    ownerId: 'user-1',
    sourceUpdatedAt: 10,
    version: 10,
  });
}

const found = (res: { groups: Array<{ list: Array<{ entity_type: string }> }> }) =>
  res.groups
    .flatMap((g) => g.list)
    .map((h) => h.entity_type)
    .sort();

async function newService() {
  const { mongo } = buildMongo({});
  const svc = new SearchService(mongo as never);
  await seed(svc);
  return svc;
}

describe('enabled-modules type gate (FR-MSRCH-11) — three states', () => {
  it('undefined (no header): no module narrowing — the pre-header contract', async () => {
    const svc = await newService();
    const res = await svc.search(PID, 'acme', 0, 25, { ctx: { scope: SCOPE } });
    expect(found(res)).toEqual(['contact', 'deal']);
    expect(res.total).toBe(2);
  });

  it('populated set: only the enabled modules’ entity types are searched', async () => {
    const svc = await newService();
    const res = await svc.search(PID, 'acme', 0, 25, {
      ctx: { scope: SCOPE, enabledModules: ['contacts'] },
    });
    expect(found(res)).toEqual(['contact']);
    expect(res.total_by_type).toEqual({ contact: 1 });
  });

  it('EXPLICIT empty set: nothing is enabled → nothing is searchable (fail-closed)', async () => {
    const svc = await newService();
    const res = await svc.search(PID, 'acme', 0, 25, {
      ctx: { scope: SCOPE, enabledModules: [] },
    });
    expect(res.total).toBe(0);
    expect(found(res)).toEqual([]);
    expect(res.total_by_type).toEqual({});
  });

  it('an explicitly requested entityType cannot re-enable a disabled module', async () => {
    const svc = await newService();
    const res = await svc.search(PID, 'acme', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: SCOPE, enabledModules: ['contacts'] },
    });
    expect(res.total).toBe(0);
  });
});

describe('SearchGrpcController — x-enabled-modules maps onto the context three-state', () => {
  const stub = () => ({
    search: jest.fn().mockResolvedValue({ list: [], total: 0, groups: [], total_by_type: {} }),
  });

  const metadata = (enabledModules?: string) =>
    ({
      get: (key: string) => {
        if (key === GW_METADATA.PROJECT_ID) return [PID];
        if (key === GW_METADATA.ENABLED_MODULES && enabledModules !== undefined) {
          return [enabledModules];
        }
        return [];
      },
    }) as never;

  const ctxOf = (svc: ReturnType<typeof stub>) =>
    (svc.search.mock.calls[0][4] as { ctx: { enabledModules?: string[] } }).ctx;

  it('absent header → ctx.enabledModules stays undefined (no narrowing)', async () => {
    const svc = stub();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);
    await ctrl.query({ query: 'acme' }, metadata());
    expect(ctxOf(svc).enabledModules).toBeUndefined();
  });

  it('"[]" → ctx.enabledModules is an empty array (explicitly nothing enabled)', async () => {
    const svc = stub();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);
    await ctrl.query({ query: 'acme' }, metadata('[]'));
    expect(ctxOf(svc).enabledModules).toEqual([]);
  });

  it('populated header → ctx.enabledModules carries the set', async () => {
    const svc = stub();
    const ctrl = new SearchGrpcController(svc as unknown as SearchService);
    await ctrl.query({ query: 'acme' }, metadata('["contacts","deals"]'));
    expect(ctxOf(svc).enabledModules).toEqual(['contacts', 'deals']);
  });
});
