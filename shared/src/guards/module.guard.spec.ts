import { ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import { ModuleGuard } from './module.guard';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';
import { GW_METADATA } from '../grpc/metadata-keys';

describe('ModuleGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as unknown as Reflector;
  const guard = new ModuleGuard(reflector);

  function rpcContext(enabledModules?: string[], userId?: string): ExecutionContext {
    const metadata = {
      get: (key: string) => {
        if (key === GW_METADATA.ENABLED_MODULES && enabledModules) {
          return [JSON.stringify(enabledModules)];
        }
        if (key === GW_METADATA.USER_ID && userId) {
          return [userId];
        }
        return [];
      },
    };
    return {
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => metadata }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('activities');
  });

  it('fail-open when enabled-modules metadata is absent for s2s (no x-user-id)', () => {
    expect(guard.canActivate(rpcContext())).toBe(true);
  });

  it('fail-closed when enabled-modules absent but x-user-id is present (FR-PROJ-320)', () => {
    expect(() => guard.canActivate(rpcContext(undefined, 'user-1'))).toThrow(RpcException);
  });

  it('denies when module is not in enabled-modules', () => {
    expect(() => guard.canActivate(rpcContext(['deals']))).toThrow(RpcException);
  });

  it('allows when module is present in enabled-modules', () => {
    expect(guard.canActivate(rpcContext(['activities', 'deals']))).toBe(true);
  });

  it('passes through when handler has no @RequireModule', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    expect(guard.canActivate(rpcContext())).toBe(true);
  });
});
