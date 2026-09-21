import { of, throwError } from 'rxjs';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';

describe('MetricsController', () => {
  it('returns prometheus text from MetricsService and sets the canonical Content-Type', async () => {
    const metrics = {
      getMetrics: jest.fn().mockResolvedValue('# HELP foo\nfoo 1\n'),
    } as unknown as MetricsService;
    const ctrl = new MetricsController(metrics);
    const text = await ctrl.getMetrics();
    expect(text).toContain('foo 1');
    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      MetricsController.prototype.getMetrics,
    ) as Array<{ name: string; value: string }>;
    expect(headers).toEqual(
      expect.arrayContaining([{ name: 'Content-Type', value: OPS_METRICS_CONTENT_TYPE }]),
    );
  });
});

describe('MetricsInterceptor', () => {
  it('records successful HTTP requests with route, method and status', (done) => {
    const recordRequest = jest.fn();
    const metrics = { recordRequest } as unknown as MetricsService;
    const interceptor = new MetricsInterceptor(metrics);
    const reply = { statusCode: 201 };
    const req = { method: 'GET', url: '/metrics', routeOptions: { url: '/metrics' } };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => reply,
      }),
    };
    interceptor
      .intercept(ctx as never, { handle: () => of('ok') })
      .subscribe({
        complete: () => {
          expect(recordRequest).toHaveBeenCalledWith('GET', '/metrics', 201, expect.any(Number));
          done();
        },
      });
  });

  it('records failed HTTP requests with 500 when statusCode is unset', (done) => {
    const recordRequest = jest.fn();
    const metrics = { recordRequest } as unknown as MetricsService;
    const interceptor = new MetricsInterceptor(metrics);
    const reply = {};
    const req = { method: 'POST', url: '/healthz' };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => reply,
      }),
    };
    interceptor
      .intercept(ctx as never, {
        handle: () => throwError(() => new Error('boom')),
      })
      .subscribe({
        error: () => {
          expect(recordRequest).toHaveBeenCalledWith('POST', '/healthz', 500, expect.any(Number));
          done();
        },
      });
  });
});
