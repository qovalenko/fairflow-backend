/**
 * [#19] Unit tests for DeferredScopeHydrator + VisibilityScopeHydrationGuard
 * (fake control client): hit / miss / epoch-mismatch / outage / deny / LRU.
 */
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import {
  DeferredScopeHydrator,
  VisibilityScopeHydrationGuard,
  GW_METADATA,
  parseVisibilityScope,
  serializeVisibilityScope,
  type VisibilityScope,
} from '@fairflow/shared';

type WireResp = {
  allowed?: boolean;
  mode?: string;
  owner_ids?: string[];
  shared_record_ids?: string[];
  epoch?: number;
};

/** Fake ClientGrpcProxy whose ProjectGrpc.resolveRecordVisibility is scripted. */
function fakeControl(handler: () => WireResp | 'throw', calls: { n: number }) {
  return {
    getService: () => ({
      resolveRecordVisibility: () => {
        calls.n += 1;
        const r = handler();
        if (r === 'throw') return throwError(() => new Error('UNAVAILABLE'));
        return of(r);
      },
    }),
  } as never;
}

function deferredScope(epoch = 5): VisibilityScope {
  return {
    mode: 'restricted',
    level: 'own_and_department',
    selfId: 'u1',
    ownerIds: [],
    sharedRecordIds: [],
    deferred: true,
    descriptor: {
      unitIds: ['g1'],
      ledUnitIds: [],
      selectedGroupIds: [],
      ruleKinds: ['own_groups'],
      usesSharing: true,
      orgId: 'org1',
    },
    epoch,
    resource: 'contacts',
  };
}

function inboundMd(): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.PROJECT_ID, 'p1');
  md.set(GW_METADATA.USER_ID, 'u1');
  md.set(GW_METADATA.SERVICE_API_KEY, 'ak_test');
  md.set(GW_METADATA.REQUEST_ID, 'req-1');
  return md;
}

describe('[#19] DeferredScopeHydrator', () => {
  it('resolves a deferred scope into flat lists (miss), then serves from cache (hit)', async () => {
    const calls = { n: 0 };
    const h = new DeferredScopeHydrator(
      fakeControl(
        () => ({ allowed: true, mode: 'restricted', owner_ids: ['u1', 'u2'], epoch: 5 }),
        calls,
      ),
    );
    const first = await h.hydrate(deferredScope(5), inboundMd());
    expect(first.deferred).toBeUndefined();
    expect(first.ownerIds).toEqual(['u1', 'u2']);
    expect(calls.n).toBe(1);

    // Same epoch → cache hit, control not called again.
    const second = await h.hydrate(deferredScope(5), inboundMd());
    expect(second.ownerIds).toEqual(['u1', 'u2']);
    expect(calls.n).toBe(1);
  });

  it('re-resolves when the scope epoch diverges (K3 invalidation)', async () => {
    const calls = { n: 0 };
    // Control echoes the epoch the domain asks for (matches the gateway/control K3
    // contract), so the cached entry is stamped with the request's epoch.
    let nextEpoch = 5;
    const h = new DeferredScopeHydrator(
      fakeControl(
        () => ({ allowed: true, mode: 'restricted', owner_ids: ['u1'], epoch: nextEpoch }),
        calls,
      ),
    );
    await h.hydrate(deferredScope(5), inboundMd());
    expect(calls.n).toBe(1);
    // Bumped epoch → cached entry (epoch 5) no longer matches scope.epoch=6 → re-resolve.
    nextEpoch = 6;
    await h.hydrate(deferredScope(6), inboundMd());
    expect(calls.n).toBe(2);
  });

  it('fail-closed on control outage: scope stays deferred (deny-all downstream)', async () => {
    const calls = { n: 0 };
    const h = new DeferredScopeHydrator(fakeControl(() => 'throw', calls));
    const out = await h.hydrate(deferredScope(5), inboundMd());
    expect(out.deferred).toBe(true);
    expect(out.ownerIds).toEqual([]);
  });

  it('fail-closed when membership was revoked (allowed=false)', async () => {
    const calls = { n: 0 };
    const h = new DeferredScopeHydrator(fakeControl(() => ({ allowed: false }), calls));
    const out = await h.hydrate(deferredScope(5), inboundMd());
    expect(out.deferred).toBe(true);
  });

  it('no-op (returns input) for a non-deferred scope', async () => {
    const calls = { n: 0 };
    const h = new DeferredScopeHydrator(fakeControl(() => ({ allowed: true }), calls));
    const scope: VisibilityScope = {
      mode: 'all',
      level: 'all',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
    };
    const out = await h.hydrate(scope, inboundMd());
    expect(out).toBe(scope);
    expect(calls.n).toBe(0);
  });

  it('fail-closed when no control client is wired', async () => {
    const h = new DeferredScopeHydrator(undefined);
    const out = await h.hydrate(deferredScope(5), inboundMd());
    expect(out.deferred).toBe(true);
  });

  it('LRU: evicts by entry count (VISIBILITY_HYDRATE_CACHE_MAX)', async () => {
    process.env.VISIBILITY_HYDRATE_CACHE_MAX = '1';
    try {
      const calls = { n: 0 };
      const h = new DeferredScopeHydrator(
        fakeControl(
          () => ({ allowed: true, mode: 'restricted', owner_ids: ['u1'], epoch: 5 }),
          calls,
        ),
      );
      const mdA = inboundMd();
      const mdB = new Metadata();
      mdB.set(GW_METADATA.PROJECT_ID, 'p2');
      mdB.set(GW_METADATA.USER_ID, 'u1');
      await h.hydrate(deferredScope(5), mdA); // cache p1
      await h.hydrate(deferredScope(5), mdB); // cache p2, evicts p1 (max=1)
      expect(calls.n).toBe(2);
      // p1 was evicted → re-resolve (3rd call).
      await h.hydrate(deferredScope(5), mdA);
      expect(calls.n).toBe(3);
    } finally {
      delete process.env.VISIBILITY_HYDRATE_CACHE_MAX;
    }
  });
});

