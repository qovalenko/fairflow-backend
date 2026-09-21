import { RequestContext, type RequestLogger } from './request-context';

describe('RequestContext', () => {
  afterEach(() => {
    RequestContext.set(undefined);
    RequestContext.setAppLogger(null as unknown as RequestLogger);
  });

  it('возвращает requestId и traceId из активного контекста', () => {
    const logger = {
      child: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.set({ requestId: 'req-1', traceId: 'trace-1', logger });
    expect(RequestContext.getRequestId()).toBe('req-1');
    expect(RequestContext.getTraceId()).toBe('trace-1');
    expect(RequestContext.get()).toEqual({ requestId: 'req-1', traceId: 'trace-1', logger });
  });

  it('getLogger отдаёт логгер из контекста', () => {
    const logger = {
      child: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.set({ requestId: 'req-1', logger });
    expect(RequestContext.getLogger()).toBe(logger);
  });

  it('getLogger без контекста использует appLogger', () => {
    const appLogger = {
      child: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    RequestContext.setAppLogger(appLogger);
    expect(RequestContext.getLogger()).toBe(appLogger);
  });

  it('getLogger без контекста и appLogger — fallback-логгер не падает', () => {
    const logger = RequestContext.getLogger();
    expect(() => logger.info('hello')).not.toThrow();
    expect(() => logger.warn('warn')).not.toThrow();
    expect(() => logger.error('err')).not.toThrow();
    expect(() => logger.debug('dbg')).not.toThrow();
    expect(logger.child({})).toBeDefined();
  });

  it('setCurrentRequest/getCurrentRequest хранят HTTP-запрос для GraphQL', () => {
    const req = { headers: { 'x-request-id': 'r1' } };
    RequestContext.setCurrentRequest(req);
    expect(RequestContext.getCurrentRequest()).toBe(req);
  });
});
