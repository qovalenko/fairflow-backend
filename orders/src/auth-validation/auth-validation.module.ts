import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
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

function protoPath(...parts: string[]): string {
  const fromDist = join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', ...parts);
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', ...parts);
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

function authProtoPath(): string {
  return protoPath('auth', 'v1', 'auth.proto');
}

function controlProtoPath(): string {
  return protoPath('control', 'v1', 'control.proto');
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
      // [#19] control client for domain-side deferred-scope hydration. Config is
      // deduped into the shared `controlVisibilityClientProvider` factory so the
      // loader options (keepCase:true — MUST match the hydrator's snake_case request
      // keys, else hydration silently no-ops) and the raised receive limit stay in
      // one place. The inline response for very large orgs may exceed the default
      // 4 MiB grpc-js message limit (plan §9).
      {
        name: CONTROL_VISIBILITY_GRPC,
        useFactory: () =>
          controlVisibilityClientProvider(
            process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
            controlProtoPath(),
          ),
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