describe('[#19] VisibilityScopeHydrationGuard', () => {
  function rpcContext(md: Metadata) {
    return {
      getType: () => 'rpc',
      getArgByIndex: (i: number) => (i === 1 ? md : undefined),
    } as never;
  }

  it('hydrates a deferred scope in-place on the SAME Metadata instance', async () => {
    const calls = { n: 0 };
    const hydrator = new DeferredScopeHydrator(
      fakeControl(
        () => ({ allowed: true, mode: 'restricted', owner_ids: ['u1', 'u2'], epoch: 5 }),
        calls,
      ),
    );
    const guard = new VisibilityScopeHydrationGuard(hydrator);
    const md = inboundMd();
    md.set(GW_METADATA.VISIBILITY_SCOPE, serializeVisibilityScope(deferredScope(5)));

    const ok = await guard.canActivate(rpcContext(md));
    expect(ok).toBe(true);

    const stamped = md.get(GW_METADATA.VISIBILITY_SCOPE)?.[0] as string;
    const parsed = parseVisibilityScope(stamped);
    expect(parsed!.deferred).toBeUndefined();
    expect(parsed!.ownerIds).toEqual(['u1', 'u2']);
  });

  it('leaves a deferred scope untouched (still deferred) when control fails', async () => {
    const calls = { n: 0 };
    const guard = new VisibilityScopeHydrationGuard(
      new DeferredScopeHydrator(fakeControl(() => 'throw', calls)),
    );
    const md = inboundMd();
    const raw = serializeVisibilityScope(deferredScope(5));
    md.set(GW_METADATA.VISIBILITY_SCOPE, raw);
    await guard.canActivate(rpcContext(md));
    const after = parseVisibilityScope(md.get(GW_METADATA.VISIBILITY_SCOPE)?.[0] as string);
    expect(after!.deferred).toBe(true); // untouched → downstream deny-all
  });

  it('is a no-op when no scope / non-deferred scope present', async () => {
    const calls = { n: 0 };
    const guard = new VisibilityScopeHydrationGuard(
      new DeferredScopeHydrator(fakeControl(() => ({ allowed: true }), calls)),
    );
    const md = inboundMd(); // no VISIBILITY_SCOPE key
    await expect(guard.canActivate(rpcContext(md))).resolves.toBe(true);
    expect(calls.n).toBe(0);
  });
});
