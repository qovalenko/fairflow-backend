import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  function makeService(values: Record<string, unknown> = {}) {
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
      ),
    };
    return { svc: new AppConfigService(configService as never), configService };
  }

  it('reads http/grpc ports and control URL with defaults', () => {
    const { svc } = makeService();
    expect(svc.httpPort).toBe(3007);
    expect(svc.grpcProductPort).toBe(5007);
    expect(svc.controlGrpcUrl).toBe('127.0.0.1:5002');
  });

  it('reads configured database URL and jwt secret', () => {
    const { svc } = makeService({
      'app.database.url': 'mongodb://test/db',
      'app.jwt.secret': 'secret-1',
      'app.app.httpPort': 3011,
    });
    expect(svc.databaseUrl).toBe('mongodb://test/db');
    expect(svc.jwtSecret).toBe('secret-1');
    expect(svc.httpPort).toBe(3011);
  });
});
