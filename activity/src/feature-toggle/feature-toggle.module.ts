import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';

@Global()
@Module({
  providers: [
    {
      provide: APP_GUARD,
      // ModuleGuard живёт в @fairflow/shared, скомпилированном без
      // emitDecoratorMetadata → useClass не может внедрить Reflector (undefined →
      // 500 на всех HTTP-роутах). Прокидываем Reflector явно через фабрику.
      useFactory: (reflector: Reflector) => new ModuleGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class FeatureToggleModule {}
