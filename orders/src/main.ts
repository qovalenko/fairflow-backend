import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Transport } from '@nestjs/microservices';
import { installProcessHandlers } from '@fairflow/shared';
import { createApplication } from './application';
import { RequestContext } from './common/request-context';
import { createAppLogger } from './logger';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './health/readiness.service';

function ordersProtoPath(): string {
  const fromDist = join(__dirname, '..', '..', 'proto', 'fairflow', 'orders', 'v1', 'orders.proto');
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', 'orders', 'v1', 'orders.proto');
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', 'orders', 'v1', 'orders.proto');
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

async function bootstrap() {
  const logger = createAppLogger();
  RequestContext.setAppLogger(logger);

  // Process-level safety net: a background reject/throw leaves a structured
  // (pino) trace (and uncaughtException → exit so orchestrator restarts clean).
  installProcessHandlers({ logger, service: 'orders' });

  const app = await createApplication();
  const config = app.get(AppConfigService);
  const readiness = app.get(ReadinessService);
  const protoPath = ordersProtoPath();
  const grpcPort = config.grpcOrdersPort;

  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.orders.v1',
      loader: { keepCase: true, longs: Number },
      protoPath,
      url: `0.0.0.0:${grpcPort}`,
    },
  });
  await app.startAllMicroservices();

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

  logger.info(
    { port: config.port, host: config.host, grpcPort, protoPath },
    'Orders service started',
  );
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed', err);
  process.exit(1);
});
