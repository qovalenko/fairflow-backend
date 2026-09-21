import { RequestContext, type RequestContextData, type RequestLogger } from './request-context';

function makeLogger(tag: string): RequestLogger {
  return {
    child: () => makeLogger(`${tag}-child`),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('RequestContext', () => {
  afterEach(() => {
    RequestContext.set(undefined);
    RequestContext.setAppLogger(null as never);
  });

  it('get возвращает контекст, установленный через set', () => {
    const ctx: RequestContextData = {
      requestId: 'req-1',
      traceId: 'trace-1',
      logger: makeLogger('ctx'),
    };
    RequestContext.set(ctx);
    expect(RequestContext.get()).toBe(ctx);
    expect(RequestContext.getRequestId()).toBe('req-1');
    expect(RequestContext.getTraceId()).toBe('trace-1');
  });

  it('getLogger берёт logger из активного контекста', () => {
    const logger = makeLogger('active');
    RequestContext.set({ requestId: 'r', logger });
    expect(RequestContext.getLogger()).toBe(logger);
  });

  it('getLogger падает на appLogger, если контекст без logger', () => {
    const appLogger = makeLogger('app');
    RequestContext.setAppLogger(appLogger);
    RequestContext.set(undefined);
    expect(RequestContext.getLogger()).toBe(appLogger);
  });

  it('getLogger возвращает дефолтный logger без контекста и appLogger', () => {
    RequestContext.set(undefined);
    RequestContext.setAppLogger(null as never);
    const logger = RequestContext.getLogger();
    expect(() => logger.info('hello')).not.toThrow();
    expect(() => logger.debug('silent')).not.toThrow();
  });

  it('setCurrentRequest / getCurrentRequest хранят HTTP-запрос для GraphQL', () => {
    const req = { headers: { 'x-request-id': 'abc' } };
    RequestContext.setCurrentRequest(req);
    expect(RequestContext.getCurrentRequest()).toBe(req);
  });
});
