import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authValidationLoaderOptions } from '@fairflow/shared';

/**
 * P8 regression guard. The domain-side `AUTH_VALIDATION_GRPC` client (used to
 * validate the gateway service-API-key against auth `ValidateServiceApiKey`) was
 * once registered WITHOUT a proto-loader, so it defaulted to camelCase while auth
 * is built with keepCase — every domain then answered 401 "Invalid gateway
 * service API key". These assertions fail loudly if `keepCase` is ever lost or the
 * module stops wiring the shared loader options into the client registration.
 */
describe('authValidationLoaderOptions (P8 keepCase guard)', () => {
  it('keeps proto field casing (keepCase:true) so auth responses decode correctly', () => {
    expect(authValidationLoaderOptions.keepCase).toBe(true);
  });

  it('is wired into the AUTH_VALIDATION_GRPC client registration', () => {
    const module = readFileSync(join(__dirname, 'auth-validation.module.ts'), 'utf8');
    expect(module).toContain('loader: authValidationLoaderOptions');
    expect(module).toContain('AUTH_VALIDATION_GRPC');
  });
});
