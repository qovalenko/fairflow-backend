import { join } from 'node:path';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
  RpcAppExceptionFilter,
} from '@fairflow/shared';
import { createApplication } from './application';
import { GrpcInboundApiKeyGuard } from './auth-validation/grpc-inbound-api-key.guard';
import { GatewayApiKeyValidationService } from './auth-validation/gateway-api-key-validation.service';
import { RequestContext } from './common/request-context';
import { createAppLogger } from './logger';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './health/readiness.service';

async function bootstrap() {
  const logger = createAppLogger();
  RequestContext.setAppLogger(logger);

  // Process-level safety net: a background reject/throw leaves a structured
  // (pino) trace (and uncaughtException → exit so orchestrator restarts clean).
  installProcessHandlers({ logger, service: 'control' });

  const app = await createApplication();
  const config = app.get(AppConfigService);
  const readiness = app.get(ReadinessService);

  const protoPath = join(
    __dirname,
    '..',
    '..',
    'proto',
    'fairflow',
    'control',
    'v1',
    'control.proto',
  );
  const microservice = app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.control.v1',
      protoPath,
      url: `0.0.0.0:${config.grpcPort}`,
      loader: {
        keepCase: true,
        // int64 → plain JS number. Without it proto-loader decodes int64 as a
        // Long {low,high,unsigned} object while TS still sees the declared
        // `number` — silent corruption on every timestamp/counter.
        longs: Number,
      },
    },
  });
  // K-10: control was the last domain without an RPC exception filter — every
  // `AppError` thrown by the gRPC controller / ProjectsService left Nest as an
  // unknown error → gRPC UNKNOWN(2) → gateway HTTP 500 «Internal error», and the
  // structured `details` were dropped on the floor (they only travel through the
  // `x-error-details-bin` trailer this filter writes). Concretely: the dependency
  // cascade refusal (TODO-240) raises AppError('locked', …, {moduleId, dependents})
  // and the FE has a branch that lists the dependants — unreachable while the
  // status was 500. With the filter: locked → FAILED_PRECONDITION → 422 + details,
  // 'auth'/'access' (TODO-085 PEP) → UNAUTHENTICATED/PERMISSION_DENIED → 401/403.
  // Bound on the microservice only (no `inheritAppConfig`): the HTTP AppErrorFilter
  // from application.ts must stay the one handling /healthz|/readyz|/metrics.
  microservice.useGlobalFilters(new RpcAppExceptionFilter());
  // APP_GUARD from AuthValidationModule applies to HTTP only unless inherited;
  // hybrid gRPC must register the PEP explicitly (see pipe `inheritAppConfig`).
  microservice.useGlobalGuards(new GrpcInboundApiKeyGuard(app.get(GatewayApiKeyValidationService)));
  await app.startAllMicroservices();
  if (isGrpcReflectionEnabled()) {
    const protoInclude = join(protoPath, '..', '..', '..', '..');
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoInclude] }]);
  }
  logger.info({ grpcPort: config.grpcPort }, 'Control gRPC started');

  await app.listen(config.port, config.host);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    readiness.setReady(false);
    const sleepMs = config.sleepBeforeShutdownMs;
    logger.info({ sleepMs }, 'Sleeping before shutdown');
    await new Promise((r) => setTimeout(r, sleepMs));
    const timeoutMs = config.forceShutdownTimeoutMs;
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs),
      ),
    ]).catch((err) => {
      logger.error({ err }, 'Shutdown error');
      process.exitCode = 1;
    });
    process.exit(process.exitCode ?? 0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info({ port: config.port, host: config.host }, 'Application started');
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed', err);
  process.exit(1);
});
