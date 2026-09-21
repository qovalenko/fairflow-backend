/**
 * [#19 / T1.5] Perf & correctness: deferred-scope hydration on a "fat" org
 * (>2000 owners — here 5000). No Docker / Mongo / live gRPC: the control client
 * is mocked and `buildVisibilityFilter` runs exactly as `pipe.service` does
 * (OWNER_FIELD=assigneeId, resource=deals). This exercises the same per-request
 * path a `listDeals`/`getKanban`/`getDashboard` call takes: the APP_GUARD
 * hydrates the deferred `x-visibility-scope` in metadata BEFORE the handler, then
 * the handler's `readVisibilityScope(metadata)` + `buildVisibilityFilter` see the
 * resolved 5000-id list.
 *
 * Asserts (task T1.5):
 *  (a) cold request → control resolved 1×, scope hydrated, filter is $in of 5000;
 *  (b) warm request same (projectId,userId,resource,epoch) → cache hit, control 0×;
 *  (c) epoch bump → re-resolve (miss);
 *  (d) warm local phase (cache hit + parse + build filter) budget on 5000 ids;
 *  (e) deferred WITHOUT descriptor → deny-all preserved (fail-closed invariant).
 */
import { performance } from 'node:perf_hooks';
import { Metadata } from '@grpc/grpc-js';
import { of } from 'rxjs';
import {
  DeferredScopeHydrator,
  VisibilityScopeHydrationGuard,
  GW_METADATA,
  buildVisibilityFilter,
  parseVisibilityScope,
  serializeVisibilityScope,
  type HydrateResult,
  type VisibilityScope,
} from '@fairflow/shared';

const OWNER_FIELD = 'assigneeId'; // == pipe.service OWNER_FIELD
const RESOURCE = 'deals';
const FAT = 5000;

function fatOwnerIds(n = FAT): string[] {
  return Array.from({ length: n }, (_, i) => `owner-${i}`);
}

/** Fake ClientGrpcProxy: ProjectGrpc.resolveRecordVisibility → scripted list. */
function fakeControl(ownerIds: string[], epoch: number, calls: { n: number }) {
  return {
    getService: () => ({
      resolveRecordVisibility: () => {
        calls.n += 1;
        return of({ allowed: true, mode: 'restricted', owner_ids: ownerIds, epoch });
      },
    }),
  } as never;
}

function deferredDealsScope(epoch: number): VisibilityScope {
  return {
    mode: 'restricted',
    level: 'own_and_department',
    selfId: 'owner-0',
    ownerIds: [],
    sharedRecordIds: [],
    deferred: true,
    descriptor: {
      unitIds: ['g1'],
      ledUnitIds: [],
      selectedGroupIds: [],
      ruleKinds: ['own_groups'],
      usesSharing: false,
      orgId: 'org-fat',
    },
    epoch,
    resource: RESOURCE,
  };
}

/** Inbound gateway metadata carrying a deferred deals scope at `epoch`. */
function inbound(epoch: number): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.PROJECT_ID, 'p-fat');
  md.set(GW_METADATA.USER_ID, 'owner-0');
  md.set(GW_METADATA.SERVICE_API_KEY, 'ak_test');
  md.set(GW_METADATA.VISIBILITY_SCOPE, serializeVisibilityScope(deferredDealsScope(epoch)));
  return md;
}

function rpcCtx(md: Metadata) {
  return {
    getType: () => 'rpc',
    getArgByIndex: (i: number) => (i === 1 ? md : undefined),
  } as never;
}

/** What the handler sees after the guard ran: the (possibly hydrated) scope. */
function scopeAfter(md: Metadata): VisibilityScope | undefined {
  return parseVisibilityScope(md.get(GW_METADATA.VISIBILITY_SCOPE)?.[0] as string);
}

