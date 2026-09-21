import { RequestContext } from './request-context';

describe('RequestContext', () => {
  it('stores and reads requestId/traceId via AsyncLocalStorage', () => {
    RequestContext.set({ requestId: 'req-1', logger: RequestContext.getLogger(), traceId: 'tr-1' });
    expect(RequestContext.getRequestId()).toBe('req-1');
    expect(RequestContext.getTraceId()).toBe('tr-1');
    RequestContext.set(undefined);
    expect(RequestContext.getRequestId()).toBeUndefined();
  });

  it('setCurrentRequest/getCurrentRequest round-trip the HTTP request object', () => {
    const req = { url: '/healthz' };
    RequestContext.setCurrentRequest(req);
    expect(RequestContext.getCurrentRequest()).toBe(req);
  });

  it('getLogger uses context logger when set, otherwise app/default logger', () => {
    const contextLogger = {
      child: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.set({ requestId: 'r1', logger: contextLogger });
    expect(RequestContext.getLogger()).toBe(contextLogger);

    RequestContext.set(undefined);
    const appLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.setAppLogger(appLogger);
    expect(RequestContext.getLogger()).toBe(appLogger);

    RequestContext.setAppLogger(null as never);
    RequestContext.set(undefined);
    const fallback = RequestContext.getLogger();
    expect(typeof fallback.info).toBe('function');
    expect(typeof fallback.child({ x: 1 }).debug).toBe('function');
  });
});
