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
    expect(svc.grpcPort).toBe(5003);
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
      'app.grpc.port': 5103,
      'app.app.port': 3100,
      'app.jwt.secret': 'secret-from-config',
      'app.cors.credentials': true,
    });
    expect(svc.grpcPort).toBe(5103);
    expect(svc.port).toBe(3100);
    expect(svc.jwtSecret).toBe('secret-from-config');
    expect(svc.corsCredentials).toBe(true);
  });

  it('читает JWT, CORS, graceful shutdown и databaseUrl с дефолтами', () => {
    const svc = build();
    expect(svc.nodeEnv).toBe('development');
    expect(svc.databaseUrl).toBe('');
    expect(svc.jwtSecret).toBe('change-me');
    expect(svc.jwtExpiresIn).toBe('7d');
    expect(svc.corsOrigin).toBe('*');
    expect(svc.corsCredentials).toBe(false);
    expect(svc.sleepBeforeShutdownMs).toBe(5000);
    expect(svc.forceShutdownTimeoutMs).toBe(30000);
  });

  it('принимает переопределения JWT/CORS/shutdown/database', () => {
    const svc = build({
      'app.app.nodeEnv': 'production',
      'app.database.url': 'mongodb://db/contacts',
      'app.jwt.expiresIn': '1d',
      'app.cors.origin': ['https://crm.local'],
      'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
      'app.gracefulShutdown.forceShutdownTimeoutMs': 15000,
    });
    expect(svc.nodeEnv).toBe('production');
    expect(svc.databaseUrl).toBe('mongodb://db/contacts');
    expect(svc.jwtExpiresIn).toBe('1d');
    expect(svc.corsOrigin).toEqual(['https://crm.local']);
    expect(svc.sleepBeforeShutdownMs).toBe(1000);
    expect(svc.forceShutdownTimeoutMs).toBe(15000);
  });
});
