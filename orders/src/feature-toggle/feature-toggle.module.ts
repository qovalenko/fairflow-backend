import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';

/**
 * Per-project module gating for this domain (TODO-080). Registers the shared
 * {@link ModuleGuard} globally so `@RequireModule('orders')` on the gRPC
 * controller is actually enforced: the gateway-resolved `x-enabled-modules`
 * metadata is checked and a call into a project with `orders` disabled is
 * rejected with PERMISSION_DENIED `MODULE_DISABLED: orders`. Absent metadata
 * (trusted s2s caller) → fail-open, matching the guard contract.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_GUARD,
      // ModuleGuard lives in @fairflow/shared, compiled WITHOUT
      // emitDecoratorMetadata → `useClass` cannot inject Reflector (it arrives
      // undefined and every call throws). Pass it explicitly via a factory.
      useFactory: (reflector: Reflector) => new ModuleGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class FeatureToggleModule {}
