import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  app: {
    port: parseInt(process.env.PORT ?? process.env.HTTP_PORT ?? '3011', 10),
    host: process.env.HOST ?? '0.0.0.0',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    grpcBillingPort: parseInt(process.env.GRPC_BILLING_PORT ?? '5016', 10),
  },
  grpc: {
    authValidationUrl: process.env.AUTH_GRPC_URL ?? '127.0.0.1:5001',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
}));
