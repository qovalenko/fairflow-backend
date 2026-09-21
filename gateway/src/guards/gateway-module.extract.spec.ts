import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GatewayModuleGuard, __resetModuleCacheForTest } from './gateway-module.guard';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';

/**
 * Component coverage (QA-CI T-036.3) for the effective-module extraction
 * fallbacks and the fail-closed control-outage path of GatewayModuleGuard, plus
 * the exact MODULE_DISABLED error shape. The cache/fanout behaviour is covered by
 * gateway-module.guard.spec.ts + gateway-module-cache-fanout.spec.ts — this file
 * targets the payload-shape branches those suites do not reach.
 */
describe('GatewayModuleGuard effective-module extraction', () => {
  function makeContext(projectId = 'proj-x'): ExecutionContext {
    const req = { params: { projectId }, query: {}, headers: {} };
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  function makeReqCarryingContext(projectId = 'proj-x') {
    const req: Record<string, unknown> = { params: { projectId }, query: {}, headers: {} };
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { req, ctx };
  }

  function makeGuard(getProject: jest.Mock, requiredModule: string | undefined) {
    const reflector = {
      getAllAndOverride: (key: unknown) =>
        key === REQUIRED_MODULE_KEY ? requiredModule : undefined,
    } as unknown as Reflector;
    const control = { getService: () => ({ getProject }) };
    const guard = new GatewayModuleGuard(reflector, control as never);
    guard.onModuleInit();
    return guard;
  }

  beforeEach(() => __resetModuleCacheForTest());
  afterEach(() => __resetModuleCacheForTest());

  it('passes through unguarded routes (no @RequireModule)', async () => {
    const getProject = jest.fn();
    const guard = makeGuard(getProject, undefined);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(getProject).not.toHaveBeenCalled();
  });

  it('extracts enabled modules from module_configs (enabled!==false)', async () => {
    const getProject = jest.fn().mockResolvedValue({
      module_configs: [
        { module_id: 'orders', enabled: true },
        { module_id: 'products', enabled: false },
      ],
    });
    const { req, ctx } = makeReqCarryingContext('p-cfg');
    const guard = makeGuard(getProject, 'orders');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.__enabledModules as string[]).toContain('orders');
    // A disabled config entry must not appear in the propagated set.
    expect(req.__enabledModules as string[]).not.toContain('products');
  });

  it('403 MODULE_DISABLED for a config-disabled module (exact error shape)', async () => {
    const getProject = jest.fn().mockResolvedValue({
      module_configs: [{ module_id: 'products', enabled: false }],
    });
    const guard = makeGuard(getProject, 'products');
    const err = await guard.canActivate(makeContext('p-dis')).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response).toMatchObject({
      code: 'MODULE_DISABLED',
      module: 'products',
    });
    expect(typeof err.response.message).toBe('string');
  });

  it('extracts modules from a bare modules[] list with dependency resolution', async () => {
    const getProject = jest.fn().mockResolvedValue({ modules: ['orders'] });
    const { req, ctx } = makeReqCarryingContext('p-mods');
    const guard = makeGuard(getProject, 'deals');

    // orders → depends on locked `deals`; a deals-gated route therefore passes.
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.__enabledModules as string[]).toEqual(expect.arrayContaining(['orders', 'deals']));
  });

  it('fail-closed on a control outage: locked modules stay enabled, optional ones 403', async () => {
    const getProject = jest.fn().mockRejectedValue(new Error('control down'));
    // `deals` is a locked/system module → still enabled from the fallback set.
    const lockedGuard = makeGuard(getProject, 'deals');
    await expect(lockedGuard.canActivate(makeContext('p-out-a'))).resolves.toBe(true);

    // `products` is optional → NOT in the fallback set → fail-closed 403.
    const optionalGuard = makeGuard(getProject, 'products');
    await expect(optionalGuard.canActivate(makeContext('p-out-b'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // TODO-086: a module-gated route with NO project scope used to pass straight
  // through (`if (!projectId) return true`) — the whole module gate was skipped
  // for that request. It must deny instead (fail-closed, mirror ProjectAccessGuard).
  it('400 PROJECT_ID_REQUIRED when the guarded route has no project context', async () => {
    const getProject = jest.fn();
    const guard = makeGuard(getProject, 'orders');
    const req = { params: {}, query: {}, headers: {} };
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    const err = await guard.canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.response).toMatchObject({ code: 'PROJECT_ID_REQUIRED', module: 'orders' });
    // Nothing is resolved without a project — control is never queried.
    expect(getProject).not.toHaveBeenCalled();
  });

  it('still resolves the project from the x-project-id header alone', async () => {
    const getProject = jest.fn().mockResolvedValue({ effective_modules: ['deals', 'orders'] });
    const guard = makeGuard(getProject, 'orders');
    const req = { params: {}, query: {}, headers: { 'x-project-id': 'p-hdr' } };
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(getProject).toHaveBeenCalledWith({ id: 'p-hdr' });
  });

  // TODO-086 (2nd fail-open): a config with a missing `enabled` flag was read as
  // enabled (`enabled !== false`), so a partial payload could open an optional
  // module. Only an explicit `enabled === true` counts now.
  it('does not enable an optional module whose config omits the enabled flag', async () => {
    const getProject = jest.fn().mockResolvedValue({
      module_configs: [{ module_id: 'products' }, { module_id: 'orders', enabled: true }],
    });
    const { req, ctx } = makeReqCarryingContext('p-implicit');
    const guard = makeGuard(getProject, 'products');

    const err = await guard.canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response).toMatchObject({ code: 'MODULE_DISABLED', module: 'products' });

    // The explicitly-enabled sibling is unaffected; locked/system modules stay in.
    const okGuard = makeGuard(getProject, 'orders');
    await expect(okGuard.canActivate(ctx)).resolves.toBe(true);
    expect(req.__enabledModules as string[]).toEqual(expect.arrayContaining(['orders', 'deals']));
    expect(req.__enabledModules as string[]).not.toContain('products');
  });
});
