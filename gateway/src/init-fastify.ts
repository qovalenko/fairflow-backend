import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RequestContext } from './common/request-context';

const SYSTEM_PATHS = ['/metrics', '/healthz', '/readyz', '/docs', '/status', '/api-docs'];

const startTimeSymbol = Symbol.for('requestStartTime');

export function setupFastifyHooks(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    RequestContext.setCurrentRequest(request);
    const url = request.url?.split('?')[0] ?? '';
    if (SYSTEM_PATHS.some((p) => url === p || url.startsWith(p + '/'))) return;

    (request as unknown as Record<symbol, number>)[startTimeSymbol] = Date.now();
    const requestId = (request.headers['x-request-id'] as string) ?? randomUUID();
    const traceId =
      (request.headers['x-trace-id'] as string) ??
      (request.headers['traceparent'] as string)?.split('-')[1];
    const logger = RequestContext.getLogger().child({ requestId, traceId: traceId ?? undefined });
    RequestContext.set({ requestId, logger, traceId });
    logger.info({ method: request.method, url: request.url }, 'request start');
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url?.split('?')[0] ?? '';
    if (SYSTEM_PATHS.some((p) => url === p || url.startsWith(p + '/'))) return;

    const start = (request as unknown as Record<symbol, number>)[startTimeSymbol];
    const elapsed = typeof start === 'number' ? Date.now() - start : 0;
    const log = RequestContext.getLogger();
    const msg = elapsed > 5000 ? 'request end (slow)' : 'request end';
    log.info({ method: request.method, url, statusCode: reply.statusCode, elapsed }, msg);
    RequestContext.set(undefined);
  });
}
