import pino from 'pino';
import type { LoggerService } from '@nestjs/common';
import type { RequestLogger } from './common/request-context';

const isDev = process.env.NODE_ENV !== 'production';
/** Use pino-pretty only when LOG_FORMAT=pretty; default is JSON (stdout one line per log). */
const usePretty = process.env.LOG_FORMAT === 'pretty';

const pinoOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(usePretty && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    },
  }),
};

/** NestJS LoggerService that writes JSON via pino (same config as createAppLogger). */
export class PinoLoggerService implements LoggerService {
  private readonly pino = pino(pinoOptions);

  log(message: unknown, ...optionalParams: unknown[]) {
    this.pino.info(this.toObj(message, optionalParams), this.msg(message));
  }
  error(message: unknown, ...optionalParams: unknown[]) {
    this.pino.error(this.toObj(message, optionalParams), this.msg(message));
  }
  warn(message: unknown, ...optionalParams: unknown[]) {
    this.pino.warn(this.toObj(message, optionalParams), this.msg(message));
  }
  debug(message: unknown, ...optionalParams: unknown[]) {
    this.pino.debug(this.toObj(message, optionalParams), this.msg(message));
  }
  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.pino.trace(this.toObj(message, optionalParams), this.msg(message));
  }
  private msg(m: unknown): string {
    return typeof m === 'string' ? m : String(m);
  }
  private toObj(message: unknown, rest: unknown[]): object {
    const obj: Record<string, unknown> = {};
    if (rest.length > 0) obj.context = rest.length === 1 ? rest[0] : rest;
    return obj;
  }
}

/** Use for NestFactory so all bootstrap logs are JSON. */
export function createNestLogger(): PinoLoggerService {
  return new PinoLoggerService();
}

export function createAppLogger(): RequestLogger {
  const pinoLogger = pino(pinoOptions);

  return {
    child(bindings: Record<string, unknown>) {
      return createAppLoggerFromPino(pinoLogger.child(bindings));
    },
    info(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) pinoLogger.info(obj as object, msg);
      else pinoLogger.info({}, obj as string);
    },
    warn(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) pinoLogger.warn(obj as object, msg);
      else pinoLogger.warn({}, obj as string);
    },
    error(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) pinoLogger.error(obj as object, msg);
      else pinoLogger.error({}, obj as string);
    },
    debug(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) pinoLogger.debug(obj as object, msg);
      else pinoLogger.debug({}, obj as string);
    },
  };
}

function createAppLoggerFromPino(instance: pino.Logger): RequestLogger {
  return {
    child(bindings: Record<string, unknown>) {
      return createAppLoggerFromPino(instance.child(bindings));
    },
    info(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) instance.info(obj as object, msg);
      else instance.info({}, obj as string);
    },
    warn(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) instance.warn(obj as object, msg);
      else instance.warn({}, obj as string);
    },
    error(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) instance.error(obj as object, msg);
      else instance.error({}, obj as string);
    },
    debug(obj: unknown, msg?: string) {
      if (typeof obj === 'object' && obj !== null) instance.debug(obj as object, msg);
      else instance.debug({}, obj as string);
    },
  };
}
