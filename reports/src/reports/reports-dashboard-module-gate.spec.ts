import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { ModuleGuard, REQUIRED_MODULE_KEY, GW_METADATA } from '@fairflow/shared';
import type { ExecutionContext } from '@nestjs/common';
import { ReportsGrpcController } from './reports.grpc.controller';

/**
 * T-003-BE regression: the operational dashboard / analytics live in the reports
 * listener but belong to the STATISTICS module (statistics has no own domain).
 * They must be gated on `statistics`, NOT on the class-level `@RequireModule('reports')`.
 *
 * Before the fix, a project with `statistics` enabled but `reports` disabled (they
 * are independent optional modules — soft-dep only) returned 403 MODULE_DISABLED on
 * GetDashboard/GetMetrics for EVERY caller, including the project OWNER. These tests
 * lock the decorator wiring (positive owner-style case) AND keep the disabled-module
 * denial for the non-dashboard reports methods (negative case preserved).
 */
describe('reports gRPC module gating (dashboard = statistics, not reports)', () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);
  const proto = ReportsGrpcController.prototype;

  /** Build a fake gRPC ExecutionContext pointing at `handler`, with the given enabled modules. */
  function ctx(handler: (...a: unknown[]) => unknown, enabledModules: string[]): ExecutionContext {
    const metadata = {
      get: (key: string) =>
        key === GW_METADATA.ENABLED_MODULES ? [JSON.stringify(enabledModules)] : [],
    };
    return {
      getHandler: () => handler,
      getClass: () => ReportsGrpcController,
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => metadata }),
    } as unknown as ExecutionContext;
  }

  it('resolves the required module to `statistics` for getDashboard/getMetrics (method-level override wins)', () => {
    for (const handler of [proto.getDashboard, proto.getMetrics]) {
      const required = reflector.getAllAndOverride<string>(REQUIRED_MODULE_KEY, [
        handler,
        ReportsGrpcController,
      ]);
      expect(required).toBe('statistics');
    }
  });

  it('keeps the required module as `reports` for the report CRUD/run methods (class-level)', () => {
    for (const handler of [proto.list, proto.get, proto.run, proto.export]) {
      const required = reflector.getAllAndOverride<string>(REQUIRED_MODULE_KEY, [
        handler,
        ReportsGrpcController,
      ]);
      expect(required).toBe('reports');
    }
  });

  it('OWNER with statistics enabled (reports OFF) passes the guard on getDashboard/getMetrics', () => {
    // The gateway propagates the effective-enabled set — here statistics is on,
    // reports is off. Previously this threw MODULE_DISABLED: reports.
    for (const handler of [proto.getDashboard, proto.getMetrics]) {
      expect(guard.canActivate(ctx(handler, ['statistics']))).toBe(true);
    }
  });

  it('still denies getDashboard when the statistics module itself is OFF', () => {
    expect(() => guard.canActivate(ctx(proto.getDashboard, ['reports']))).toThrow(RpcException);
  });

  it('still denies the reports CRUD methods when the reports module is OFF (no security loosening)', () => {
    for (const handler of [proto.list, proto.run, proto.export]) {
      expect(() => guard.canActivate(ctx(handler, ['statistics']))).toThrow(RpcException);
    }
  });
});
