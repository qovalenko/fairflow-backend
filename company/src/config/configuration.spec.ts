import configuration from './configuration';

describe('configuration registerAs', () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'GRPC_PORT',
      'AUTH_GRPC_URL',
      'CONTROL_GRPC_URL',
      'LISTEN_PORT',
      'PORT',
      'HOST',
      'NODE_ENV',
      'MONGODB_URI',
      'JWT_SECRET',
      'JWT_EXPIRE',
      'CORS_ORIGIN',
      'CORS_CREDENTIALS',
      'SLEEP_BEFORE_SHUTDOWN_MS',
      'FORCE_SHUTDOWN_TIMEOUT_MS',
    ]) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('maps env vars into nested app config with company defaults', () => {
    process.env.GRPC_PORT = '5104';
    process.env.AUTH_GRPC_URL = 'auth:5001';
    process.env.CONTROL_GRPC_URL = 'control:5002';
    process.env.PORT = '3104';
    process.env.HOST = '127.0.0.1';
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = 'mongodb://localhost/companies';
    process.env.JWT_SECRET = 'secret';
    process.env.JWT_EXPIRE = '1h';
    process.env.CORS_ORIGIN = 'https://crm.example';
    process.env.CORS_CREDENTIALS = 'true';
    process.env.SLEEP_BEFORE_SHUTDOWN_MS = '1000';
    process.env.FORCE_SHUTDOWN_TIMEOUT_MS = '2000';

    const cfg = configuration() as {
      grpc: { port: number; authValidationUrl: string; controlUrl: string };
      app: { port: number; host: string; nodeEnv: string };
      database: { url: string };
      jwt: { secret: string; expiresIn: string };
      cors: { origin: string; credentials: boolean };
      gracefulShutdown: { sleepBeforeShutdownMs: number; forceShutdownTimeoutMs: number };
    };

    expect(cfg.grpc).toEqual({
      port: 5104,
      authValidationUrl: 'auth:5001',
      controlUrl: 'control:5002',
    });
    expect(cfg.app).toEqual({ port: 3104, host: '127.0.0.1', nodeEnv: 'test' });
    expect(cfg.database.url).toBe('mongodb://localhost/companies');
    expect(cfg.jwt).toEqual({ secret: 'secret', expiresIn: '1h' });
    expect(cfg.cors).toEqual({ origin: 'https://crm.example', credentials: true });
    expect(cfg.gracefulShutdown).toEqual({
      sleepBeforeShutdownMs: 1000,
      forceShutdownTimeoutMs: 2000,
    });
  });

  it('falls back to built-in defaults when env is unset', () => {
    const cfg = configuration() as {
      grpc: { port: number };
      app: { port: number; host: string; nodeEnv: string };
      cors: { credentials: boolean };
    };
    expect(cfg.grpc.port).toBe(5004);
    expect(cfg.app.port).toBe(3004);
    expect(cfg.app.host).toBe('0.0.0.0');
    expect(cfg.app.nodeEnv).toBe('development');
    expect(cfg.cors.credentials).toBe(false);
  });
});
