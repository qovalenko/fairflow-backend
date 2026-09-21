import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get port(): number {
    return this.configService.get<number>('app.app.port', 3000);
  }

  get host(): string {
    return this.configService.get<string>('app.app.host', '0.0.0.0');
  }

  get nodeEnv(): string {
    return this.configService.get<string>('app.app.nodeEnv', 'development');
  }

  /** Public base URL of the frontend host (for invitation accept links). */
  get appPublicUrl(): string {
    return this.configService.get<string>('app.app.publicUrl', 'http://localhost:5173');
  }

  get databaseUrl(): string {
    return this.configService.get<string>('app.database.url', '');
  }

  get jwtSecret(): string {
    return this.configService.get<string>('app.jwt.secret', 'change-me');
  }

  get jwtExpiresIn(): string {
    return this.configService.get<string>('app.jwt.expiresIn', '24h');
  }

  get corsOrigin(): string | string[] {
    return this.configService.get<string | string[]>('app.cors.origin', '*');
  }

  get corsCredentials(): boolean {
    return this.configService.get<boolean>('app.cors.credentials', false);
  }

  get sleepBeforeShutdownMs(): number {
    return this.configService.get<number>('app.gracefulShutdown.sleepBeforeShutdownMs', 5000);
  }

  get forceShutdownTimeoutMs(): number {
    return this.configService.get<number>('app.gracefulShutdown.forceShutdownTimeoutMs', 30000);
  }

  get gatewayServiceApiKey(): string {
    return this.configService.get<string>('app.gatewayService.apiKey', '');
  }

  get gatewayApiKeyId(): string {
    return this.configService.get<string>('app.gatewayService.apiKeyId', '');
  }

  get grpcAuthUrl(): string {
    return this.configService.get<string>('app.grpc.authUrl', '127.0.0.1:5001');
  }
  get grpcControlUrl(): string {
    return this.configService.get<string>('app.grpc.controlUrl', '127.0.0.1:5002');
  }
  get grpcContactUrl(): string {
    return this.configService.get<string>('app.grpc.contactUrl', '127.0.0.1:5003');
  }
  get grpcCompanyUrl(): string {
    return this.configService.get<string>('app.grpc.companyUrl', '127.0.0.1:5004');
  }
  get grpcPipeUrl(): string {
    return this.configService.get<string>('app.grpc.pipeUrl', '127.0.0.1:5005');
  }
  get grpcOrdersUrl(): string {
    return this.configService.get<string>('app.grpc.ordersUrl', '127.0.0.1:5006');
  }
  get grpcProductUrl(): string {
    return this.configService.get<string>('app.grpc.productUrl', '127.0.0.1:5007');
  }
  get grpcActivityUrl(): string {
    return this.configService.get<string>('app.grpc.activityUrl', '127.0.0.1:5008');
  }
  get grpcDocumentsUrl(): string {
    return this.configService.get<string>('app.grpc.documentsUrl', '127.0.0.1:5010');
  }
  get grpcReportsUrl(): string {
    return this.configService.get<string>('app.grpc.reportsUrl', '127.0.0.1:5011');
  }
  get grpcAutomationUrl(): string {
    return this.configService.get<string>('app.grpc.automationUrl', '127.0.0.1:5012');
  }
  get grpcSearchUrl(): string {
    return this.configService.get<string>('app.grpc.searchUrl', '127.0.0.1:5013');
  }
  get grpcAuditUrl(): string {
    return this.configService.get<string>('app.grpc.auditUrl', '127.0.0.1:5014');
  }
  get grpcNotificationUrl(): string {
    return this.configService.get<string>('app.grpc.notificationUrl', '127.0.0.1:5015');
  }
  get grpcBillingUrl(): string {
    return this.configService.get<string>('app.grpc.billingUrl', '127.0.0.1:5016');
  }
  get grpcChatUrl(): string {
    return this.configService.get<string>('app.grpc.chatUrl', '127.0.0.1:5017');
  }

  /** chat realtime (M-CHAT-6): Redis connection URL; empty → in-process fallback. */
  get redisUrl(): string {
    return this.configService.get<string>('app.redis.url', '');
  }

  get s3Endpoint(): string {
    return this.configService.get<string>('app.s3.endpoint', 'http://127.0.0.1:9000');
  }

  get s3Region(): string {
    return this.configService.get<string>('app.s3.region', 'us-east-1');
  }

  get s3AccessKeyId(): string {
    return this.configService.get<string>('app.s3.accessKeyId', 'minioadmin');
  }

  get s3SecretAccessKey(): string {
    return this.configService.get<string>('app.s3.secretAccessKey', 'minioadmin');
  }

  get s3AvatarsBucket(): string {
    return this.configService.get<string>('app.s3.avatarsBucket', 'fairflow-avatars');
  }

  get s3DocumentsBucket(): string {
    return this.configService.get<string>('app.s3.documentsBucket', 'fairflow-documents');
  }

  get s3PublicBaseUrl(): string {
    return this.configService.get<string>('app.s3.publicBaseUrl', this.s3Endpoint);
  }
}
