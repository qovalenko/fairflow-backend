import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

describe('MetricsInterceptor', () => {
  function makeContext(req: Record<string, unknown>, reply: Record<string, unknown>) {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => reply,
      }),
    };
  }

  it('записывает метрику успешного HTTP-запроса со statusCode ответа', (done) => {
    const metrics = { recordRequest: jest.fn() } as unknown as MetricsService;
    const interceptor = new MetricsInterceptor(metrics);
    const req = { method: 'GET', routeOptions: { url: '/healthz' }, url: '/ignored' };
    const reply = { statusCode: 204 };

    interceptor.intercept(makeContext(req, reply) as never, { handle: () => of('ok') }).subscribe({
      next: () => {
        expect(metrics.recordRequest).toHaveBeenCalledWith(
          'GET',
          '/healthz',
          204,
          expect.any(Number),
        );
        done();
      },
    });
  });

  it('берёт route из req.url, когда routeOptions отсутствует', (done) => {
    const metrics = { recordRequest: jest.fn() } as unknown as MetricsService;
    const interceptor = new MetricsInterceptor(metrics);
    const req = { method: 'POST', url: '/metrics' };
    const reply = { statusCode: 200 };

    interceptor.intercept(makeContext(req, reply) as never, { handle: () => of(null) }).subscribe({
      complete: () => {
        expect(metrics.recordRequest).toHaveBeenCalledWith(
          'POST',
          '/metrics',
          200,
          expect.any(Number),
        );
        done();
      },
    });
  });

  it('записывает метрику ошибки с кодом 500, когда handler бросает', (done) => {
    const metrics = { recordRequest: jest.fn() } as unknown as MetricsService;
    const interceptor = new MetricsInterceptor(metrics);
    const req = { method: 'DELETE', url: '/products/1' };
    const reply = {};

    interceptor
      .intercept(makeContext(req, reply) as never, {
        handle: () => throwError(() => new Error('boom')),
      })
      .subscribe({
        error: () => {
          expect(metrics.recordRequest).toHaveBeenCalledWith(
            'DELETE',
            '/products/1',
            500,
            expect.any(Number),
          );
          done();
        },
      });
  });
});
