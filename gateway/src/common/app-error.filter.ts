import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  grpcStatusToHttp,
  GW_METADATA,
  AppError,
  getHttpStatusFromErrorCode,
} from '@fairflow/shared';
import { RequestContext } from './request-context';
import type { GatewayEventsService } from '../events/gateway-events.service';

type ReqWithUser = FastifyRequest & {
  user?: { userId?: string };
  /** Set by ProjectAccessGuard after params → query → header resolution. */
  __projectId?: string;
};

/** First non-empty string; never reads the body (x-project-id invariant). */
function firstNonEmpty(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c) && typeof c[0] === 'string' && c[0].trim()) return c[0];
  }
  return undefined;
}

/**
 * A gRPC ServiceError surfaces on the gateway as a plain object carrying a numeric
 * `code` plus `details`/`metadata`. Recognise it so we preserve domain semantics
 * instead of collapsing everything to 500.
 */
interface GrpcServiceError {
  code: number;
  details?: string;
  metadata?: unknown;
  message?: string;
}

function isGrpcServiceError(err: unknown): err is GrpcServiceError {
  if (typeof err !== 'object' || err === null) return false;
  const o = err as Record<string, unknown>;
  return typeof o.code === 'number' && ('details' in o || 'metadata' in o);
}

/**
 * Domains carry structured error details ({ code, violations|errors }) in trailing
 * gRPC metadata under `x-error-details-bin` (see shared `rpcInvalidArgument`).
 * grpc-js surfaces trailers on `error.metadata`; decode the binary value (Buffer →
 * utf8), JSON.parse it and hand it back for the HTTP envelope. Best-effort: any
 * absent/malformed value yields `undefined` (envelope details stays null) — never throws.
 */