describe('[#19 / T1.5] pipe deferred-scope hydration on a fat org (5000 owners)', () => {
  const calls = { n: 0 };
  const owners = fatOwnerIds();
  const metrics: HydrateResult[] = [];
  const hydrator = new DeferredScopeHydrator(fakeControl(owners, 7, calls), (r) => metrics.push(r));
  const guard = new VisibilityScopeHydrationGuard(hydrator);

  it('(a) cold request: control resolved once, filter is $in of 5000 owners', async () => {
    const md = inbound(7);
    await guard.canActivate(rpcCtx(md));

    expect(calls.n).toBe(1); // cold miss → exactly one control RTT
    const scope = scopeAfter(md)!;
    expect(scope.deferred).toBeUndefined(); // hydrated, no longer deferred
    expect(scope.ownerIds).toHaveLength(FAT);

    // buildVisibilityFilter exactly as pipe.service listDeals/kanban/dashboard do.
    const filter = buildVisibilityFilter(scope, OWNER_FIELD) as Record<string, { $in: string[] }>;
    expect(filter).toEqual({ [OWNER_FIELD]: { $in: owners } });
    expect(filter[OWNER_FIELD].$in).toHaveLength(FAT);
    expect(metrics).toContain('miss');
  });

  it('(b) warm request same epoch: cache hit, control NOT re-called', async () => {
    const before = calls.n;
    const md = inbound(7);
    await guard.canActivate(rpcCtx(md));

    expect(calls.n).toBe(before); // 0 additional control RTT
    const scope = scopeAfter(md)!;
    expect(scope.deferred).toBeUndefined();
    expect(scope.ownerIds).toHaveLength(FAT);
    expect(metrics).toContain('hit');
  });

  it('(c) epoch bump → re-resolve (K3 invalidation)', async () => {
    const before = calls.n;
    await guard.canActivate(rpcCtx(inbound(8)));
    expect(calls.n).toBe(before + 1); // new epoch → one more control RTT
  });

  it('(d) warm local phase budget: hit + parse + build filter over 5000 ids', async () => {
    await guard.canActivate(rpcCtx(inbound(7))); // ensure epoch 7 is warm
    const controlAtStart = calls.n;

    const ITER = 50;
    const t0 = performance.now();
    for (let i = 0; i < ITER; i++) {
      const md = inbound(7);
      await guard.canActivate(rpcCtx(md)); // cache hit — no control RTT
      const scope = scopeAfter(md)!;
      const filter = buildVisibilityFilter(scope, OWNER_FIELD) as Record<string, { $in: string[] }>;
      expect(filter[OWNER_FIELD].$in).toHaveLength(FAT);
    }
    const perIter = (performance.now() - t0) / ITER;

    // No control calls in the warm loop (pure local phase).
    expect(calls.n).toBe(controlAtStart);
    // Budget: local per-request phase (guard parse of the small deferred scope +
    // cache hit that re-parses the ~cached 5000-id serialized scope + metadata.set +
    // handler-side parse + $in build) must stay small. Threshold is set with a wide
    // margin over the observed ~sub-ms/iter so CI jitter never flaps it (T1.5 =
    // "listing on a fat org within the latency budget; cache hits confirmed"; no
    // numeric NFR is fixed in the plans, so a conservative local ceiling is used).

    console.log(
      `[T1.5] warm local phase: ${perIter.toFixed(3)} ms/iter over ${ITER} iters (5000 ids)`,
    );
    expect(perIter).toBeLessThan(50);
  });

  it('(e) deferred WITHOUT descriptor → deny-all preserved (fail-closed invariant)', async () => {
    const noDesc: VisibilityScope = {
      mode: 'restricted',
      level: 'custom',
      selfId: 'owner-0',
      ownerIds: [],
      sharedRecordIds: [],
      deferred: true,
      epoch: 7,
      resource: RESOURCE,
    };
    const raw = serializeVisibilityScope(noDesc);
    // parseVisibilityScope drops a descriptor-less deferred scope entirely.
    expect(parseVisibilityScope(raw)).toBeUndefined();

    const md = new Metadata();
    md.set(GW_METADATA.PROJECT_ID, 'p-fat');
    md.set(GW_METADATA.USER_ID, 'owner-0');
    md.set(GW_METADATA.VISIBILITY_SCOPE, raw);
    const c = { n: 0 };
    const g = new VisibilityScopeHydrationGuard(new DeferredScopeHydrator(fakeControl([], 7, c)));

    await g.canActivate(rpcCtx(md));
    expect(c.n).toBe(0); // nothing resolvable → control never called

    // Downstream readVisibilityScope → undefined → buildVisibilityFilter deny-all.
    const filter = buildVisibilityFilter(scopeAfter(md), OWNER_FIELD);
    expect(filter).toEqual({ $nor: [{}] });
  });
});
