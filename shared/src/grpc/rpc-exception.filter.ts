import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { throwError, type Observable } from 'rxjs';
import { GW_METADATA } from './metadata-keys';

/**
 * Build an `INVALID_ARGUMENT` RpcException that carries structured validation
 * details through the штатный channel instead of stuffing JSON into the message.
 *
 * The human-readable `message` stays a clean, client-safe string; the structured
 * payload (`{ code, violations|errors }`) rides in trailing gRPC metadata under
 * `x-error-details-bin`. grpc-js sends the error's `metadata` as trailers, so the
 * gateway receives it on `error.metadata` and can decode it into `details` — no
 * more `JSON.stringify(...)` micro-format smuggled inside `grpc-message`.
 */
export function rpcInvalidArgument(
  message: string,
  details: Record<string, unknown>,
): RpcException {
  const metadata = new Metadata();
  metadata.set(GW_METADATA.ERROR_DETAILS, Buffer.from(JSON.stringify(details), 'utf8'));
  return new RpcException({
    code: GrpcStatus.INVALID_ARGUMENT,
    message,
    metadata,
  });
}

/**
 * Domain-level error codes (aligned with AppErrorCode / AppError in the domain
 * services). Kept as a plain string union so the filter can recognise duck-typed
 * AppError instances coming from any service without importing its concrete class.
 */
export type DomainErrorCode =
  | 'invalid'
  | 'notFound'
  | 'internal'
  | 'locked'
  | 'rateLimit'
  | 'access'
  | 'auth'
  | 'conflict';

const CODE_TO_GRPC: Record<DomainErrorCode, number> = {
  invalid: GrpcStatus.INVALID_ARGUMENT,
  notFound: GrpcStatus.NOT_FOUND,
  internal: GrpcStatus.INTERNAL,
  locked: GrpcStatus.FAILED_PRECONDITION,
  rateLimit: GrpcStatus.RESOURCE_EXHAUSTED,
  access: GrpcStatus.PERMISSION_DENIED,
  auth: GrpcStatus.UNAUTHENTICATED,
  conflict: GrpcStatus.ALREADY_EXISTS,
};

interface DuckAppError {
  errorCode: DomainErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

function isDomainAppError(err: unknown): err is DuckAppError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && code in CODE_TO_GRPC;
}

/**
 * Reusable gRPC exception filter for domain services.
 *
 * Converts a domain `AppError` (a plain Error carrying an `errorCode` field) into
 * a proper gRPC status so the gateway can map it back to a meaningful HTTP status.
 * `RpcException`s that services already throw are passed through untouched, as are
 * anything else (falls back to INTERNAL without leaking the raw message).
 *
 * NOTE: not registered anywhere here on purpose — services wire it up separately.
 */
@Catch()
export class RpcAppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RpcAppExceptionFilter.name);

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    // Already an RpcException — pass through its object error form (like
    // BaseRpcExceptionFilter). Re-throwing the RpcException instance itself
    // sends a plain Error to grpc-js (no `code`) → UNKNOWN(2) → gateway 500.
    // `getError()` yields the `{ code, message }` object so the intended status
    // (NOT_FOUND / ALREADY_EXISTS / …) survives the gateway HTTP mapping.
    if (exception instanceof RpcException) {
      const err = exception.getError();
      if (typeof err === 'object' && err !== null) {
        const o = err as Record<string, unknown>;
        const details = o.details;
        if (
          details &&
          typeof details === 'object' &&
          !o.metadata &&
          Object.keys(details as object).length > 0
        ) {
          const metadata = new Metadata();
          metadata.set(GW_METADATA.ERROR_DETAILS, Buffer.from(JSON.stringify(details), 'utf8'));
          return throwError(() => ({ ...o, metadata }));
        }
      }
      return throwError(() => exception.getError());
    }

    if (isDomainAppError(exception)) {
      // Structured client-facing details ({ conflictId, options, field, ... }) ride in
      // trailing gRPC metadata under `x-error-details-bin` — the same channel
      // `rpcInvalidArgument` uses — so the gateway's error filter can decode them into
      // the HTTP envelope's `details`. Without this the details were silently dropped
      // for every non-INVALID_ARGUMENT domain error (e.g. restore-collision conflictId).
      let metadata: Metadata | undefined;
      const details = exception.details;
      if (details && typeof details === 'object' && Object.keys(details).length > 0) {
        metadata = new Metadata();
        metadata.set(GW_METADATA.ERROR_DETAILS, Buffer.from(JSON.stringify(details), 'utf8'));
      }
      // Plain `{ code, message, metadata }` object — same as the RpcException
      // pass-through above. Wrapping in `new RpcException(...)` here made grpc-js
      // see a bare Error without `code` → UNKNOWN(2) on the wire (K-10).
      return throwError(() => ({
        code: CODE_TO_GRPC[exception.errorCode],
        message: exception.message,
        ...(metadata ? { metadata } : {}),
      }));
    }

    const message =
      exception instanceof Error ? exception.message : String(exception);
    this.logger.error(
      message,
      exception instanceof Error ? exception.stack : undefined,
    );

    return throwError(
      () =>
        new RpcException({
          code: GrpcStatus.INTERNAL,
          message: 'Internal error',
        }),
    );
  }
}
