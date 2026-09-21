import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { authValidationLoaderOptions } from '@fairflow/shared';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'AUTH_VALIDATION_GRPC',
        imports: [ConfigModule],
        useFactory: (c: AppConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.auth.v1',
            protoPath: proto('auth', 'v1', 'auth.proto'),
            url: c.authGrpcUrl,
            loader: authValidationLoaderOptions,
          },
        }),
        inject: [AppConfigService],
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
