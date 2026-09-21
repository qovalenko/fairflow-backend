import { ServiceUnavailableException } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import {
  PermissionProjection,
  PermissionProjectionCacheService,
} from './permission-projection-cache.service';

/**
 * P0-3 LKG cache: a single transient control failure must not collapse the
 * owner's sidebar — the last successful projection is replayed on transport
 * errors only, while real gRPC decisions still propagate (fail-closed).
 */
describe('PermissionProjectionCacheService', () => {
  const OLD_ENV = process.env;

  const projection = (epoch: number): PermissionProjection => ({
    projectId: 'p1',
    allowed: ['deals:read'],
    modulePolicyFlags: { deals: { canRead: true } },
    visibilityScope: { mode: 'restricted', level: 'only_own', selfId: 'u1', departmentIds: [] },
    epoch,
  });

  const grpcErr = (code: number) => Object.assign(new Error(`grpc ${code}`), { code });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env.GATEWAY_PERMPROJ_CACHE_TTL_MS;
    delete process.env.GATEWAY_PERMPROJ_STALE_GRACE_MS;
    delete process.env.GATEWAY_PERMPROJ_CACHE_MAX;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  // (a) success → response passes through and is cached.
  it('returns and caches a successful projection', async () => {
    const svc = new PermissionProjectionCacheService();
    const fetch = jest.fn().mockResolvedValue(projection(1));
    const out = await svc.resolve('u1', 'p1', fetch);
    expect(out).toEqual(projection(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // (b) UNAVAILABLE after a success → last-known-good is served, with a warn.
  it('serves last-known-good on UNAVAILABLE after a prior success', async () => {
    const metrics = { recordPermissionProjectionLkgServe: jest.fn() };
    const svc = new PermissionProjectionCacheService(metrics as never);
    const warn = jest.spyOn((svc as never as { logger: { warn: () => void } }).logger, 'warn');

    const good = projection(7);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(good) // first: seed the cache
      .mockRejectedValue(grpcErr(status.UNAVAILABLE)); // then: control down

    await svc.resolve('u1', 'p1', fetch);
    const served = await svc.resolve('u1', 'p1', fetch);

    expect(served).toEqual(good);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(metrics.recordPermissionProjectionLkgServe).toHaveBeenCalledTimes(1);
  });

  it('serves last-known-good on a gateway-side deadline (ServiceUnavailableException)', async () => {
    const svc = new PermissionProjectionCacheService();
    const good = projection(3);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValue(new ServiceUnavailableException('Upstream gRPC timed out'));

    await svc.resolve('u1', 'p1', fetch);
    expect(await svc.resolve('u1', 'p1', fetch)).toEqual(good);
  });

  // (c) UNAVAILABLE without a cached entry → error surfaces (fail-closed).
  it('propagates UNAVAILABLE when nothing is cached', async () => {
    const svc = new PermissionProjectionCacheService();
    const err = grpcErr(status.UNAVAILABLE);
    const fetch = jest.fn().mockRejectedValue(err);
    await expect(svc.resolve('u1', 'p1', fetch)).rejects.toBe(err);
  });

  // (d) PERMISSION_DENIED → error surfaces even with a cached entry.
  it('propagates a real decision (PERMISSION_DENIED) even with a cached entry', async () => {
    const svc = new PermissionProjectionCacheService();
    const denied = grpcErr(status.PERMISSION_DENIED);
    const fetch = jest.fn().mockResolvedValueOnce(projection(1)).mockRejectedValue(denied);

    await svc.resolve('u1', 'p1', fetch);
    await expect(svc.resolve('u1', 'p1', fetch)).rejects.toBe(denied);
  });

  // (e) expired stale window → error surfaces (fail-closed).
  it('propagates the error once the stale grace window has elapsed', async () => {
    process.env.GATEWAY_PERMPROJ_STALE_GRACE_MS = '1000';
    const svc = new PermissionProjectionCacheService();
    const now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(now);
    await svc.resolve('u1', 'p1', jest.fn().mockResolvedValue(projection(1)));

    nowSpy.mockReturnValue(now + 5_000); // well past the 1s grace
    const err = grpcErr(status.UNAVAILABLE);
    await expect(svc.resolve('u1', 'p1', jest.fn().mockRejectedValue(err))).rejects.toBe(err);
  });

  // (f) LRU cap evicts the oldest entries beyond the bound.
  it('enforces the LRU size cap', async () => {
    process.env.GATEWAY_PERMPROJ_CACHE_MAX = '2';
    const svc = new PermissionProjectionCacheService();
    const cache = (svc as never as { cache: Map<string, unknown> }).cache;

    await svc.resolve('u1', 'a', jest.fn().mockResolvedValue(projection(1)));
    await svc.resolve('u1', 'b', jest.fn().mockResolvedValue(projection(1)));
    await svc.resolve('u1', 'c', jest.fn().mockResolvedValue(projection(1)));

    expect(cache.size).toBe(2);
    expect(cache.has('u1::a')).toBe(false); // oldest evicted
    expect(cache.has('u1::b')).toBe(true);
    expect(cache.has('u1::c')).toBe(true);
  });

  // Master switch: TTL 0 disables caching → pure passthrough, no stale-serve.
  it('is a passthrough when TTL is 0 (cache disabled)', async () => {
    process.env.GATEWAY_PERMPROJ_CACHE_TTL_MS = '0';
    const svc = new PermissionProjectionCacheService();
    await svc.resolve('u1', 'p1', jest.fn().mockResolvedValue(projection(1)));

    const err = grpcErr(status.UNAVAILABLE);
    await expect(svc.resolve('u1', 'p1', jest.fn().mockRejectedValue(err))).rejects.toBe(err);
  });

  it('background-refreshes the entry after a stale serve (single-flight)', async () => {
    const svc = new PermissionProjectionCacheService();
    const good = projection(1);
    const refreshed = projection(2);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(good) // seed
      .mockRejectedValueOnce(grpcErr(status.UNAVAILABLE)) // stale-serve trigger
      .mockResolvedValue(refreshed); // background refresh succeeds

    await svc.resolve('u1', 'p1', fetch);
    await svc.resolve('u1', 'p1', fetch); // serves `good`, schedules refresh

    // Let the fire-and-forget refresh settle.
    await new Promise((r) => setImmediate(r));

    // Next transport failure now replays the refreshed entry.
    const served = await svc.resolve(
      'u1',
      'p1',
      jest.fn().mockRejectedValue(grpcErr(status.UNAVAILABLE)),
    );
    expect(served).toEqual(refreshed);
  });
});
