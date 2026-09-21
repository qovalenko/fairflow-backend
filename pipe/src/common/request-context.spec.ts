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

  it('getLogger falls back to the default logger when no context is set', () => {
    RequestContext.set(undefined);
    const logger = RequestContext.getLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('setAppLogger is used when no per-request logger is present', () => {
    const appLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.set(undefined);
    RequestContext.setAppLogger(appLogger);
    expect(RequestContext.getLogger()).toBe(appLogger);
  });
});
