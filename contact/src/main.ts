import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
  RpcAppExceptionFilter,
} from '@fairflow/shared';
import { createApplication } from './application';
import { RequestContext } from './common/request-context';
import { createAppLogger } from './logger';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './health/readiness.service';

async function bootstrap() {
  const logger = createAppLogger();
  RequestContext.setAppLogger(logger);

  // Process-level safety net: a background reject/throw leaves a structured
  // (pino) trace (and uncaughtException → exit so orchestrator restarts clean).
  installProcessHandlers({ logger, service: 'contact' });

  const app = await createApplication();
  const config = app.get(AppConfigService);
  const readiness = app.get(ReadinessService);

  // Run from services/contact (cwd=contact) or from services (cwd=services)
  const fromDist = join(
    __dirname,
    '..',
    '..',
    'proto',
    'fairflow',
    'contact',
    'v1',
    'contact.proto',
  );
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', 'contact', 'v1', 'contact.proto');
  const fromCwdRoot = join(process.cwd(), 'proto', 'fairflow', 'contact', 'v1', 'contact.proto');
  const protoPath = existsSync(fromDist) ? fromDist : existsSync(fromCwd) ? fromCwd : fromCwdRoot;
  if (!existsSync(protoPath)) {
    logger.error({ fromDist, fromCwd, fromCwdRoot, cwd: process.cwd() }, 'Proto file not found');
    process.exit(1);
  }
  const microservice = app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.contact.v1',
        loader: { keepCase: true, longs: Number },
        protoPath,
        url: `0.0.0.0:${config.grpcPort}`,
      },
    },
    // Propagate global (APP_FILTER) config to the gRPC microservice (K-10).
    { inheritAppConfig: true },
  );
  // Bind the RPC filter directly on the microservice so it wins over the
  // inherited HTTP AppErrorFilter for gRPC handlers: domain AppError → proper
  // gRPC status instead of UNKNOWN 'Internal server error' (K-10).
  microservice.useGlobalFilters(new RpcAppExceptionFilter());
  await app.startAllMicroservices();
  if (isGrpcReflectionEnabled()) {
    const protoInclude = join(protoPath, '..', '..', '..', '..');
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoInclude] }]);
  }
  logger.info({ grpcPort: config.grpcPort }, 'Contact gRPC started');

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
