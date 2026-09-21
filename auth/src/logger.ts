import pino from 'pino';
import type { LoggerService } from '@nestjs/common';

const usePretty = process.env.LOG_FORMAT === 'pretty';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(usePretty && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    },
  }),
});

export class PinoLoggerService implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]) {
    const msg = typeof message === 'string' ? message : String(message);
    const obj =
      optionalParams.length > 0
        ? { context: optionalParams.length === 1 ? optionalParams[0] : optionalParams }
        : {};
    pinoLogger.info(obj, msg);
  }
  error(message: unknown, ...optionalParams: unknown[]) {
    const msg = typeof message === 'string' ? message : String(message);
    const obj =
      optionalParams.length > 0
        ? { context: optionalParams.length === 1 ? optionalParams[0] : optionalParams }
        : {};
    pinoLogger.error(obj, msg);
  }
  warn(message: unknown, ...optionalParams: unknown[]) {
    const msg = typeof message === 'string' ? message : String(message);
    const obj =
      optionalParams.length > 0
        ? { context: optionalParams.length === 1 ? optionalParams[0] : optionalParams }
        : {};
    pinoLogger.warn(obj, msg);
  }
  debug?(message: unknown, ...optionalParams: unknown[]) {
    const msg = typeof message === 'string' ? message : String(message);
    const obj =
      optionalParams.length > 0
        ? { context: optionalParams.length === 1 ? optionalParams[0] : optionalParams }
        : {};
    pinoLogger.debug(obj, msg);
  }
  verbose?(message: unknown, ...optionalParams: unknown[]) {
    const msg = typeof message === 'string' ? message : String(message);
    const obj =
      optionalParams.length > 0
        ? { context: optionalParams.length === 1 ? optionalParams[0] : optionalParams }
        : {};
    pinoLogger.trace(obj, msg);
  }
}
