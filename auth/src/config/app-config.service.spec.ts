import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const makeSvc = (values: Record<string, unknown>) => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
      ),
    } as unknown as ConfigService;
    return { svc: new AppConfigService(config), config };
  };

  it('reads grpc/app ports and host with defaults', () => {
    const { svc, config } = makeSvc({});
    expect(svc.grpcPort).toBe(5001);
    expect(svc.port).toBe(3001);
    expect(svc.host).toBe('0.0.0.0');
    expect(config.get).toHaveBeenCalledWith('app.grpc.port', 5001);
  });

  it('reads database URL and JWT settings', () => {
    const { svc } = makeSvc({
      'app.database.url': 'postgres://u:p@db/fairflow',
      'app.jwt.secret': 'sekrit',
      'app.jwt.accessExpire': '30m',
      'app.jwt.refreshExpire': '14d',
    });
    expect(svc.databaseUrl).toBe('postgres://u:p@db/fairflow');
    expect(svc.jwtSecret).toBe('sekrit');
    expect(svc.jwtAccessExpire).toBe('30m');
    expect(svc.jwtRefreshExpire).toBe('14d');
  });

  it('reads oauth2 issuer and CORS settings', () => {
    const { svc } = makeSvc({
      'app.oauth2.issuer': 'https://auth.example.com',
      'app.cors.origin': ['https://crm.example.com'],
      'app.cors.credentials': true,
    });
    expect(svc.oauth2Issuer).toBe('https://auth.example.com');
    expect(svc.corsOrigin).toEqual(['https://crm.example.com']);
    expect(svc.corsCredentials).toBe(true);
  });
});
