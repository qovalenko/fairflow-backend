import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';

@Global()
@Module({
  providers: [
    {
      provide: APP_GUARD,
      // ModuleGuard живёт в @fairflow/shared; если shared собран без
      // emitDecoratorMetadata, `useClass` не сможет внедрить Reflector
      // (undefined → падение на каждом вызове). Прокидываем явно через фабрику —
      // работает при любой сборке shared (тот же приём, что в activity).
      useFactory: (reflector: Reflector) => new ModuleGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class FeatureToggleModule {}
