import { RequestContext, type RequestContextData, type RequestLogger } from './request-context';

describe('RequestContext', () => {
  const childLogger: RequestLogger = {
    child: jest.fn().mockReturnThis(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const ctx: RequestContextData = {
    requestId: 'req-1',
    traceId: 'trace-1',
    logger: childLogger,
  };

  afterEach(() => {
    RequestContext.set(undefined);
    RequestContext.setCurrentRequest(undefined);
  });

  it('stores and reads request-scoped context', () => {
    RequestContext.set(ctx);
    expect(RequestContext.get()).toBe(ctx);
    expect(RequestContext.getRequestId()).toBe('req-1');
    expect(RequestContext.getTraceId()).toBe('trace-1');
  });

  it('returns the context logger when present', () => {
    RequestContext.set(ctx);
    expect(RequestContext.getLogger()).toBe(childLogger);
  });

  it('falls back to the app logger when no request context is set', () => {
    const appLogger: RequestLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.setAppLogger(appLogger);
    expect(RequestContext.getLogger()).toBe(appLogger);
  });

  it('tracks the current HTTP request separately from ALS context', () => {
    const request = { url: '/graphql' };
    RequestContext.setCurrentRequest(request);
    expect(RequestContext.getCurrentRequest()).toBe(request);
  });

  it('uses a default console logger when neither context nor app logger exist', async () => {
    jest.resetModules();
    const { RequestContext: IsolatedContext } = await import('./request-context');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    IsolatedContext.getLogger().info('hello');
    expect(logSpy).toHaveBeenCalledWith('hello');
    logSpy.mockRestore();
  });
});
