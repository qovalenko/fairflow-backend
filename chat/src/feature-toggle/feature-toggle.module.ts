import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';

@Global()
@Module({
  providers: [
    {
      provide: APP_GUARD,
      // ModuleGuard из @fairflow/shared скомпилирован без emitDecoratorMetadata →
      // useClass не вносит Reflector (undefined → 500 на всех HTTP-роутах). Фабрика с явным inject.
      useFactory: (reflector: Reflector) => new ModuleGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class FeatureToggleModule {}
