import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GatewayModuleGuard, invalidateModuleCache } from './gateway-module.guard';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';

/**
 * Regression coverage for bug B/B2: the guard caches a project's effective
 * modules for 30s. Enabling a module (PATCH /projects/:id) must drop that cache
 * (via invalidateModuleCache) so the next module-gated request sees the new set
 * instead of a stale 403 MODULE_DISABLED for up to the TTL window.
 */
describe('GatewayModuleGuard module cache', () => {
  const PROJECT_ID = 'proj-1';

  function makeContext(): ExecutionContext {
    const req = {
      params: { projectId: PROJECT_ID },
      query: {},
      headers: {},
    };
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  function makeGuard(getProject: jest.Mock) {
    const reflector = {
      getAllAndOverride: (key: unknown) => (key === REQUIRED_MODULE_KEY ? 'products' : undefined),
    } as unknown as Reflector;
    const control = {
      getService: () => ({ getProject }),
    };
    const guard = new GatewayModuleGuard(reflector, control as never);
    guard.onModuleInit();
    return guard;
  }

  afterEach(() => invalidateModuleCache(PROJECT_ID));

  it('403s when the required module is disabled, then 200s after enable + cache invalidation', async () => {
    const getProject = jest
      .fn()
      // 1st resolve: products NOT enabled
      .mockResolvedValueOnce({ effective_modules: ['deals'] })
      // 2nd resolve (after invalidate): products enabled
      .mockResolvedValueOnce({ effective_modules: ['deals', 'orders', 'products'] });
    const guard = makeGuard(getProject);

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(ForbiddenException);

    // Without invalidation the cached (products-less) set would 403 again.
    invalidateModuleCache(PROJECT_ID);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('serves the cache within TTL (no re-fetch) until invalidated', async () => {
    const getProject = jest
      .fn()
      .mockResolvedValue({ effective_modules: ['deals', 'orders', 'products'] });
    const guard = makeGuard(getProject);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    // Second call hit the cache — control queried only once.
    expect(getProject).toHaveBeenCalledTimes(1);

    invalidateModuleCache(PROJECT_ID);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(getProject).toHaveBeenCalledTimes(2);
  });
});
