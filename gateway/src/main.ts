import { installProcessHandlers } from '@fairflow/shared';
import { createApplication } from './application';
import { RequestContext } from './common/request-context';
import { createAppLogger } from './logger';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './health/readiness.service';

async function bootstrap() {
  const logger = createAppLogger();
  RequestContext.setAppLogger(logger);

  // Process-level safety net: a background reject/throw must leave a structured
  // (pino) trace instead of a bare stderr dump — and never limp on after an
  // uncaughtException (exit → orchestrator restarts a clean instance).
  installProcessHandlers({ logger, service: 'gateway' });

  const app = await createApplication();
  const config = app.get(AppConfigService);
  const readiness = app.get(ReadinessService);

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
