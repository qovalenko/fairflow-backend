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

export default registerAs(
  'app',
  (): Record<string, unknown> => ({
    grpc: {
      port: parseInt(process.env.GRPC_PORT ?? '5002', 10),
      authValidationUrl: process.env.AUTH_GRPC_URL ?? '127.0.0.1:5001',
      billingUrl: process.env.BILLING_GRPC_URL ?? '127.0.0.1:5016',
    },
    app: {
      port: parseInt(process.env.LISTEN_PORT ?? process.env.PORT ?? '3002', 10),
      host: process.env.HOST ?? '0.0.0.0',
      nodeEnv: process.env.NODE_ENV ?? 'development',
    },
    database: {
      url: process.env.DATABASE_URL ?? '',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      expiresIn: process.env.JWT_EXPIRE ?? '7d',
    },
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
      credentials: process.env.CORS_CREDENTIALS === 'true',
    },
    gracefulShutdown: {
      sleepBeforeShutdownMs: parseInt(process.env.SLEEP_BEFORE_SHUTDOWN_MS ?? '5000', 10),
      forceShutdownTimeoutMs: parseInt(process.env.FORCE_SHUTDOWN_TIMEOUT_MS ?? '30000', 10),
    },
  }),
);
