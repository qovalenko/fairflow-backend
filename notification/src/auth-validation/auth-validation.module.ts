import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { authValidationLoaderOptions } from '@fairflow/shared';

function authProtoPath(): string {
  const fromDist = join(
    __dirname,
    '..',
    '..',
    '..',
    'proto',
    'fairflow',
    'auth',
    'v1',
    'auth.proto',
  );
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', 'auth', 'v1', 'auth.proto');
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', 'auth', 'v1', 'auth.proto');
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'AUTH_VALIDATION_GRPC',
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.auth.v1',
            protoPath: authProtoPath(),
            url: process.env.AUTH_GRPC_URL ?? '127.0.0.1:5001',
            loader: authValidationLoaderOptions,
          },
        }),
      },
    ]),
  ],
  providers: [
    GatewayApiKeyValidationService,
    { provide: APP_GUARD, useClass: GrpcInboundApiKeyGuard },
  ],
  exports: [GatewayApiKeyValidationService, ClientsModule],
})
export class AuthValidationModule {}
