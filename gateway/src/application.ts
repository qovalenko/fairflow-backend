import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { ChatStreamService } from './bff/chat-stream.service';
import { ChatRealtimeAccessService } from './bff/chat-realtime-access.service';
import { GatewayEventsService } from './events/gateway-events.service';
import { registerChatWebsocket } from './bff/chat-ws.gateway';
import { AppErrorFilter } from './common/app-error.filter';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';
import { setupFastifyHooks } from './init-fastify';
import { setupSwagger } from './init-swagger';
import { JwtOrPublicGuard } from './auth/guards/jwt-or-public.guard';
import { SessionDenyListService } from './auth/session-deny-list.service';
import { PinoLoggerService } from './logger';

/**
 * Compat shim (T-017): the `documents` micro-frontend remote is built without
 * `VITE_API_PREFIX=/api/v1`, so its API client falls back to the `/api` default
 * and calls `/api/document-templates…`, `/api/documents…`, `/api/document-variables`
 * (no version segment). Those paths do not match the URI-versioned BFF routes
 * (mounted at `/api/v1/…`), so the gateway answered 404 (`Cannot GET
 * /api/documents?projectId=…`) and the SCR-DOCUMENTS screen showed "Не удалось
 * загрузить документы". This runs before routing and re-inserts the `/v1`
 * segment for the documents REST surface only, so the mis-built remote reaches
 * the real handlers. Correctly-versioned callers (`/api/v1/…`) are untouched.
 *
 * TODO(fe): drop this once the documents remote build injects the version prefix
 * (align it with the host build). Kept narrow (documents paths only) on purpose.
 */
function rewriteDocumentsAlias(url: string | undefined): string {
  const u = url ?? '';
  if (u.startsWith('/api/document')) {
    // '/api'.length === 4 → '/api/documents?…' becomes '/api/v1/documents?…'
    return '/api/v1' + u.slice(4);
  }
  return u;
}

export async function createApplication(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      rewriteUrl: (req: { url?: string }) => rewriteDocumentsAlias(req.url),
    }),
    { logger: new PinoLoggerService() },
  );

  const config = app.get(AppConfigService);

  app.setGlobalPrefix('api', {
    exclude: ['healthz', 'readyz', 'metrics', 'docs', 'status'],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  app.useGlobalFilters(new AppErrorFilter(app.get(GatewayEventsService)));
  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));
  app.useGlobalGuards(
    new JwtOrPublicGuard(app.get(Reflector), app.get(SessionDenyListService, { strict: false })),
  );

  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // chat realtime (M-CHAT-5): WS terminator on the raw Fastify instance. Optional —
  // a missing @fastify/websocket must not break bootstrap (degrades to SSE).
  try {
    const wsPlugin = await import('@fastify/websocket').catch(() => null);
    if (wsPlugin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fastify.register((wsPlugin as any).default ?? wsPlugin);
      registerChatWebsocket(
        fastify,
        app.get(ChatStreamService),
        config.jwtSecret,
        app.get(ChatRealtimeAccessService),
        (total) => app.get(MetricsService).setChatWsConnections(total),
      );
    }
  } catch {
    // No WS transport available → clients fall back to SSE (/api/v1/chat/stream).
  }

  setupFastifyHooks(fastify);
  setupSwagger(app, config);

  const corsOrigin = config.corsOrigin;
  app.enableCors({
    origin: Array.isArray(corsOrigin) ? corsOrigin : corsOrigin,
    credentials: config.corsCredentials,
    // TODO-158 / выгрузки CSV/JSON: без Access-Control-Expose-Headers браузер не
    // отдаёт метаданные частичного экспорта в JS — признак усечения снова «молчит».
    exposedHeaders: [
      'Content-Disposition',
      'X-Export-Count',
      'X-Export-Row-Count',
      'X-Export-Total',
      'X-Export-Truncated',
      // Строки выгружены все, а имена в них — не все (бюджет резолва исчерпан).
      'X-Export-Names-Incomplete',
    ],
  });

  return app;
}
