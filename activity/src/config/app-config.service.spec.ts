import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const config = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'app.app.port': 3010,
        'app.app.host': '127.0.0.1',
        'app.app.nodeEnv': 'test',
        'app.database.url': 'mongodb://localhost:27017/fairflow',
        'app.jwt.secret': 'secret',
        'app.jwt.expiresIn': '1d',
        'app.cors.origin': 'https://app.test',
        'app.cors.credentials': true,
        'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
        'app.gracefulShutdown.forceShutdownTimeoutMs': 5000,
      };
      return key in values ? values[key] : defaultValue;
    }),
  };

  const svc = new AppConfigService(config as unknown as ConfigService);

  it('reads configured app/database/jwt/cors values', () => {
    expect(svc.port).toBe(3010);
    expect(svc.host).toBe('127.0.0.1');
    expect(svc.nodeEnv).toBe('test');
    expect(svc.databaseUrl).toBe('mongodb://localhost:27017/fairflow');
    expect(svc.jwtSecret).toBe('secret');
    expect(svc.jwtExpiresIn).toBe('1d');
    expect(svc.corsOrigin).toBe('https://app.test');
    expect(svc.corsCredentials).toBe(true);
    expect(svc.sleepBeforeShutdownMs).toBe(1000);
    expect(svc.forceShutdownTimeoutMs).toBe(5000);
  });

  it('falls back to defaults for unset keys', () => {
    const bare = new AppConfigService({ get: (_k: string, d?: unknown) => d } as ConfigService);
    expect(bare.port).toBe(3000);
    expect(bare.databaseUrl).toBe('');
    expect(bare.jwtSecret).toBe('change-me');
    expect(bare.corsOrigin).toBe('*');
  });
});
