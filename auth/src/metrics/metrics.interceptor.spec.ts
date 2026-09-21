import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

describe('MetricsInterceptor', () => {
  const makeContext = (statusCode: number) => {
    const reply = { statusCode };
    const req = { method: 'GET', url: '/v1/me', routeOptions: { url: '/v1/me' } };
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
    };
  };

  it('records successful HTTP requests with response status', (done) => {
    const metrics = new MetricsService();
    const recordRequest = jest.spyOn(metrics, 'recordRequest');
    const interceptor = new MetricsInterceptor(metrics);

    interceptor.intercept(makeContext(200) as never, { handle: () => of({ ok: true }) }).subscribe({
      complete: () => {
        expect(recordRequest).toHaveBeenCalledWith('GET', '/v1/me', 200, expect.any(Number));
        done();
      },
    });
  });

  it('records failed HTTP requests with error status', (done) => {
    const metrics = new MetricsService();
    const recordRequest = jest.spyOn(metrics, 'recordRequest');
    const interceptor = new MetricsInterceptor(metrics);

    interceptor
      .intercept(makeContext(403) as never, {
        handle: () => throwError(() => new Error('denied')),
      })
      .subscribe({
        error: () => {
          expect(recordRequest).toHaveBeenCalledWith('GET', '/v1/me', 403, expect.any(Number));
          done();
        },
      });
  });
});
