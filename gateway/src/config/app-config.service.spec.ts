import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  function make(overrides: Record<string, unknown> = {}): AppConfigService {
    const store: Record<string, unknown> = {
      'app.app.port': 4000,
      'app.app.host': '127.0.0.1',
      'app.app.nodeEnv': 'test',
      'app.app.publicUrl': 'https://app.test',
      'app.database.url': 'postgres://local/fairflow',
      'app.jwt.secret': 'secret',
      'app.jwt.expiresIn': '1h',
      'app.cors.origin': ['https://app.test'],
      'app.cors.credentials': true,
      'app.gracefulShutdown.sleepBeforeShutdownMs': 1000,
      'app.gracefulShutdown.forceShutdownTimeoutMs': 5000,
      'app.gatewayService.apiKey': 'ak_test',
      'app.gatewayService.apiKeyId': 'key-1',
      'app.grpc.authUrl': '127.0.0.1:5001',
      'app.redis.url': 'redis://127.0.0.1:6379',
      'app.s3.endpoint': 'http://minio:9000',
      'app.s3.region': 'eu-west-1',
      'app.s3.accessKeyId': 'minio',
      'app.s3.secretAccessKey': 'minio',
      'app.s3.avatarsBucket': 'avatars',
      'app.s3.documentsBucket': 'documents',
      ...overrides,
    };
    const configService = {
      get: <T>(key: string, fallback?: T) => (store[key] as T | undefined) ?? fallback,
    };
    return new AppConfigService(configService as never);
  }

  it('reads configured app, jwt, cors and shutdown values', () => {
    const svc = make();
    expect(svc.port).toBe(4000);
    expect(svc.host).toBe('127.0.0.1');
    expect(svc.nodeEnv).toBe('test');
    expect(svc.appPublicUrl).toBe('https://app.test');
    expect(svc.databaseUrl).toBe('postgres://local/fairflow');
    expect(svc.jwtSecret).toBe('secret');
    expect(svc.jwtExpiresIn).toBe('1h');
    expect(svc.corsOrigin).toEqual(['https://app.test']);
    expect(svc.corsCredentials).toBe(true);
    expect(svc.sleepBeforeShutdownMs).toBe(1000);
    expect(svc.forceShutdownTimeoutMs).toBe(5000);
  });

  it('exposes gateway service key pair and gRPC endpoints', () => {
    const svc = make();
    expect(svc.gatewayServiceApiKey).toBe('ak_test');
    expect(svc.gatewayApiKeyId).toBe('key-1');
    expect(svc.grpcAuthUrl).toBe('127.0.0.1:5001');
    expect(svc.grpcChatUrl).toBe('127.0.0.1:5017');
    expect(svc.grpcBillingUrl).toBe('127.0.0.1:5016');
  });

  it('falls back to safe defaults when keys are absent', () => {
    const svc = make({
      'app.app.port': undefined,
      'app.jwt.secret': undefined,
      'app.s3.publicBaseUrl': undefined,
    });
    expect(svc.port).toBe(3000);
    expect(svc.jwtSecret).toBe('change-me');
    expect(svc.s3PublicBaseUrl).toBe('http://minio:9000');
  });

  it('reads redis and s3 storage settings', () => {
    const svc = make();
    expect(svc.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(svc.s3AvatarsBucket).toBe('avatars');
    expect(svc.s3DocumentsBucket).toBe('documents');
  });

  it('exposes all downstream gRPC endpoint URLs with defaults', () => {
    const svc = make({
      'app.grpc.controlUrl': '127.0.0.1:5002',
      'app.grpc.contactUrl': '127.0.0.1:5003',
      'app.grpc.companyUrl': '127.0.0.1:5004',
      'app.grpc.pipeUrl': '127.0.0.1:5005',
      'app.grpc.ordersUrl': '127.0.0.1:5006',
      'app.grpc.productUrl': '127.0.0.1:5007',
      'app.grpc.activityUrl': '127.0.0.1:5008',
      'app.grpc.documentsUrl': '127.0.0.1:5010',
      'app.grpc.reportsUrl': '127.0.0.1:5011',
      'app.grpc.automationUrl': '127.0.0.1:5012',
      'app.grpc.searchUrl': '127.0.0.1:5013',
      'app.grpc.auditUrl': '127.0.0.1:5014',
      'app.grpc.notificationUrl': '127.0.0.1:5015',
    });

    expect(svc.grpcControlUrl).toBe('127.0.0.1:5002');
    expect(svc.grpcContactUrl).toBe('127.0.0.1:5003');
    expect(svc.grpcCompanyUrl).toBe('127.0.0.1:5004');
    expect(svc.grpcPipeUrl).toBe('127.0.0.1:5005');
    expect(svc.grpcOrdersUrl).toBe('127.0.0.1:5006');
    expect(svc.grpcProductUrl).toBe('127.0.0.1:5007');
    expect(svc.grpcActivityUrl).toBe('127.0.0.1:5008');
    expect(svc.grpcDocumentsUrl).toBe('127.0.0.1:5010');
    expect(svc.grpcReportsUrl).toBe('127.0.0.1:5011');
    expect(svc.grpcAutomationUrl).toBe('127.0.0.1:5012');
    expect(svc.grpcSearchUrl).toBe('127.0.0.1:5013');
    expect(svc.grpcAuditUrl).toBe('127.0.0.1:5014');
    expect(svc.grpcNotificationUrl).toBe('127.0.0.1:5015');
  });
});
