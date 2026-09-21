import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
  requestId: string;
  logger: RequestLogger;
  traceId?: string;
}

export interface RequestLogger {
  child(bindings: Record<string, unknown>): RequestLogger;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

let appLogger: RequestLogger | null = null;

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData | undefined>();

/** Current HTTP request (set for every route including /graphql) so guards can read it in GraphQL context. */
const currentRequestStorage = new AsyncLocalStorage<unknown>();

export class RequestContext {
  static set(context: RequestContextData | undefined): void {
    asyncLocalStorage.enterWith(context);
  }

  static get(): RequestContextData | undefined {
    return asyncLocalStorage.getStore();
  }

  static getLogger(): RequestLogger {
    const ctx = asyncLocalStorage.getStore();
    if (ctx?.logger) return ctx.logger;
    return appLogger ?? createDefaultLogger();
  }

  static getRequestId(): string | undefined {
    return asyncLocalStorage.getStore()?.requestId;
  }

  static getTraceId(): string | undefined {
    return asyncLocalStorage.getStore()?.traceId;
  }

  static setAppLogger(logger: RequestLogger): void {
    appLogger = logger;
  }

  static setCurrentRequest(request: unknown): void {
    currentRequestStorage.enterWith(request);
  }

  static getCurrentRequest(): unknown {
    return currentRequestStorage.getStore();
  }
}

function createDefaultLogger(): RequestLogger {
  const noop = () => {};
  return {
    child: () => createDefaultLogger(),
    info: (obj, msg) => console.log(msg ?? obj),
    warn: (obj, msg) => console.warn(msg ?? obj),
    error: (obj, msg) => console.error(msg ?? obj),
    debug: noop,
  };
}
