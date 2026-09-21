/**
 * Wiring invariants of the company domain root module.
 *  - TODO-096: `@RequireModule('companies')` on the gRPC controller is only enforced
 *    when FeatureToggleModule (APP_GUARD → ModuleGuard) is actually imported.
 *  - TODO-369: domains expose no business REST — only the ops HTTP contract.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_GUARD } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';
import { AppModule } from './app.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';

function imports(mod: unknown): unknown[] {
  return (Reflect.getMetadata('imports', mod as object) as unknown[]) ?? [];
}

describe('company AppModule wiring', () => {
  it('imports FeatureToggleModule so @RequireModule is enforced (TODO-096)', () => {
    expect(imports(AppModule)).toContain(FeatureToggleModule);
  });

  it('FeatureToggleModule really registers ModuleGuard as a global guard', () => {
    const providers =
      (Reflect.getMetadata('providers', FeatureToggleModule) as {
        provide?: unknown;
        useClass?: unknown;
      }[]) ?? [];
    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: ModuleGuard });
  });

  it('has no business REST controller in the domain (TODO-369)', () => {
    const files = readdirSync(join(__dirname, 'companies'));
    expect(files).not.toContain('companies.controller.ts');
  });
});
