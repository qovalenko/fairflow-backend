import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Last-known-good (LKG) cache for the per-(user, project) permission projection
 * served by `GET projects/:projectId/permissions` (roles-bff, API-2).
 *
 * Contract (P0-3): a *single* transient gRPC failure (control down / timeout /
 * UNAVAILABLE / DEADLINE_EXCEEDED) must NOT collapse the owner's sidebar. The FE
 * fails closed on a 5xx, so instead of surfacing the transport error we replay
 * the last successful projection for that key while control recovers.
 *
 * Semantics:
 *  - We ALWAYS hit control first (this is not a read-through cache — the source
 *    of truth is control's engine computation). A *successful* response is always
 *    written to the cache and returned as-is.
 *  - ONLY on a transport failure (gRPC UNAVAILABLE=14 / DEADLINE_EXCEEDED=4, or a
 *    gateway-side deadline `ServiceUnavailableException`) do we serve the stored
 *    projection — and only if it is still inside its stale-grace window.
 *  - Any other gRPC code (PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT, …) is a
 *    real decision from control and is propagated unchanged; the cache is neither
 *    read nor mutated on those paths.
 *  - No cached entry (or an expired one) → the error is propagated (fail-closed,
 *    identical to today's behaviour).
 *
 * Epoch invalidation is intentionally NOT implemented: because every request
 * still goes to control on the happy path, a fresh epoch is always picked up
 * immediately. A stale entry is only ever served precisely when control is
 * unreachable — i.e. when no newer epoch is obtainable anyway.
 *
 * Modelled on billing's `GatewayApiKeyValidationService` stale-serve pattern:
 * positive-only cache, transport failures never poison it, size-bounded LRU.
 */

export interface PermissionProjection {
  projectId: string;
  allowed: string[];
  modulePolicyFlags: Record<string, Record<string, boolean>>;
  visibilityScope: {
    mode: string;
    level: string;
    selfId: string;
    departmentIds: string[];
  };
  epoch: number;
}

interface CacheEntry {
  value: PermissionProjection;
  /** Wall-clock time of the last successful fetch (for age logging). */
  storedAt: number;
  /** Soft-TTL marker: after this the entry is "stale" (informational only —
   *  serving still always re-fetches on the happy path). */
  exp: number;
  /** Until this we may replay the entry while control is unreachable. */
  staleUntil: number;
}

/** gRPC transport codes for which we serve last-known-good instead of failing. */
function isTransportFailure(err: unknown): boolean {
  // Gateway-side deadline (rxjs `timeout` in grpcBffCall) surfaces as this.
  if (err instanceof ServiceUnavailableException) return true;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED;
}

@Injectable()
export class PermissionProjectionCacheService {
  private readonly logger = new Logger(PermissionProjectionCacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight background refreshes, keyed identically to the cache. */
  private readonly inFlight = new Map<string, Promise<void>>();

  /** Soft-TTL; `0` disables the cache entirely (behaviour identical to before). */
  private readonly ttlMs = parseInt(process.env.GATEWAY_PERMPROJ_CACHE_TTL_MS ?? '30000', 10);
  /** How long after the last success a projection may still be replayed. */
  private readonly staleGraceMs = parseInt(
    process.env.GATEWAY_PERMPROJ_STALE_GRACE_MS ?? '600000',
    10,
  );
  /** Upper bound on distinct cached keys before LRU eviction kicks in. */
  private readonly maxEntries = parseInt(process.env.GATEWAY_PERMPROJ_CACHE_MAX ?? '5000', 10);

  constructor(@Optional() @Inject(MetricsService) private readonly metrics?: MetricsService) {}

  private static key(userId: string, projectId: string): string {
    return `${userId}::${projectId}`;
  }

  /**
   * Resolve the projection through control (`fetch`), transparently replaying the
   * last-known-good result only when control is unreachable.
   */
  async resolve(
    userId: string,
    projectId: string,
    fetch: () => Promise<PermissionProjection>,
  ): Promise<PermissionProjection> {
    // Cache disabled → straight passthrough (today's behaviour).
    if (this.ttlMs <= 0) return fetch();

    const key = PermissionProjectionCacheService.key(userId, projectId);
    try {
      const fresh = await fetch();
      this.store(key, fresh);
      return fresh;
    } catch (err) {
      if (!isTransportFailure(err)) throw err; // real decision → propagate, don't touch cache

      const now = Date.now();
      const hit = this.cache.get(key);
      if (!hit || hit.staleUntil <= now) throw err; // nothing serveable → fail-closed

      this.touch(key, hit);
      this.logger.warn(
        `Serving last-known-good permission projection for ${key} ` +
          `(age ${now - hit.storedAt}ms) after transport failure: ${describe(err)}`,
      );
      this.metrics?.recordPermissionProjectionLkgServe();
      this.scheduleRefresh(key, fetch);
      return hit.value;
    }
  }

  private store(key: string, value: PermissionProjection): void {
    const now = Date.now();
    this.cache.delete(key);
    this.cache.set(key, {
      value,
      storedAt: now,
      exp: now + this.ttlMs,
      staleUntil: now + this.staleGraceMs,
    });
    this.evict();
  }

  /** Refresh LRU recency for an existing entry. */
  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /** Fire-and-forget re-fetch after a stale serve; single-flight per key. */
  private scheduleRefresh(key: string, fetch: () => Promise<PermissionProjection>): void {
    if (this.inFlight.has(key)) return;
    const p = fetch()
      .then((fresh) => {
        this.store(key, fresh);
      })
      .catch(() => {
        // Control still down — keep the existing entry; next request retries.
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
  }

  /** Prune entries past their stale window and enforce the LRU size bound. */
  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.staleUntil <= now) this.cache.delete(k);
    }
    // Map preserves insertion order; oldest (least-recently-set/touched) first.
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code !== undefined ? `gRPC code ${String(code)}` : 'unknown error';
}
