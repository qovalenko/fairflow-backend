/**
 * [#19] Domain-side deferred-scope hydration (plan P19-domain, вариант A).
 *
 * When an org is large, control cannot inline the expanded ownerIds/sharedRecordIds
 * into the ~8 KiB gRPC metadata budget, so it flips the scope to `deferred` and
 * carries a compact `descriptor` instead (see rbac.ts / control visibility-resolver).
 * A deferred scope that reaches a domain unhydrated is fail-closed (deny-all) by
 * `buildVisibilityFilter` — correct but a UX degradation for big orgs.
 *
 * This module lets a domain resolve the flat lists SERVER-SIDE by re-asking control
 * (`ProjectGrpc.ResolveRecordVisibility(inline:true)`), keyed by
 * `(projectId,userId,resource,epoch)`. The result is cached (LRU, double-bounded by
 * entry count AND total ids) and stamped back into `x-visibility-scope` by a guard,
 * so the ~60 existing `readVisibilityScope` call-sites across the domains need no
 * change.
 *
 * Metadata (план §3.3): the domain FORWARDS the inbound gateway metadata subset
 * (service key + propagation) — the call happens strictly inside the handling of a
 * gateway request whose key control's PEP already validated. No new per-domain
 * service key is provisioned; do NOT reuse this hydrator for calls outside a
 * request context.
 *
 * Degradation (план §5): control UNAVAILABLE / deadline with no valid cache → the
 * scope stays `deferred` → deny-all. Strict fail-closed, consistent with Д-3. An
 * optional last-known-good stale window (VISIBILITY_HYDRATE_STALE_GRACE_MS,
 * default 0 = off) may serve an older-epoch entry on transport failure only.
 */

import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ClientGrpcProxy, Transport, type ClientProvider } from '@nestjs/microservices';
import { GW_METADATA } from './metadata-keys';
import {
  hydrateVisibilityScope,
  parseVisibilityScope,
  serializeVisibilityScope,
  type VisibilityScope,
} from '../rbac';

/** DI token for the domain's control client used by the hydrator. */
export const CONTROL_VISIBILITY_GRPC = 'CONTROL_VISIBILITY_GRPC';

/**
 * Optional DI token for a metrics sink `(result) => void` (план §4). A domain may
 * provide it to feed `visibility_hydrate_total{result}`; absent → no-op. Kept a
 * plain token (not a class type) so Nest resolves it as optional without needing a
 * concrete provider.
 */
export const VISIBILITY_HYDRATE_METRICS = 'VISIBILITY_HYDRATE_METRICS';

/** Metadata keys forwarded on the domain→control hydration call (план §3.3). */
const FORWARD_KEYS: readonly string[] = [
  GW_METADATA.SERVICE_API_KEY,
  GW_METADATA.GATEWAY_API_KEY_ID,
  GW_METADATA.REQUEST_ID,
  GW_METADATA.TRACEPARENT,
  GW_METADATA.TRACE_ID,
  GW_METADATA.GATEWAY_ISSUED_AT,
  GW_METADATA.ACTOR_TYPE,
  GW_METADATA.USER_ID,
  GW_METADATA.PROJECT_ID,
];

interface WireDescriptor {
  unit_ids?: string[];
  led_unit_ids?: string[];
  selected_group_ids?: string[];
  rule_kinds?: string[];
  uses_sharing?: boolean;
  org_id?: string;
}

interface ResolveVisibilityWire {
  allowed?: boolean;
  mode?: string;
  owner_ids?: string[];
  ownerIds?: string[];
  shared_record_ids?: string[];
  sharedRecordIds?: string[];
  department_ids?: string[];
  departmentIds?: string[];
  epoch?: number | string;
  deferred?: boolean;
  descriptor?: WireDescriptor;
}

interface ProjectVisibilityClient {
  resolveRecordVisibility(
    req: { project_id: string; user_id: string; resource: string; inline: boolean },
    md: Metadata,
  ): Observable<ResolveVisibilityWire>;
}

interface CacheEntry {
  epoch: number;
  /** Pre-serialized hydrated scope — metadata.set is then O(1). */
  serializedScope: string;
  idCount: number;
  expiresAt: number;
}

function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Result label for the hydrate metric / logs. */
export type HydrateResult = 'hit' | 'miss' | 'stale' | 'deny' | 'inline_skip';

/**
 * Deferred-scope resolver + epoch-keyed LRU cache (план §4). One instance per
 * domain process, shared by the guard.
 */
