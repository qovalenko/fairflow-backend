import { lastValueFrom, of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import type { MetricsService } from './metrics.service';

function httpCtx(
  opts: { method?: string; url?: string; route?: string | null; statusCode?: number } = {},
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method ?? 'GET',
        url: opts.url ?? '/healthz',
        routeOptions: opts.route === null ? {} : { url: opts.route ?? opts.url ?? '/healthz' },
      }),
      getResponse: () => ({ statusCode: opts.statusCode }),
    }),
  } as never;
}

describe('MetricsInterceptor', () => {
  it('records a successful HTTP request with route and status', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as unknown as MetricsService);

    await lastValueFrom(
      interceptor.intercept(httpCtx({ statusCode: 200 }), { handle: () => of('ok') }),
    );

    expect(metrics.recordRequest).toHaveBeenCalledWith('GET', '/healthz', 200, expect.any(Number));
  });

  it('records a failed HTTP request and falls back to status 500', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as unknown as MetricsService);

    await expect(
      lastValueFrom(
        interceptor.intercept(httpCtx({ method: 'POST', url: '/readyz', statusCode: undefined }), {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(metrics.recordRequest).toHaveBeenCalledWith('POST', '/readyz', 500, expect.any(Number));
  });

  it('uses req.url when routeOptions.url is missing', async () => {
    const metrics = { recordRequest: jest.fn() };
    const interceptor = new MetricsInterceptor(metrics as unknown as MetricsService);

    await lastValueFrom(
      interceptor.intercept(httpCtx({ url: '/status', route: null, statusCode: 204 }), {
        handle: () => of(null),
      }),
    );

    expect(metrics.recordRequest).toHaveBeenCalledWith('GET', '/status', 204, expect.any(Number));
  });
});
