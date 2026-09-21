import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const prevControlKey = process.env.CONTROL_SERVICE_API_KEY;
  const prevGatewayKey = process.env.GATEWAY_SERVICE_API_KEY;

  afterEach(() => {
    if (prevControlKey === undefined) delete process.env.CONTROL_SERVICE_API_KEY;
    else process.env.CONTROL_SERVICE_API_KEY = prevControlKey;
    if (prevGatewayKey === undefined) delete process.env.GATEWAY_SERVICE_API_KEY;
    else process.env.GATEWAY_SERVICE_API_KEY = prevGatewayKey;
  });

  function make(getImpl: (key: string, fallback?: unknown) => unknown): AppConfigService {
    const config = {
      get: jest.fn(getImpl),
    } as unknown as ConfigService;
    return new AppConfigService(config);
  }

  it('reads grpc and HTTP settings from config with defaults', () => {
    const svc = make((_key, fallback) => fallback);
    expect(svc.grpcPort).toBe(5002);
    expect(svc.port).toBe(3000);
    expect(svc.host).toBe('0.0.0.0');
    expect(svc.nodeEnv).toBe('development');
    expect(svc.authGrpcUrl).toBe('127.0.0.1:5001');
    expect(svc.billingGrpcUrl).toBe('127.0.0.1:5016');
  });

  it('prefers CONTROL_SERVICE_API_KEY for directory lookups', () => {
    process.env.CONTROL_SERVICE_API_KEY = 'ak_control';
    process.env.GATEWAY_SERVICE_API_KEY = 'ak_gateway';
    const svc = make((_key, fallback) => fallback);
    expect(svc.directoryServiceApiKey).toBe('ak_control');
  });

  it('falls back to GATEWAY_SERVICE_API_KEY when control key is absent', () => {
    delete process.env.CONTROL_SERVICE_API_KEY;
    process.env.GATEWAY_SERVICE_API_KEY = 'ak_gateway';
    const svc = make((_key, fallback) => fallback);
    expect(svc.directoryServiceApiKey).toBe('ak_gateway');
  });

  it('returns empty directory key when neither env var is set', () => {
    delete process.env.CONTROL_SERVICE_API_KEY;
    delete process.env.GATEWAY_SERVICE_API_KEY;
    const svc = make((_key, fallback) => fallback);
    expect(svc.directoryServiceApiKey).toBe('');
  });

  it('passes through configured JWT and shutdown values', () => {
    const svc = make((key, fallback) => {
      const map: Record<string, unknown> = {
        'app.jwt.secret': 'secret-from-config',
        'app.jwt.expiresIn': '1h',
        'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
        'app.gracefulShutdown.forceShutdownTimeoutMs': 5000,
        'app.database.url': 'postgres://local/fairflow',
      };
      return map[key] ?? fallback;
    });
    expect(svc.jwtSecret).toBe('secret-from-config');
    expect(svc.jwtExpiresIn).toBe('1h');
    expect(svc.sleepBeforeShutdownMs).toBe(1000);
    expect(svc.forceShutdownTimeoutMs).toBe(5000);
    expect(svc.databaseUrl).toBe('postgres://local/fairflow');
  });
});