export function decodeErrorDetails(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const getter = (metadata as { get?: (key: string) => unknown }).get;
  if (typeof getter !== 'function') return undefined;
  try {
    const values = getter.call(metadata, GW_METADATA.ERROR_DETAILS);
    const raw = Array.isArray(values) ? values[0] : values;
    if (raw === undefined || raw === null) return undefined;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (text.length === 0) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function statusToCode(status: number): string {
  if (status === 400) return 'INVALID_ARGUMENT';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'ALREADY_EXISTS';
  if (status === 422) return 'FAILED_PRECONDITION';
  if (status === 429) return 'RESOURCE_EXHAUSTED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 500) return 'INTERNAL';
  return 'OK';
}

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  constructor(private readonly gatewayEvents?: GatewayEventsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal error';
    let details: unknown = undefined;
    /** Explicit, semantic code set by a guard/handler (MODULE_DISABLED,
     * POLICY_NOT_COMPILABLE, ALREADY_INITIALIZED, WEBHOOK_URL_DENIED …). It used to
     * be dropped in favour of the status-derived code, which made every
     * code-specific FE branch dead. Never taken from 5xx (no internal leak). */
    let explicitCode: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const o = res as Record<string, unknown>;
        message = String(o.message ?? o.error ?? exception.message);
        details = o.details ?? o.errors ?? undefined;
        if (typeof o.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(o.code) && status < 500) {
          explicitCode = o.code;
        }
      } else {
        message = String(res);
      }
    } else if (exception instanceof AppError) {
      status = getHttpStatusFromErrorCode(exception.errorCode);
      message = exception.message;
      details = exception.toJSON();
      const semanticCode = exception.details?.code;
      if (
        typeof semanticCode === 'string' &&
        /^[A-Z][A-Z0-9_]*$/.test(semanticCode) &&
        status < 500
      ) {
        explicitCode = semanticCode;
      }
      if (exception.errorCode !== 'internal') {
        const log = RequestContext.getLogger();
        log.warn({ err: exception, url: request.url, method: request.method }, exception.message);
      }
    } else if (isGrpcServiceError(exception)) {
      status = grpcStatusToHttp(exception.code);
      // `details` from the domain is a safe, client-facing message (set via
      // RpcException). Full error is logged for diagnostics.
      const rpcMessage = exception.details || exception.message;
      const log = RequestContext.getLogger();
      if (status >= 500) {
        log.error(
          { err: exception, url: request.url, method: request.method, grpcCode: exception.code },
          rpcMessage ?? 'gRPC error',
        );
        message = 'Internal error';
      } else {
        message = rpcMessage && rpcMessage.length > 0 ? rpcMessage : message;
        // Structured field errors ride in trailing metadata (x-error-details-bin).
        // Only surfaced on client-facing (<500) errors so 5xx masking is untouched.
        details = decodeErrorDetails(exception.metadata) ?? details;
        if (details && typeof details === 'object') {
          const detailCode = (details as Record<string, unknown>).code;
          if (detailCode === 'TEMPLATE_INVALID') {
            status = 422;
            explicitCode = 'TEMPLATE_INVALID';
          }
          if (detailCode === 'TRASH_COLLISION') {
            status = 409;
            explicitCode = 'TRASH_COLLISION';
          }
          if (detailCode === 'ROLE_IN_USE') {
            status = 409;
            explicitCode = 'ROLE_IN_USE';
          }
        }
        log.warn(
          { err: exception, url: request.url, method: request.method, grpcCode: exception.code },
          message,
        );
        // Domain machine-codes travel as the gRPC details string (e.g.
        // TWO_FACTOR_REQUIRED_BY_POLICY). Promote them to envelope.code so the
        // FE does not fall through to the status-derived alias (409 → ALREADY_EXISTS
        // would show «email уже используется»). Do not overwrite a code already
        // taken from structured trailing metadata (TEMPLATE_INVALID).
        if (!explicitCode && rpcMessage && /^[A-Z][A-Z0-9_]+$/.test(rpcMessage)) {
          explicitCode = rpcMessage;
        }
      }
    } else if (exception instanceof Error) {
      // Never leak internal error text (may contain host/addresses) to clients.
      this.logger.error(exception.message, exception.stack);
      message = 'Internal error';
    }

    const hdr = request.headers['x-request-id'];
    const requestId =
      RequestContext.getRequestId() ??
      (typeof hdr === 'string' ? hdr : Array.isArray(hdr) ? hdr[0] : undefined) ??
      randomUUID();

    const code = explicitCode ?? statusToCode(status);

    if (status === HttpStatus.FORBIDDEN && this.gatewayEvents) {
      const req = request as ReqWithUser;
      const params = request.params as { projectId?: string } | undefined;
      const query = request.query as { projectId?: string } | undefined;
      // Same sources the PEP already authorized — path param / __projectId first,
      // then header / query. Body is never consulted.
      const projectId = firstNonEmpty(
        req.__projectId,
        params?.projectId,
        request.headers['x-project-id'],
        query?.projectId,
      );
      void this.gatewayEvents.accessDenied({
        userId: req.user?.userId,
        projectId,
        requestId,
        method: request.method,
        path: request.url,
        code,
        message,
      });
    }

    // The FE error contract is `response.data.error.{code,message,details}` — that
    // is what every module reads (reports `isModuleDisabledError`, Members,
    // ImportWizard, Settings, ChatService, orders/companies/activities/products,
    // notifications `notificationErrorCode`). The envelope only ever carried the
    // FLAT fields, so `data.error` was always undefined and every code-specific
    // branch (MODULE_DISABLED, FAILED_PRECONDITION → «модуль-источник выключен»,
    // ALREADY_EXISTS …) was unreachable — users saw the generic error state.
    // Both shapes are emitted: the flat fields stay for the few existing readers
    // (AssignmentsTab, AbacEditor, BootstrapForm), `error` fixes the contract.
    const envelope = {
      code,
      message,
      details: details ?? null,
      requestId,
      error: { code, message, details: details ?? null },
    };

    const reply =
      typeof response?.status === 'function'
        ? response
        : (request as FastifyRequest & { reply?: FastifyReply }).reply;
    if (reply && typeof reply.status === 'function') {
      reply.status(status).send(envelope);
    } else {
      throw exception;
    }
  }
}
