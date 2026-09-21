import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const make = (values: Record<string, unknown> = {}) => {
    const configService = {
      get: jest.fn((key: string, fallback: unknown) => (key in values ? values[key] : fallback)),
    };
    return { svc: new AppConfigService(configService as never), configService };
  };

  it('reads configured values with typed getters', () => {
    const { svc } = make({
      'app.app.port': 3010,
      'app.app.host': '127.0.0.1',
      'app.app.nodeEnv': 'test',
      'app.app.grpcOrdersPort': 5010,
      'app.database.url': 'mongodb://x',
      'app.jwt.secret': 'secret',
      'app.jwt.expiresIn': '1h',
      'app.cors.origin': ['https://a'],
      'app.cors.credentials': true,
      'app.gracefulShutdown.sleepBeforeShutdownMs': 100,
      'app.gracefulShutdown.forceShutdownTimeoutMs': 2000,
    });

    expect(svc.port).toBe(3010);
    expect(svc.host).toBe('127.0.0.1');
    expect(svc.nodeEnv).toBe('test');
    expect(svc.grpcOrdersPort).toBe(5010);
    expect(svc.databaseUrl).toBe('mongodb://x');
    expect(svc.jwtSecret).toBe('secret');
    expect(svc.jwtExpiresIn).toBe('1h');
    expect(svc.corsOrigin).toEqual(['https://a']);
    expect(svc.corsCredentials).toBe(true);
    expect(svc.sleepBeforeShutdownMs).toBe(100);
    expect(svc.forceShutdownTimeoutMs).toBe(2000);
  });

  it('falls back to safe defaults when keys are absent', () => {
    const { svc } = make();
    expect(svc.port).toBe(3000);
    expect(svc.host).toBe('0.0.0.0');
    expect(svc.nodeEnv).toBe('development');
    expect(svc.grpcOrdersPort).toBe(5006);
    expect(svc.databaseUrl).toBe('');
    expect(svc.jwtSecret).toBe('change-me');
    expect(svc.corsOrigin).toBe('*');
    expect(svc.corsCredentials).toBe(false);
  });
});
