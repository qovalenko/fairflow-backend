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

  it('returns configured values', () => {
    const svc = build({
      'app.app.port': 3012,
      'app.app.host': '127.0.0.1',
      'app.app.nodeEnv': 'test',
      'app.database.url': 'mongodb://pipe',
      'app.jwt.secret': 'secret',
      'app.jwt.expiresIn': '1d',
      'app.cors.origin': 'https://app.test',
      'app.cors.credentials': true,
      'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
      'app.gracefulShutdown.forceShutdownTimeoutMs': 5000,
    });
    expect(svc.port).toBe(3012);
    expect(svc.host).toBe('127.0.0.1');
    expect(svc.nodeEnv).toBe('test');
    expect(svc.databaseUrl).toBe('mongodb://pipe');
    expect(svc.jwtSecret).toBe('secret');
    expect(svc.jwtExpiresIn).toBe('1d');
    expect(svc.corsOrigin).toBe('https://app.test');
    expect(svc.corsCredentials).toBe(true);
    expect(svc.sleepBeforeShutdownMs).toBe(1000);
    expect(svc.forceShutdownTimeoutMs).toBe(5000);
  });

  it('falls back to documented defaults when config keys are absent', () => {
    const svc = build({});
    expect(svc.port).toBe(3000);
    expect(svc.host).toBe('0.0.0.0');
    expect(svc.nodeEnv).toBe('development');
    expect(svc.databaseUrl).toBe('');
    expect(svc.jwtSecret).toBe('change-me');
    expect(svc.jwtExpiresIn).toBe('7d');
    expect(svc.corsOrigin).toBe('*');
    expect(svc.corsCredentials).toBe(false);
    expect(svc.sleepBeforeShutdownMs).toBe(5000);
    expect(svc.forceShutdownTimeoutMs).toBe(30000);
  });
});