@Injectable()
export class DeferredScopeHydrator {
  private readonly logger = new Logger(DeferredScopeHydrator.name);
  private client?: ProjectVisibilityClient;
  private readonly cache = new Map<string, CacheEntry>();
  private totalIds = 0;

  private readonly ttlMs = intEnv('VISIBILITY_HYDRATE_TTL_MS', 300_000);
  private readonly maxEntries = intEnv('VISIBILITY_HYDRATE_CACHE_MAX', 128);
  private readonly maxTotalIds = intEnv('VISIBILITY_HYDRATE_MAX_TOTAL_IDS', 1_000_000);
  private readonly timeoutMs = intEnv('VISIBILITY_HYDRATE_TIMEOUT_MS', 3000);
  private readonly staleGraceMs = intEnv('VISIBILITY_HYDRATE_STALE_GRACE_MS', 0);

  constructor(
    @Optional() @Inject(CONTROL_VISIBILITY_GRPC) private readonly control?: ClientGrpcProxy,
    @Optional()
    @Inject(VISIBILITY_HYDRATE_METRICS)
    private readonly onResult?: (r: HydrateResult) => void,
  ) {}

  private getClient(): ProjectVisibilityClient | undefined {
    if (!this.control) return undefined;
    if (!this.client) {
      this.client = this.control.getService<ProjectVisibilityClient>('ProjectGrpc');
    }
    return this.client;
  }

  private record(result: HydrateResult): void {
    try {
      this.onResult?.(result);
    } catch {
      /* metrics must never break the request path */
    }
  }

  /**
   * Resolve a deferred scope into a hydrated one. Returns the ORIGINAL scope for a
   * non-deferred input (nothing to do). On resolution failure with no usable cache
   * the scope is returned UNCHANGED (still `deferred` → downstream deny-all): strict
   * fail-closed, never widened.
   */
  async hydrate(scope: VisibilityScope, inbound: Metadata | undefined): Promise<VisibilityScope> {
    if (!scope.deferred) {
      this.record('inline_skip');
      return scope;
    }

    const projectId = readMeta(inbound, GW_METADATA.PROJECT_ID);
    const userId = readMeta(inbound, GW_METADATA.USER_ID) || scope.selfId;
    const resource = scope.resource ?? '';
    const wantEpoch = typeof scope.epoch === 'number' ? scope.epoch : undefined;
    if (!projectId || !userId) {
      // No trusted identity to resolve against → cannot hydrate safely.
      this.record('deny');
      return scope;
    }

    const key = `${projectId}:${userId}:${resource}`;
    const now = Date.now();

    // Fresh cache hit — epoch must match (K3) and entry unexpired.
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.expiresAt > now &&
      wantEpoch !== undefined &&
      cached.epoch === wantEpoch
    ) {
      this.touch(key, cached);
      this.record('hit');
      return parseVisibilityScope(cached.serializedScope) ?? scope;
    }

    const client = this.getClient();
    if (!client) {
      this.record('deny');
      return scope;
    }

