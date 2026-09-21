import { registerAs } from '@nestjs/config';

export default registerAs(
  'app',
  (): Record<string, unknown> => ({
    grpc: {
      port: parseInt(process.env.GRPC_PORT ?? '5001', 10),
    },
    app: {
      port: parseInt(process.env.PORT ?? '3001', 10),
      host: process.env.HOST ?? '0.0.0.0',
      nodeEnv: process.env.NODE_ENV ?? 'development',
    },
    database: {
      url: process.env.DATABASE_URL ?? '',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? 'change-me-min-32-chars-for-production',
      accessExpire: process.env.JWT_ACCESS_EXPIRE ?? '15m',
      refreshExpire: process.env.JWT_REFRESH_EXPIRE ?? '7d',
    },
    oauth2: {
      issuer: process.env.OAUTH2_ISSUER ?? 'http://localhost:3001',
    },
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
      credentials: process.env.CORS_CREDENTIALS === 'true',
    },
  }),
);
