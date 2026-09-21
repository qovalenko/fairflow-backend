import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  function build(values: Record<string, unknown>) {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
      ),
    };
    return new AppConfigService(config as unknown as ConfigService);
  }

  it('returns configured values with documented defaults', () => {
    const svc = build({
      'app.app.port': 3015,
      'app.app.host': '127.0.0.1',
      'app.app.grpcBillingPort': 5017,
      'app.grpc.authValidationUrl': '127.0.0.1:5009',
      'app.database.url': 'postgres://billing',
    });
    expect(svc.httpPort).toBe(3015);
    expect(svc.host).toBe('127.0.0.1');
    expect(svc.grpcBillingPort).toBe(5017);
    expect(svc.authGrpcUrl).toBe('127.0.0.1:5009');
    expect(svc.databaseUrl).toBe('postgres://billing');
  });

  it('falls back to service defaults when config keys are absent', () => {
    const svc = build({});
    expect(svc.httpPort).toBe(3011);
    expect(svc.host).toBe('0.0.0.0');
    expect(svc.grpcBillingPort).toBe(5016);
    expect(svc.authGrpcUrl).toBe('127.0.0.1:5001');
    expect(svc.databaseUrl).toBe('');
  });
});
