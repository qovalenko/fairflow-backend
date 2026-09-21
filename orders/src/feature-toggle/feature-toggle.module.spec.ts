import 'reflect-metadata';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';
import { FeatureToggleModule } from './feature-toggle.module';
import { AppModule } from '../app.module';

/**
 * TODO-080: `@RequireModule('orders')` on the gRPC controller is only enforced if
 * the shared ModuleGuard is actually registered as a global guard AND the module
 * that registers it is imported by the AppModule. Both used to be missing, which
 * made the decorator inert (a project with `orders` disabled was still served).
 */
describe('FeatureToggleModule (orders)', () => {
  it('registers ModuleGuard as a global APP_GUARD', () => {
    const providers = (Reflect.getMetadata('providers', FeatureToggleModule) ?? []) as Array<{
      provide?: unknown;
      useFactory?: (r: Reflector) => unknown;
      inject?: unknown[];
    }>;
    const guard = providers.find((p) => p.provide === APP_GUARD);
    expect(guard).toBeDefined();
    // Reflector must be injected explicitly: @fairflow/shared is compiled without
    // emitDecoratorMetadata, so `useClass` would hand the guard an undefined one.
    expect(guard?.inject).toEqual([Reflector]);
    expect(guard?.useFactory?.(new Reflector())).toBeInstanceOf(ModuleGuard);
  });

  it('is imported by the orders AppModule (otherwise the guard never loads)', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    expect(imports).toContain(FeatureToggleModule);
  });
});
