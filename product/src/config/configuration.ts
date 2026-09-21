import { registerAs } from '@nestjs/config';

export interface AppConfig {
  httpPort: number;
  grpcProductPort: number;
}

export interface DatabaseConfig {
  url: string;
}

export interface JwtConfig {
  secret: string;
}

export default registerAs(
  'app',
  (): Record<string, unknown> => ({
    app: {
      httpPort: parseInt(process.env.HTTP_PORT ?? '3007', 10),
      grpcProductPort: parseInt(process.env.GRPC_PRODUCT_PORT ?? '5007', 10),
    },
    grpc: {
      // [#19] control client for domain-side deferred-scope hydration.
      controlUrl: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
    },
    database: {
      url: process.env.MONGODB_URI ?? '',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    },
  }),
);
