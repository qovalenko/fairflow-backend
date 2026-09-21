import { registerAs } from '@nestjs/config';

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
}

export interface DatabaseConfig {
  url: string;
}

export interface JwtConfig {
  secret: string;
  expiresIn: string;
}

export interface CorsConfig {
  origin: string | string[];
  credentials: boolean;
}

export interface GracefulShutdownConfig {
  sleepBeforeShutdownMs: number;
  forceShutdownTimeoutMs: number;
}

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  avatarsBucket: string;
  documentsBucket: string;
  publicBaseUrl: string;
}

export default registerAs(
  'app',
  (): Record<string, unknown> => ({
    app: {
      port: parseInt(process.env.LISTEN_PORT ?? process.env.PORT ?? '3000', 10),
      host: process.env.HOST ?? '0.0.0.0',
      nodeEnv: process.env.NODE_ENV ?? 'development',
      // Public base URL of the frontend (host) — used to build invitation links.
      publicUrl: (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    },
    database: {
      url: process.env.DATABASE_URL ?? '',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      expiresIn: process.env.JWT_EXPIRE ?? '24h',
    },
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
      credentials: process.env.CORS_CREDENTIALS === 'true',
    },
    gracefulShutdown: {
      sleepBeforeShutdownMs: parseInt(process.env.SLEEP_BEFORE_SHUTDOWN_MS ?? '5000', 10),
      forceShutdownTimeoutMs: parseInt(process.env.FORCE_SHUTDOWN_TIMEOUT_MS ?? '30000', 10),
    },
    gatewayService: {
      apiKey: process.env.GATEWAY_SERVICE_API_KEY ?? '',
      apiKeyId: process.env.GATEWAY_API_KEY_ID ?? '',
    },
    grpc: {
      authUrl: process.env.AUTH_GRPC_URL ?? '127.0.0.1:5001',
      controlUrl: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
      contactUrl: process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003',
      companyUrl: process.env.COMPANY_GRPC_URL ?? '127.0.0.1:5004',
      pipeUrl: process.env.PIPE_GRPC_URL ?? '127.0.0.1:5005',
      ordersUrl: process.env.ORDERS_GRPC_URL ?? '127.0.0.1:5006',
      productUrl: process.env.PRODUCT_GRPC_URL ?? '127.0.0.1:5007',
      activityUrl: process.env.ACTIVITY_GRPC_URL ?? '127.0.0.1:5008',
      documentsUrl: process.env.DOCUMENTS_GRPC_URL ?? '127.0.0.1:5010',
      reportsUrl: process.env.REPORTS_GRPC_URL ?? '127.0.0.1:5011',
      automationUrl: process.env.AUTOMATION_GRPC_URL ?? '127.0.0.1:5012',
      searchUrl: process.env.SEARCH_GRPC_URL ?? '127.0.0.1:5013',
      auditUrl: process.env.AUDIT_GRPC_URL ?? '127.0.0.1:5014',
      notificationUrl: process.env.NOTIFICATION_GRPC_URL ?? '127.0.0.1:5015',
      billingUrl: process.env.BILLING_GRPC_URL ?? '127.0.0.1:5016',
      // chat (M-CHAT-5): matches the chat domain listener (GRPC_CHAT_PORT,
      // contracts/chat.md §6). 5017 — 5016 is billing's canonical port.
      chatUrl: process.env.CHAT_GRPC_URL ?? '127.0.0.1:5017',
    },
    // chat realtime (M-CHAT-6): Redis Pub/Sub for cross-replica fanout of chat
    // frames (chat:conv:{id}), badge (chat:badge:{userId}) and presence TTL keys.
    // When `url` is empty / Redis is unreachable the gateway falls back to an
    // in-process EventEmitter (single-replica correct; documented seam).
    redis: {
      url: process.env.REDIS_URL ?? '',
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
      avatarsBucket: process.env.S3_AVATARS_BUCKET ?? 'fairflow-avatars',
      documentsBucket:
        process.env.S3_DOCUMENTS_BUCKET ?? process.env.S3_BUCKET ?? 'fairflow-documents',
      publicBaseUrl:
        process.env.S3_PUBLIC_BASE_URL ?? process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    },
  }),
);
