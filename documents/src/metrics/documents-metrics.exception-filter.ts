import { ArgumentsHost, Catch } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import type { Observable } from 'rxjs';
import { MetricsService } from './metrics.service';

const CLIENT_GRPC_CODES = new Set<number>([
  GrpcStatus.INVALID_ARGUMENT,
  GrpcStatus.NOT_FOUND,
  GrpcStatus.ALREADY_EXISTS,
  GrpcStatus.PERMISSION_DENIED,
  GrpcStatus.FAILED_PRECONDITION,
  GrpcStatus.RESOURCE_EXHAUSTED,
]);

function extractDomainCode(err: Record<string, unknown>): string | undefined {
  const details = err.details;
  if (details && typeof details === 'object') {
    const code = (details as Record<string, unknown>).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  const message = err.message;
  if (typeof message === 'string' && /^[A-Z][A-Z0-9_]+$/.test(message)) return message;
  return undefined;
}

/**
 * Records `documents_errors_total` for client-facing domain RpcExceptions, then
 * delegates to the shared gRPC filter (NFR-DOCS-080).
 */
@Catch()
export class DocumentsMetricsExceptionFilter extends RpcAppExceptionFilter {
  constructor(private readonly metrics: MetricsService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost): Observable<never> {
    if (exception instanceof RpcException) {
      const err = exception.getError();
      if (typeof err === 'object' && err !== null) {
        const o = err as Record<string, unknown>;
        const grpcCode = typeof o.code === 'number' ? o.code : GrpcStatus.UNKNOWN;
        if (CLIENT_GRPC_CODES.has(grpcCode)) {
          const code = extractDomainCode(o) ?? 'UNKNOWN';
          this.metrics.recordDocumentsError(code);
        }
      }
    }
    return super.catch(exception, host);
  }
}