    try {
      const md = buildForwardMetadata(inbound);
      const res = await firstValueFrom(
        client
          .resolveRecordVisibility(
            { project_id: projectId, user_id: userId, resource, inline: true },
            md,
          )
          .pipe(timeout(this.timeoutMs)),
      );
      if (res?.allowed === false) {
        // Membership revoked between gateway resolve and this call → deny-all.
        this.record('deny');
        return scope;
      }
      const ownerIds = res?.owner_ids ?? res?.ownerIds ?? [];
      const sharedRecordIds = res?.shared_record_ids ?? res?.sharedRecordIds ?? [];
      const departmentIds = res?.department_ids ?? res?.departmentIds ?? [];
      const resolvedEpoch =
        res?.epoch !== undefined ? Number(res.epoch) || 0 : (wantEpoch ?? 0);
      const hydrated = hydrateVisibilityScope(scope, {
        ownerIds,
        sharedRecordIds,
        departmentIds,
      });
      const serialized = serializeVisibilityScope(hydrated);
      this.store(key, {
        epoch: resolvedEpoch,
        serializedScope: serialized,
        idCount: ownerIds.length + sharedRecordIds.length,
        expiresAt: now + this.ttlMs,
      });
      this.record('miss');
      return hydrated;
    } catch (err) {
      // Transport / deadline failure. Optional last-known-good within the grace
      // window (different epoch allowed) — OFF by default (fail-closed, Д-3).
      if (
        this.staleGraceMs > 0 &&
        cached &&
        cached.expiresAt + this.staleGraceMs > now
      ) {
        this.record('stale');
        this.logger.warn(
          `visibility hydrate stale-serve project=${projectId} resource=${resource || '-'} (control unavailable)`,
        );
        return parseVisibilityScope(cached.serializedScope) ?? scope;
      }
      this.record('deny');
      this.logger.warn(
        `visibility hydrate failed (fail-closed deny-all) project=${projectId} resource=${resource || '-'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return scope;
    }
  }

  private store(key: string, entry: CacheEntry): void {
    const prev = this.cache.get(key);
    if (prev) this.totalIds -= prev.idCount;
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.totalIds += entry.idCount;
    this.evict();
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /** Prune expired, then enforce both the entry-count and total-ids bounds (LRU). */
  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) {
        this.cache.delete(k);
        this.totalIds -= v.idCount;
      }
    }
    while (
      this.cache.size > this.maxEntries ||
      (this.totalIds > this.maxTotalIds && this.cache.size > 0)
    ) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const v = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (v) this.totalIds -= v.idCount;
    }
  }
}

/** Read one metadata value as a trimmed string ('' when absent). */
function readMeta(md: Metadata | undefined, key: string): string {
  if (!md) return '';
  const v = md.get(key)?.[0];
  if (v == null) return '';
  return (typeof v === 'string' ? v : v.toString()).trim();
}

/** Build the forward-metadata subset (план §3.3) for the domain→control call. */
function buildForwardMetadata(inbound: Metadata | undefined): Metadata {
  const md = new Metadata();
  if (!inbound) return md;
  for (const key of FORWARD_KEYS) {
    const v = inbound.get(key)?.[0];
    if (v != null) md.set(key, typeof v === 'string' ? v : v.toString());
  }
  return md;
}

/**
 * APP_GUARD that hydrates a deferred `x-visibility-scope` BEFORE the handler runs.
 * Register AFTER `GrpcInboundApiKeyGuard` (the key must be validated first). No-op
 * for HTTP, missing scope, or a non-deferred scope. Fail-closed: on any hydration
 * failure the (still deferred) scope is left in place → downstream deny-all.
 */
@Injectable()
export class VisibilityScopeHydrationGuard implements CanActivate {
  constructor(private readonly hydrator: DeferredScopeHydrator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'rpc') return true;
    const metadata = context.getArgByIndex(1) as Metadata | undefined;
    if (!metadata) return true;
    const raw = metadata.get(GW_METADATA.VISIBILITY_SCOPE)?.[0];
    const rawStr = raw == null ? '' : typeof raw === 'string' ? raw : raw.toString();
    if (!rawStr) return true;
    const scope = parseVisibilityScope(rawStr);
    if (!scope || !scope.deferred) return true;

    const hydrated = await this.hydrator.hydrate(scope, metadata);
    if (!hydrated.deferred) {
      // Stamp the hydrated scope back so readVisibilityScope sees resolved lists.
      metadata.set(GW_METADATA.VISIBILITY_SCOPE, serializeVisibilityScope(hydrated));
    }
    // Left deferred on failure → buildVisibilityFilter deny-all (fail-closed).
    return true;
  }
}

/**
 * ClientsModule descriptor for the domain's control client (план §6.3). Consumed
 * as `ClientsModule.register([controlVisibilityClientProvider(url)])`. Default
 * url matches gateway-grpc-clients.ts (127.0.0.1:5002). `maxReceiveMessageLength`
 * is raised because the inline response for very large orgs may exceed the default
 * 4 MiB grpc-js limit (план §9).
 */
export function controlVisibilityClientProvider(
  controlGrpcUrl: string,
  protoPath: string,
): { name: string } & ClientProvider {
  return {
    name: CONTROL_VISIBILITY_GRPC,
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.control.v1',
      protoPath,
      url: controlGrpcUrl || '127.0.0.1:5002',
      // keepCase:true — MUST match the gateway/other domain loaders. The hydrator
      // sends snake_case request keys ({project_id,user_id,resource,inline}); with
      // keepCase:false proto-loader camelCases the proto fields and the request
      // never matches → hydration silently no-ops on live gRPC (P19 blocker).
      // arrays:true keeps empty `repeated` fields as `[]` (consistent with gateway).
      loader: { keepCase: true, arrays: true, longs: Number, defaults: true },
      maxReceiveMessageLength: intEnv('VISIBILITY_HYDRATE_MAX_MSG_BYTES', 32 * 1024 * 1024),
    },
  };
}
