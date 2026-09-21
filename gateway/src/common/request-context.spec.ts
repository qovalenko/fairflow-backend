import { RequestContext } from './request-context';

describe('RequestContext', () => {
  afterEach(() => {
    RequestContext.set(undefined);
    RequestContext.setCurrentRequest(undefined);
  });

  it('stores and reads request-scoped logger and ids', () => {
    const logger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.set({ requestId: 'rid-1', logger, traceId: 'trace-1' });

    expect(RequestContext.getRequestId()).toBe('rid-1');
    expect(RequestContext.getTraceId()).toBe('trace-1');
    expect(RequestContext.getLogger()).toBe(logger);
  });

  it('falls back to app logger when request context is absent', () => {
    const appLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.setAppLogger(appLogger);

    expect(RequestContext.getLogger()).toBe(appLogger);
  });

  it('stores the current HTTP request for async guard access', () => {
    const req = { headers: { 'x-request-id': 'rid-2' } };
    RequestContext.setCurrentRequest(req);

    expect(RequestContext.getCurrentRequest()).toBe(req);
  });
});
