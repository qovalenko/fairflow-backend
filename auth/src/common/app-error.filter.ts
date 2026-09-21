import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import type { Observable } from 'rxjs';
import { AppError, AppErrorCode, getHttpStatusFromErrorCode } from './errors';

/** OAuth 2.0 / OIDC error codes that must be rendered in the RFC 6749 §5.2 shape. */
const OAUTH_ERROR_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'invalid_client',
  'invalid_grant',
  'unsupported_grant_type',
]);

/**
 * Single global exception filter for the auth service. Nest selects exactly ONE
 * catch-all filter per exception, so this one dispatches on the transport:
 *  - HTTP  → JSON body (incl. RFC 6749 shape for OAuth/OIDC errors).
 *  - gRPC  → delegates to the shared {@link RpcAppExceptionFilter} so an AppError
 *            becomes a proper gRPC status instead of UNKNOWN 'Internal server error' (K-10).
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);
  private readonly rpc = new RpcAppExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void | Observable<never> {
    if (host.getType() !== 'http') {
      // gRPC (and any other microservice transport) → gRPC status.
      return this.rpc.catch(exception, host);
    }
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Internal error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      body = typeof res === 'object' ? (res as Record<string, unknown>) : { message: res };
    } else if (exception instanceof AppError) {
      status = getHttpStatusFromErrorCode(exception.errorCode);
      if (OAUTH_ERROR_CODES.has(exception.errorCode)) {
        // RFC 6749 §5.2 — token/authorize endpoints answer { error, error_description }.
        body = { error: exception.errorCode, error_description: exception.message };
      } else {
        body = { statusCode: status, ...exception.toJSON() };
      }
      if (exception.errorCode !== 'internal') {
        this.logger.warn(exception.message);
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    if (response?.status) {
      response.status(status).send(body);
    } else {
      throw exception;
    }
  }
}
