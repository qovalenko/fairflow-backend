import { Controller, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALL_MODULE_IDS,
  GW_METADATA,
  MODULE_REGISTRY,
  ModuleGuard,
  REQUIRED_MODULE_KEY,
  RequireModule,
} from '@fairflow/shared';
import { AuditGrpcController } from './audit.grpc.controller';

/**
 * Регресс на TODO-124: аудит — сквозная платформенная функция, а не подключаемый
 * модуль проекта. `@RequireModule('audit')` на контроллере означал вечный
 * PERMISSION_DENIED: gateway кладёт в метадату `x-enabled-modules`, а `audit`
 * в этом списке не появится никогда (в MODULE_REGISTRY такого id нет).
 */
describe('AuditGrpcController: module gate (TODO-124)', () => {
  const guard = new ModuleGuard(new Reflector());

  /** gRPC-контекст с ровно тем `x-enabled-modules`, что кладёт gateway. */
  function rpcCtx(target: object, method: string, enabledModules: string[]): ExecutionContext {
    const metadata = {
      get: (key: string) =>
        key === GW_METADATA.ENABLED_MODULES ? [JSON.stringify(enabledModules)] : [],
    };
    return {
      getType: () => 'rpc',
      getHandler: () => (target as Record<string, unknown>)[method],
      getClass: () => target.constructor,
      switchToRpc: () => ({ getContext: () => metadata }),
    } as unknown as ExecutionContext;
  }

  const controller = Object.create(AuditGrpcController.prototype) as AuditGrpcController;
  const methods = ['appendEvent', 'listEvents', 'getEvent', 'verifyAuditChain'];

  it('в реестре модулей нет id "audit" — гейтить по нему нечем', () => {
    expect(MODULE_REGISTRY['audit']).toBeUndefined();
    expect(ALL_MODULE_IDS).not.toContain('audit');
  });

  it.each(methods)('%s не помечен @RequireModule', (method) => {
    const required = new Reflector().getAllAndOverride<string | undefined>(REQUIRED_MODULE_KEY, [
      (controller as unknown as Record<string, unknown>)[method] as never,
      AuditGrpcController,
    ]);
    expect(required).toBeUndefined();
  });

  it.each(methods)(
    '%s проходит ModuleGuard при полном списке включённых модулей проекта',
    (method) => {
      // ALL_MODULE_IDS — максимум того, что вообще может оказаться в
      // x-enabled-modules; если и тут был бы отказ, ручка недостижима всегда.
      expect(guard.canActivate(rpcCtx(controller, method, ALL_MODULE_IDS))).toBe(true);
    },
  );

  it('гейт не сломан вообще: ручка с @RequireModule("audit") тем же списком была бы закрыта', () => {
    @Controller()
    @RequireModule('audit')
    class GatedProbe {
      probe() {
        return null;
      }
    }
    const probe = Object.create(GatedProbe.prototype) as GatedProbe;
    expect(() => guard.canActivate(rpcCtx(probe, 'probe', ALL_MODULE_IDS))).toThrow(
      /MODULE_DISABLED: audit/,
    );
  });
});
