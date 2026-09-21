import { Metadata } from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { GW_METADATA, serializeVisibilityScope } from '@fairflow/shared';
import type { ActionExecutor, ExecutorContext, ExecutorOutcome } from './executor.types';

/**
 * s2s "system actor" visibility scope, identical to the one orders' drift reader
 * sends (`order-source-reader.service.ts`).
 *
 * Required, not decorative: every CRM domain fails CLOSED on a missing scope —
 * `isRecordVisible(undefined, …)` is `false` and `buildVisibilityFilter` returns
 * DENY_ALL — so without this header a bus-triggered rule gets NOT_FOUND for every
 * record that exists, and `assign_user` / `change_stage` / `update_field` could
 * never touch anything. Project isolation is NOT affected: the domains still AND
 * `x-project-id` into every query, so this widens the record-visibility axis only,
 * and only for the path where the actor genuinely IS the system (no end user).
 *
 * Reachable ONLY via `ctx.actor === 'system'` — an explicit declaration by the
 * entry point, not "the userId happened to be empty". Every gateway-facing entry
 * point (ExecuteRule / HookEvent / ManualRun) runs as `user`, because its payload
 * is client-supplied: letting one of them borrow this scope turns "run this rule"
 * into "mutate any record in the project" (§3.8 IDOR).
 */
const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

/**
 * Service-actor metadata for an automation → executor-domain gRPC call
 * (FR-MAUT-8/8a). The automation domain authenticates with its OWN service
 * API-key (`AUTOMATION_SERVICE_API_KEY`); the call is `actor_type=service` and
 * is scoped to the rule's project. The user id is propagated when the rule ran
 * on a user's behalf so the executor domain can apply that user's visibility on
 * any read it performs (§3.8 IDOR mitigation), never widened.
 *
 * Visibility scope is decided by {@link ExecutorContext.actor}, NOT by whether a
 * user id happens to be present:
 *  - `system` → {@link SERVICE_SCOPE} (bus consumer, janitor re-drive, order
 *    final-action saga — there is no end user by construction);
 *  - `user` / absent → the ORIGINATING caller's scope, forwarded verbatim; when
 *    it was not forwarded, NOTHING is sent and the run stays fail-closed (the
 *    target answers NOT_FOUND) rather than being widened.
 *
 * The default is the restrictive branch on purpose: a new entry point that
 * forgets to declare its actor loses records, it does not gain them.
 */
export function buildServiceActorMetadata(ctx: ExecutorContext): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, process.env.AUTOMATION_SERVICE_API_KEY ?? '');
  m.set(GW_METADATA.GATEWAY_API_KEY_ID, process.env.AUTOMATION_API_KEY_ID ?? '');
  m.set(GW_METADATA.REQUEST_ID, randomUUID());
  m.set(GW_METADATA.TRACE_ID, randomUUID());
  m.set(GW_METADATA.PROJECT_ID, ctx.projectId);
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  if (ctx.userId) m.set(GW_METADATA.USER_ID, ctx.userId);
  const scope = (ctx.visibilityScope ?? '').trim();
  if (ctx.actor === 'system') m.set(GW_METADATA.VISIBILITY_SCOPE, SERVICE_SCOPE);
  else if (scope) m.set(GW_METADATA.VISIBILITY_SCOPE, scope);
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  return m;
}

/**
 * Loader options for EVERY gRPC client this domain creates.
 *
 * `keepCase: true` is NOT optional: our request/response shapes are snake_case
 * (matching the proto field names). A client created without loader options
 * runs with the default `keepCase: false`, so protobufjs looks up camelCase
 * fields, finds none of the snake_case keys we pass, and silently serializes
 * an EMPTY message — `{ project_id }` goes to the wire as 0 bytes (this exact
 * failure cost days of 401-hunting in July, twice). `arrays: true` matches the
 * gateway loader (`grpc-bff.module.ts`): empty repeated fields decode as `[]`,
 * never `undefined`. Guarded by `grpc-loader.spec.ts` — do not inline ad-hoc
 * loader options in new clients, import this constant.
 */
export const AUTOMATION_GRPC_LOADER_OPTIONS = Object.freeze({
  keepCase: true,
  arrays: true,
  // `longs: Number` — та же грабля, четвёртая ипостась: без неё int64 приезжает
  // объектом Long {low,high,unsigned} при объявленном в TS `number`, и любая
  // арифметика/`new Date()` над меткой даёт NaN/Invalid Date молча.
  longs: Number,
});

/** Deadline for one executor→domain call. A wedged peer must not pin a rule run. */
function defaultInvokeTimeoutMs(): number {
  const raw = Number(process.env.AUTOMATION_EXECUTOR_TIMEOUT_MS ?? 15000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}
/** Locate a proto file relative to the running dist or repo root. */
export function protoPath(...segments: string[]): string {
  const fromDist = join(__dirname, '..', '..', '..', '..', 'proto', ...segments);
  const fromRoot = join(process.cwd(), '..', 'proto', ...segments);
  const fromCwd = join(process.cwd(), 'proto', ...segments);
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromRoot)) return fromRoot;
  return fromCwd;
}

/**
 * Decoded outcome of one unary call (see {@link GrpcActionExecutor.invoke}).
 *
 * A FLAT shape on purpose: this workspace compiles with `strictNullChecks:false`
 * (see tsconfig.json), where TypeScript does NOT narrow a `{ok:true}|{ok:false}`
 * discriminated union — `if (!res.ok) res.grpcCode` fails to compile. Optional
 * fields keep the reader honest instead: `response` is set (possibly `{}`) when
 * `ok`, `error`/`grpcCode`/`notConfigured` only when not.
 */
