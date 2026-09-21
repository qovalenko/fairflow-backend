import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  GatewayModuleGuard,
  invalidateModuleCache,
  MODULE_CACHE_INVALIDATION_CHANNEL,
  __resetModuleCacheForTest,
} from './gateway-module.guard';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';

/**
 * T-026 — cross-replica (per-pod) module-cache coherency.
 *
 * The guard caches a project's effective-module set per pod. `invalidateModuleCache`
 * evicts the local entry AND fans the eviction out to sibling gateway replicas via
 * the Redis Pub/Sub seam (`RedisPubSubService`). These tests cover the fanout
 * mechanism, the inbound-frame eviction, the adaptive TTL, and graceful degradation
 * when the pub/sub seam is absent (single-replica / unit construction).
 *
 * The true end-to-end two-pod proof is the runtime verification (two gateway
 * instances + one Redis): within a single test process there is only ONE
 * module-level cache Map, so here we assert the mechanism, not two separate caches.
 */
describe('GatewayModuleGuard cross-pod cache fanout (T-026)', () => {
  const PROJECT_ID = 't026-proj';

  function makeContext(projectId = PROJECT_ID): ExecutionContext {
    const req = { params: { projectId }, query: {}, headers: {} };
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  /** Minimal fake of RedisPubSubService with an observable single-process bus. */
  function makeFakePubSub(redisEnabled: boolean) {
    const listeners = new Map<string, ((m: string) => void)[]>();
    return {
      redisEnabled,
      publish: jest.fn((channel: string, payload: unknown) => {
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
        (listeners.get(channel) ?? []).forEach((l) => l(message));
      }),
      subscribe: jest.fn((channel: string, listener: (m: string) => void) => {
        const arr = listeners.get(channel) ?? [];
        arr.push(listener);
        listeners.set(channel, arr);
        return () => undefined;
      }),
    };
  }

  function makeGuard(getProject: jest.Mock, pubsub?: unknown) {
    const reflector = {
      getAllAndOverride: (key: unknown) => (key === REQUIRED_MODULE_KEY ? 'products' : undefined),
    } as unknown as Reflector;
    const control = { getService: () => ({ getProject }) };
    const guard = new GatewayModuleGuard(reflector, control as never, pubsub as never);
    guard.onModuleInit();
    return guard;
  }

  beforeEach(() => __resetModuleCacheForTest());
  afterEach(() => {
    __resetModuleCacheForTest();
    jest.restoreAllMocks();
  });

  it('publishes {projectId} on the invalidation channel when the pub/sub seam is wired', () => {
    const pubsub = makeFakePubSub(true);
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['products'] });
    makeGuard(getProject, pubsub);

    invalidateModuleCache(PROJECT_ID);

    expect(pubsub.publish).toHaveBeenCalledWith(MODULE_CACHE_INVALIDATION_CHANNEL, {
      projectId: PROJECT_ID,
    });
  });

  it('evicts the local cache when an inbound invalidation frame arrives (sibling-pod fanout)', async () => {
    const pubsub = makeFakePubSub(true);
    const getProject = jest
      .fn()
      .mockResolvedValue({ effective_modules: ['deals', 'orders', 'products'] });
    const guard = makeGuard(getProject, pubsub);

    // Warm the cache, then confirm the 2nd call is served from cache (no re-fetch).
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(getProject).toHaveBeenCalledTimes(1);

    // Simulate a frame published by a SIBLING replica arriving on this replica's
    // subscription: the registered listener must evict the local entry.
    const [, listener] = pubsub.subscribe.mock.calls[0] as [string, (m: string) => void];
    listener(JSON.stringify({ projectId: PROJECT_ID }));

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed inbound frames without throwing', async () => {
    const pubsub = makeFakePubSub(true);
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['products'] });
    makeGuard(getProject, pubsub);
    const [, listener] = pubsub.subscribe.mock.calls[0] as [string, (m: string) => void];

    expect(() => listener('not-json')).not.toThrow();
    expect(() => listener(JSON.stringify({ nope: 1 }))).not.toThrow();
  });

  it('uses the 30s TTL when Redis fanout is active', async () => {
    const pubsub = makeFakePubSub(true);
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['products'] });
    const guard = makeGuard(getProject, pubsub);
    const now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(now);
    await guard.canActivate(makeContext());
    expect(getProject).toHaveBeenCalledTimes(1);

    // Still cached at +6s (would already be stale under the 5s fallback bound).
    nowSpy.mockReturnValue(now + 6_000);
    await guard.canActivate(makeContext());
    expect(getProject).toHaveBeenCalledTimes(1);

    // Expired past the 30s bound.
    nowSpy.mockReturnValue(now + 31_000);
    await guard.canActivate(makeContext());
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('falls back to the 5s TTL when the pub/sub seam reports Redis disabled', async () => {
    const pubsub = makeFakePubSub(false);
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['products'] });
    const guard = makeGuard(getProject, pubsub);
    const now = 2_000_000;
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(now);
    await guard.canActivate(makeContext());
    expect(getProject).toHaveBeenCalledTimes(1);

    // Expired past the 5s fallback bound.
    nowSpy.mockReturnValue(now + 6_000);
    await guard.canActivate(makeContext());
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('degrades gracefully (no throw) when constructed without a pub/sub seam', async () => {
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['products'] });
    // 2-arg-equivalent construction (pubsub undefined) — mirrors the T-007 spec.
    const guard = makeGuard(getProject, undefined);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(() => invalidateModuleCache(PROJECT_ID)).not.toThrow();
  });
});
