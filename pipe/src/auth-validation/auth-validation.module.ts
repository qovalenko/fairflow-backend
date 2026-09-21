import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  GrpcRolesGuard,
  CONTROL_VISIBILITY_GRPC,
  DeferredScopeHydrator,
  VISIBILITY_HYDRATE_METRICS,
  VisibilityScopeHydrationGuard,
  controlVisibilityClientProvider,
  authValidationLoaderOptions,
  type HydrateResult,
} from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';
import { GrpcInboundApiKeyGuard } from './grpc-inbound-api-key.guard';
import { MetricsModule } from '../metrics/metrics.module';
import { MetricsService } from '../metrics/metrics.service';

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

/**
 * Domain-side PEP wiring (SEC-BLOCKER 1, Д-2): validates the gateway
 * service-API-key on every business rpc (fail-closed) and enforces coarse
 * Manager+ role gates via the shared {@link GrpcRolesGuard}. Order matters —
 * the API-key guard (authn) runs before the roles guard (authz).
 */
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
    // [#19] MetricsModule exports the process-wide MetricsService (prom-client
    // Registry, exposed on /metrics). Imported here so the hydrator's optional
    // VISIBILITY_HYDRATE_METRICS sink can feed `visibility_hydrate_total{result}`.
    MetricsModule,
  ],
  providers: [
    GatewayApiKeyValidationService,
    Reflector,
    DeferredScopeHydrator,
    // [#19] Bind the hydrator's optional metrics sink to the domain MetricsService
    // so hit/miss/stale/deny/inline_skip land on `visibility_hydrate_total` (§4);
    // no-op elsewhere kept — only pipe (T1.5 domain) is instrumented for now.
    {
      provide: VISIBILITY_HYDRATE_METRICS,
      useFactory: (metrics: MetricsService) => (result: HydrateResult) =>
        metrics.recordVisibilityHydrate(result),
      inject: [MetricsService],
    },
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
