import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ModuleGuard, RequireModule, GW_METADATA } from '@fairflow/shared';
import { SearchGrpcController } from './search.grpc.controller';

/**
 * TODO-050 (FR-SEARCH-180/190): search is a CROSS-CUTTING capability, not an
 * opt-in business module. The gateway exposes /search without
 * @RequireModule('search'); the domain controller must not re-gate on it either
 * — otherwise every query in a project without the (never-default) `search`
 * module dies with PERMISSION_DENIED MODULE_DISABLED.
 *
 * The suite drives the REAL ModuleGuard against the REAL controller class with
 * gateway metadata whose x-enabled-modules does NOT include 'search'.
 */

/** Fake gRPC ExecutionContext carrying x-enabled-modules metadata. */
function rpcContext(
  handler: (...args: never[]) => unknown,
  cls: new (...args: never[]) => unknown,
  enabledModules: string[],
): ExecutionContext {
  const metadata = {
    get: (key: string) =>
      key === GW_METADATA.ENABLED_MODULES ? [JSON.stringify(enabledModules)] : [],
  };
  return {
    getHandler: () => handler,
    getClass: () => cls,
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => metadata }),
  } as unknown as ExecutionContext;
}

describe('SearchGrpcController module gating (TODO-050)', () => {
  const guard = new ModuleGuard(new Reflector());

  it('Search passes in a project WITHOUT the `search` module enabled (cross-cutting)', () => {
    const ctx = rpcContext(
      SearchGrpcController.prototype.query,
      SearchGrpcController,
      ['contacts', 'deals'], // no 'search' — the default for every project
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('Reindex/Status also pass without the `search` module (no per-method gate)', () => {
    for (const handler of [
      SearchGrpcController.prototype.reindex,
      SearchGrpcController.prototype.status,
    ]) {
      const ctx = rpcContext(handler, SearchGrpcController, ['contacts']);
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('sanity: the guard itself still denies a class that DOES declare @RequireModule', () => {
    @RequireModule('search')
    class GatedController {
      handle(): void {}
    }
    const ctx = rpcContext(GatedController.prototype.handle, GatedController, ['contacts']);
    expect(() => guard.canActivate(ctx)).toThrow(/MODULE_DISABLED: search/);
  });
});
