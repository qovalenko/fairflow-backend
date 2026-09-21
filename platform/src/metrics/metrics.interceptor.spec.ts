import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';

describe('MetricsInterceptor', () => {
  const metrics = { recordRequest: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeContext(req: Record<string, unknown>, reply: Record<string, unknown>) {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => reply,
      }),
    } as never;
  }

  it('records successful HTTP requests with route and status code', (done) => {
    const interceptor = new MetricsInterceptor(metrics as never);
    const req = { method: 'GET', routeOptions: { url: '/healthz' }, url: '/healthz' };
    const reply = { statusCode: 200 };

    interceptor
      .intercept(makeContext(req, reply), { handle: () => of({ ok: true }) })
      .subscribe({
        complete: () => {
          expect(metrics.recordRequest).toHaveBeenCalledWith(
            'GET',
            '/healthz',
            200,
            expect.any(Number),
          );
          done();
        },
      });
  });

  it('records failed HTTP requests with the response status code', (done) => {
    const interceptor = new MetricsInterceptor(metrics as never);
    const req = { method: 'POST', url: '/unknown' };
    const reply = { statusCode: 500 };

    interceptor
      .intercept(makeContext(req, reply), { handle: () => throwError(() => new Error('fail')) })
      .subscribe({
        error: () => {
          expect(metrics.recordRequest).toHaveBeenCalledWith(
            'POST',
            '/unknown',
            500,
            expect.any(Number),
          );
          done();
        },
      });
  });

  it('falls back to reply defaults and unknown route when route metadata is missing', (done) => {
    const interceptor = new MetricsInterceptor(metrics as never);
    const req = { method: 'GET' };
    const reply = {};

    interceptor.intercept(makeContext(req, reply), { handle: () => of(null) }).subscribe({
      complete: () => {
        expect(metrics.recordRequest).toHaveBeenCalledWith(
          'GET',
          'unknown',
          200,
          expect.any(Number),
        );
        done();
      },
    });
  });

  it('falls back to status 500 on error when the reply has no statusCode', (done) => {
    const interceptor = new MetricsInterceptor(metrics as never);
    const req = { method: 'GET', url: '/boom' };
    const reply = {};

    interceptor
      .intercept(makeContext(req, reply), { handle: () => throwError(() => new Error('boom')) })
      .subscribe({
        error: () => {
          expect(metrics.recordRequest).toHaveBeenCalledWith(
            'GET',
            '/boom',
            500,
            expect.any(Number),
          );
          done();
        },
      });
  });
});
