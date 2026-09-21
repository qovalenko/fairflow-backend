import { of, throwError } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { MetricsInterceptor } from './metrics.interceptor';

function httpCtx(over: {
  method?: string;
  url?: string;
  routeUrl?: string;
  statusCode?: number;
} = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: over.method ?? 'GET',
        url: over.url ?? '/healthz',
        routeOptions: over.routeUrl === undefined ? { url: over.url ?? '/healthz' } : { url: over.routeUrl },
      }),
      getResponse: () => ({ statusCode: over.statusCode }),
    }),
  } as ExecutionContext;
}

describe('MetricsInterceptor', () => {
  it('на успехе пишет recordRequest(method, route, status, duration)', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as never);
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(httpCtx({ statusCode: 200 }), next));

    expect(metrics.recordRequest).toHaveBeenCalledWith(
      'GET',
      '/healthz',
      200,
      expect.any(Number),
    );
  });

  it('на ошибке пишет recordRequest со status 500 если reply пустой', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as never);
    const next: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(
      lastValueFrom(interceptor.intercept(httpCtx({ statusCode: undefined }), next)),
    ).rejects.toThrow('boom');

    expect(metrics.recordRequest).toHaveBeenCalledWith(
      'GET',
      '/healthz',
      500,
      expect.any(Number),
    );
  });

  it('берёт route из req.url если routeOptions.url нет', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as never);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/readyz', routeOptions: {} }),
        getResponse: () => ({ statusCode: 201 }),
      }),
    } as ExecutionContext;

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(null) }));

    expect(metrics.recordRequest).toHaveBeenCalledWith(
      'POST',
      '/readyz',
      201,
      expect.any(Number),
    );
  });
});