export interface GrpcInvokeResult {
  ok: boolean;
  /** Decoded response body; `{}` when the method returns an empty message. */
  response?: Record<string, unknown>;
  /** Transport/status message when `ok === false`. */
  error?: string;
  /** Numeric gRPC status code when the failure carried one. */
  grpcCode?: number;
  /** True when no target address is configured at all (deployment config error). */
  notConfigured?: boolean;
}

type GrpcUnary = (
  d: unknown,
  m: Metadata,
  o?: Record<string, unknown>,
) => import('rxjs').Observable<unknown>;

/** Everything needed to reach ONE domain gRPC service. */
export interface DomainGrpcTarget {
  /** Env var holding the target address (`PIPE_GRPC_URL`, …). */
  urlEnv: string;
  /** Proto package (`fairflow.pipe.v1`). */
  package: string;
  /** Service name inside the package (`PipeGrpc`). */
  service: string;
  /** Path segments of the .proto under `proto/`. */
  protoSegments: string[];
}

/**
 * One lazily-created gRPC client to a single domain service.
 *
 * Extracted from {@link GrpcActionExecutor} because `update_field` / `assign_user`
 * are entity-generic: one executor has to reach pipe, contact, company AND orders
 * depending on what the trigger fired on, so "one executor = one client" no longer
 * holds. All clients are built with {@link AUTOMATION_GRPC_LOADER_OPTIONS} — never
 * with ad-hoc loader options (see the constant's doc for what that costs).
 */
export class DomainGrpcClient {
  private client: ClientGrpcProxy | null = null;
  private service: Record<string, GrpcUnary> | null = null;

  constructor(private readonly target: DomainGrpcTarget) {}

  /** Configured address, or `null` when the deployment did not wire this domain. */
  addr(): string | null {
    const url = process.env[this.target.urlEnv];
    return url && url.trim() ? url.trim() : null;
  }

  getService(): Record<string, GrpcUnary> | null {
    const url = this.addr();
    if (!url) return null;
    if (this.service) return this.service;
    this.client = new ClientGrpcProxy({
      transport: Transport.GRPC,
      package: this.target.package,
      protoPath: protoPath(...this.target.protoSegments),
      url,
      loader: AUTOMATION_GRPC_LOADER_OPTIONS,
    } as never);
    this.service = this.client.getService(this.target.service) as never;
    return this.service;
  }

  /**
   * Unary call that returns the DECODED response instead of collapsing it to a
   * boolean. Needed by executors whose target answers with an outcome field
   * rather than a gRPC error (`SendTransactionalEmail` → `{status, error}`): a
   * `status:'failed'` body must not be read as a success.
   *
   * `timeoutMs` sets a real gRPC deadline (a `sendMail` blocked on a wedged SMTP
   * relay must not pin a final-action delivery forever); on expiry the call is
   * cancelled and reported as DEADLINE_EXCEEDED, which the caller classifies.
   * `notConfigured` distinguishes "no target address configured" (a deployment
   * config error) from a transport failure of a configured target.
   */
  async invoke(
    method: string,
    req: unknown,
    ctx: ExecutorContext,
    timeoutMs?: number,
    enabledModules?: string[],
  ): Promise<GrpcInvokeResult> {
    const svc = this.getService();
    if (!svc || typeof svc[method] !== 'function') {
      return { ok: false, error: 'executor_unavailable', notConfigured: true };
    }
    const md = buildServiceActorMetadata(ctx);
    if (enabledModules) {
      md.set(GW_METADATA.ENABLED_MODULES, JSON.stringify(enabledModules));
    }
    const effectiveTimeout =
      timeoutMs && timeoutMs > 0 ? timeoutMs : defaultInvokeTimeoutMs();
    const options = { deadline: Date.now() + effectiveTimeout };
    try {
      const response = (await firstValueFrom(
        svc[method](req, md, options),
      )) as Record<string, unknown> | null;
      return { ok: true, response: response ?? {} };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        grpcCode: typeof code === 'number' ? code : undefined,
      };
    }
  }
}

/**
 * Base for a gRPC-backed executor. The underlying client is created lazily and
 * only when a target address is configured (`<DOMAIN>_GRPC_URL`). When no
 * address is configured the executor reports the action as not-dispatched so the
 * dispatcher records it `deferred` (never a false success) — this keeps the
 * cross-domain wiring additive and safe until the service-actor key is
 * provisioned cluster-side (PRE).
 */
export abstract class GrpcActionExecutor implements ActionExecutor {
  protected readonly logger = new Logger(this.constructor.name);
  private domainClient: DomainGrpcClient | null = null;

  abstract readonly handles: readonly string[];
  protected abstract readonly grpcUrlEnv: string;
  protected abstract readonly grpcPackage: string;
  protected abstract readonly grpcServiceName: string;
  protected abstract readonly protoSegments: string[];

  private clientRef(): DomainGrpcClient {
    if (!this.domainClient) {
      this.domainClient = new DomainGrpcClient({
        urlEnv: this.grpcUrlEnv,
        package: this.grpcPackage,
        service: this.grpcServiceName,
        protoSegments: this.protoSegments,
      });
    }
    return this.domainClient;
  }

  protected addr(): string | null {
    return this.clientRef().addr();
  }

  protected getService(): Record<string, GrpcUnary> | null {
    return this.clientRef().getService();
  }

  /** See {@link DomainGrpcClient.invoke}. */
  protected async invoke(
    method: string,
    req: unknown,
    ctx: ExecutorContext,
    timeoutMs?: number,
  ): Promise<GrpcInvokeResult> {
    return this.clientRef().invoke(method, req, ctx, timeoutMs);
  }

  protected async call(method: string, req: unknown, ctx: ExecutorContext): Promise<ExecutorOutcome> {
    const res = await this.invoke(method, req, ctx);
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'executor_failed' };
  }

  abstract execute(
    type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome>;
}
