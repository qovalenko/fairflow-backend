import configuration from './configuration';

describe('configuration', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  it('подставляет значения по умолчанию, если переменные окружения не заданы', () => {
    delete process.env.LISTEN_PORT;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.NODE_ENV;
    delete process.env.GRPC_ORDERS_PORT;
    delete process.env.MONGODB_URI;
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRE;
    delete process.env.CORS_ORIGIN;
    delete process.env.CORS_CREDENTIALS;
    delete process.env.SLEEP_BEFORE_SHUTDOWN_MS;
    delete process.env.FORCE_SHUTDOWN_TIMEOUT_MS;

    const cfg = configuration() as {
      app: { port: number; host: string; nodeEnv: string; grpcOrdersPort: number };
      database: { url: string };
      jwt: { secret: string; expiresIn: string };
      cors: { origin: string; credentials: boolean };
      gracefulShutdown: { sleepBeforeShutdownMs: number; forceShutdownTimeoutMs: number };
    };

    expect(cfg.app).toEqual({
      port: 3010,
      host: '0.0.0.0',
      nodeEnv: 'development',
      grpcOrdersPort: 5006,
    });
    expect(cfg.database.url).toBe('');
    expect(cfg.jwt).toEqual({ secret: 'change-me-in-production', expiresIn: '7d' });
    expect(cfg.cors).toEqual({ origin: '*', credentials: false });
    expect(cfg.gracefulShutdown).toEqual({
      sleepBeforeShutdownMs: 5000,
      forceShutdownTimeoutMs: 30000,
    });
  });

  it('читает LISTEN_PORT, MONGODB_URI и CORS_CREDENTIALS из окружения', () => {
    process.env.LISTEN_PORT = '3099';
    process.env.MONGODB_URI = 'mongodb://custom:27017/ff';
    process.env.CORS_CREDENTIALS = 'true';
    process.env.CORS_ORIGIN = 'https://crm.example';
    process.env.GRPC_ORDERS_PORT = '5010';

    const cfg = configuration() as {
      app: { port: number; grpcOrdersPort: number };
      database: { url: string };
      cors: { origin: string; credentials: boolean };
    };

    expect(cfg.app.port).toBe(3099);
    expect(cfg.app.grpcOrdersPort).toBe(5010);
    expect(cfg.database.url).toBe('mongodb://custom:27017/ff');
    expect(cfg.cors).toEqual({ origin: 'https://crm.example', credentials: true });
  });

  it('fallback PORT, если LISTEN_PORT не задан', () => {
    delete process.env.LISTEN_PORT;
    process.env.PORT = '3020';

    const cfg = configuration() as { app: { port: number } };
    expect(cfg.app.port).toBe(3020);
  });
});
