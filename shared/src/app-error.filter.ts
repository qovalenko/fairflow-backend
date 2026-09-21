import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { AppError, getHttpStatusFromErrorCode } from './app-error';
import { RpcAppExceptionFilter } from './grpc/rpc-exception.filter';

/**
 * Canonical HTTP exception filter for Fastify-based domain services
 * (7 previously-identical copies lived in `<svc>/src/common/app-error.filter.ts`).
 *
 * Services with custom, richer mapping (gateway) keep their own filter.
 *
 * `extraStatusMap` lets a service layer in local error codes (e.g. auth) when
 * wiring the filter; base codes (incl. paymentRequired → 402) are built in.
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);
  private readonly rpcFilter = new RpcAppExceptionFilter();

  constructor(private readonly extraStatusMap?: Record<string, number>) {}

  catch(exception: unknown, host: ArgumentsHost): void | Observable<never> {
    if (host.getType() !== 'http') {
      return this.rpcFilter.catch(exception, host);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Internal error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      body = typeof res === 'object' ? (res as Record<string, unknown>) : { message: res };
    } else if (exception instanceof AppError) {
      status = getHttpStatusFromErrorCode(exception.errorCode, this.extraStatusMap);
      body = {
        statusCode: status,
        ...exception.toJSON(),
      };
      if (exception.errorCode !== 'internal') {
        this.logger.warn(
          `${exception.message} [${request.method} ${request.url}]`,
        );
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    // In GraphQL (Mercurius) context getResponse() may not return Fastify reply; use request.reply
    const reply =
      typeof response?.status === 'function'
        ? response
        : (request as FastifyRequest & { reply?: FastifyReply }).reply;
    if (reply && typeof reply.status === 'function') {
      reply.status(status).send(body);
    } else {
      throw exception;
    }
  }
}
