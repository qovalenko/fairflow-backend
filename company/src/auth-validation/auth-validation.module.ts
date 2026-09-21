import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import {
  GrpcRolesGuard,
  CONTROL_VISIBILITY_GRPC,
  DeferredScopeHydrator,
  VisibilityScopeHydrationGuard,
  controlVisibilityClientProvider,
  authValidationLoaderOptions,
} from '@fairflow/shared';

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
      // [#19] control client for domain-side deferred-scope hydration. Config is
      // deduped into the shared `controlVisibilityClientProvider` factory so the
      // loader options (keepCase:true — MUST match the hydrator's snake_case request
      // keys, else hydration silently no-ops) and the raised receive limit stay in
      // one place. The inline response for very large orgs may exceed the default
      // 4 MiB grpc-js message limit (plan §9).
      {
        name: CONTROL_VISIBILITY_GRPC,
        imports: [ConfigModule],
        useFactory: (c: AppConfigService) =>
          controlVisibilityClientProvider(
            c.controlGrpcUrl,
            proto('control', 'v1', 'control.proto'),
          ),
        inject: [AppConfigService],
      },
    ]),
  ],
  providers: [
    GatewayApiKeyValidationService,
    DeferredScopeHydrator,
    { provide: APP_GUARD, useClass: GrpcInboundApiKeyGuard },
    // [#19] MUST run AFTER GrpcInboundApiKeyGuard (key validated first): hydrates a
    // deferred x-visibility-scope by re-asking control, then stamps the resolved
    // scope back into metadata before the handler. Fail-closed if control is down.
    { provide: APP_GUARD, useClass: VisibilityScopeHydrationGuard },
    { provide: APP_GUARD, useClass: GrpcRolesGuard },
  ],
  exports: [GatewayApiKeyValidationService, ClientsModule],
})
export class AuthValidationModule {}
