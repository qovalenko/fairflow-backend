import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AppErrorFilter } from '@fairflow/shared';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';
import { setupFastifyHooks } from './init-fastify';
import { PinoLoggerService } from './logger';

export async function createApplication(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: new PinoLoggerService() },
  );

  const config = app.get(AppConfigService);

  app.setGlobalPrefix('api', {
    exclude: ['healthz', 'readyz', 'metrics', 'docs', 'status'],
  });

  app.useGlobalFilters(new AppErrorFilter());
  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  setupFastifyHooks(app.getHttpAdapter().getInstance());

  const corsOrigin = config.corsOrigin;
  app.enableCors({
    origin: Array.isArray(corsOrigin) ? corsOrigin : corsOrigin,
    credentials: config.corsCredentials,
  });

  return app;
}
