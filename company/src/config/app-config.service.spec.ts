import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  function build(values: Record<string, unknown> = {}) {
    const configService = {
      get: (key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
    };
    return new AppConfigService(configService as never);
  }

  it('reads grpc and HTTP ports with defaults', () => {
    const svc = build();
    expect(svc.grpcPort).toBe(5004);
    expect(svc.port).toBe(3000);
    expect(svc.host).toBe('0.0.0.0');
  });

  it('reads auth/control gRPC URLs with defaults', () => {
    const svc = build();
    expect(svc.authGrpcUrl).toBe('127.0.0.1:5001');
    expect(svc.controlGrpcUrl).toBe('127.0.0.1:5002');
  });

  it('honours overrides from ConfigService', () => {
    const svc = build({
      'app.grpc.port': 5100,
      'app.app.port': 3100,
      'app.jwt.secret': 'secret-from-config',
      'app.cors.credentials': true,
    });
    expect(svc.grpcPort).toBe(5100);
    expect(svc.port).toBe(3100);
    expect(svc.jwtSecret).toBe('secret-from-config');
    expect(svc.corsCredentials).toBe(true);
  });

  it('reads node env, database URL and JWT expiry with defaults', () => {
    const svc = build();
    expect(svc.nodeEnv).toBe('development');
    expect(svc.databaseUrl).toBe('');
    expect(svc.jwtExpiresIn).toBe('7d');
    expect(svc.corsOrigin).toBe('*');
  });

  it('reads graceful shutdown timings with defaults and overrides', () => {
    const svc = build();
    expect(svc.sleepBeforeShutdownMs).toBe(5000);
    expect(svc.forceShutdownTimeoutMs).toBe(30000);

    const overridden = build({
      'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
      'app.gracefulShutdown.forceShutdownTimeoutMs': 5000,
      'app.cors.origin': ['https://crm.example'],
      'app.app.nodeEnv': 'production',
      'app.database.url': 'mongodb://localhost/companies',
    });
    expect(overridden.sleepBeforeShutdownMs).toBe(1000);
    expect(overridden.forceShutdownTimeoutMs).toBe(5000);
    expect(overridden.corsOrigin).toEqual(['https://crm.example']);
    expect(overridden.nodeEnv).toBe('production');
    expect(overridden.databaseUrl).toBe('mongodb://localhost/companies');
  });
});
