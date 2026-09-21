import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

describe('MetricsInterceptor', () => {
  it('records a successful HTTP request with route and status', (done) => {
    const metrics = new MetricsService();
    const spy = jest.spyOn(metrics, 'recordRequest');
    const interceptor = new MetricsInterceptor(metrics);
    const reply = { statusCode: 201 };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', routeOptions: { url: '/healthz' }, url: '/healthz' }),
        getResponse: () => reply,
      }),
    };

    interceptor
      .intercept(ctx as never, { handle: () => of('ok') })
      .subscribe({
        next: () => {
          expect(spy).toHaveBeenCalledWith('GET', '/healthz', 201, expect.any(Number));
          done();
        },
      });
  });

  it('records an error path with the reply status code', (done) => {
    const metrics = new MetricsService();
    const spy = jest.spyOn(metrics, 'recordRequest');
    const interceptor = new MetricsInterceptor(metrics);
    const reply = { statusCode: 500 };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/unknown' }),
        getResponse: () => reply,
      }),
    };

    interceptor
      .intercept(ctx as never, { handle: () => throwError(() => new Error('boom')) })
      .subscribe({
        error: () => {
          expect(spy).toHaveBeenCalledWith('POST', '/unknown', 500, expect.any(Number));
          done();
        },
      });
  });

  it('defaults to HTTP 200 when the reply has no statusCode yet', (done) => {
    const metrics = new MetricsService();
    const spy = jest.spyOn(metrics, 'recordRequest');
    const interceptor = new MetricsInterceptor(metrics);
    const reply = {};
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/readyz' }),
        getResponse: () => reply,
      }),
    };

    interceptor
      .intercept(ctx as never, { handle: () => of('ok') })
      .subscribe({
        next: () => {
          expect(spy).toHaveBeenCalledWith('GET', '/readyz', 200, expect.any(Number));
          done();
        },
      });
  });
});
