import { RequestContext, type RequestLogger } from './request-context';

function makeLogger(): RequestLogger {
  return {
    child: jest.fn().mockReturnThis(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('RequestContext', () => {
  afterEach(() => {
    RequestContext.set(undefined);
    RequestContext.setCurrentRequest(undefined);
    RequestContext.setAppLogger(makeLogger());
  });

  it('сохраняет и возвращает requestId и traceId активного запроса', () => {
    const logger = makeLogger();
    RequestContext.set({ requestId: 'req-42', logger, traceId: 'trace-9' });

    expect(RequestContext.get()?.requestId).toBe('req-42');
    expect(RequestContext.getRequestId()).toBe('req-42');
    expect(RequestContext.getTraceId()).toBe('trace-9');
  });

  it('отдаёт logger из контекста, когда он задан', () => {
    const logger = makeLogger();
    RequestContext.set({ requestId: 'r1', logger });

    expect(RequestContext.getLogger()).toBe(logger);
  });

  it('падает на app logger, когда контекст пуст', () => {
    const appLogger = makeLogger();
    RequestContext.set(undefined);
    RequestContext.setAppLogger(appLogger);

    expect(RequestContext.getLogger()).toBe(appLogger);
  });

  it('использует встроенный default logger, когда нет ни контекста, ни app logger', () => {
    RequestContext.set(undefined);
    RequestContext.setAppLogger(null as unknown as RequestLogger);

    const logger = RequestContext.getLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(logger.child({})).toBeDefined();
  });

  it('хранит текущий HTTP request для guard/GraphQL', () => {
    const req = { headers: { authorization: 'Bearer x' } };
    RequestContext.setCurrentRequest(req);

    expect(RequestContext.getCurrentRequest()).toBe(req);
  });
});
