import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { GW_METADATA, validatePropagatedGatewayMetadata } from '@fairflow/shared';

/**
 * PEP: validates the gateway service-API-key on every inbound gRPC call.
 * The domain trusts propagated gateway metadata and never parses end-user JWTs;
 * the key is validated against auth `ApiKeyGrpc.ValidateServiceApiKey` with a
 * resilient cache.
 *
 * Resilience contract (task #12):
 *  - A *successful* auth response is a real decision and is cached (positive
 *    or negative), positive entries additionally keep a stale-serve window.
 *  - A *transport failure* (auth down / timeout / UNAVAILABLE) is NOT cached as
 *    negative. If we have a recent positive result we keep serving it within a
 *    stale grace window (fail-open on a previously-trusted key); otherwise we
 *    surface UNAVAILABLE so the caller can retry instead of hard 401s for the
 *    whole TTL.
 *  - The cache is size-bounded (LRU) and prunes expired entries.
 */

interface CacheEntry {
  ok: boolean;
  /** Soft expiry: after this we re-validate against auth. */
  exp: number;
  /**
   * For positive entries: until this we may keep serving the key even if auth
   * is currently unreachable. Undefined for negative entries (never stale-serve
   * a negative).
   */
  staleUntil?: number;
}

@Injectable()
export class GatewayApiKeyValidationService implements OnModuleInit {
  private apiKeyGrpc!: {
    validateServiceApiKey: (d: unknown) => import('rxjs').Observable<Record<string, unknown>>;
  };
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = parseInt(process.env.GATEWAY_KEY_CACHE_TTL_MS ?? '60000', 10);
  /**
   * How long a previously-validated positive key may keep being accepted while
   * auth is unreachable (fail-open grace on transport failures only).
   */
  private readonly staleGraceMs = parseInt(
    process.env.GATEWAY_KEY_STALE_GRACE_MS ?? '600000',
    10,
  );
  /** Upper bound on distinct cached keys before LRU eviction kicks in. */
  private readonly maxEntries = parseInt(
    process.env.GATEWAY_KEY_CACHE_MAX ?? '1000',
    10,
  );

  constructor(@Inject('AUTH_VALIDATION_GRPC') private readonly authClient: ClientGrpcProxy) {}

  onModuleInit() {
    this.apiKeyGrpc = this.authClient.getService('ApiKeyGrpc');
  }

  async assertValidGatewayCall(metadata: Metadata | undefined): Promise<void> {
    const raw = metadata?.get(GW_METADATA.SERVICE_API_KEY)?.[0];
    const key = typeof raw === 'string' ? raw : (raw?.toString?.() ?? '');
    if (!key.trim()) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing x-service-api-key',
      });
    }
    const h = createHash('sha256').update(key.trim()).digest('hex');
    const now = Date.now();
    const hit = this.cache.get(h);

    // Fresh cache hit — trust the last real decision from auth.
    if (hit && hit.exp > now) {
      this.touch(h, hit);
      if (!hit.ok) {
        throw new RpcException({
          code: status.UNAUTHENTICATED,
          message: 'Invalid gateway service API key',
        });
      }
      this.assertPropagated(metadata);
      return;
    }

    let decision: boolean | undefined;
    let transportError: unknown;
    try {
      const r = (await firstValueFrom(
        this.apiKeyGrpc.validateServiceApiKey({ api_key: key.trim() }) as never,
      )) as { active?: boolean };
      // Auth answered: this is a genuine decision (active true or false).
      decision = r.active === true;
    } catch (e) {
      // Transport / availability failure — NOT an authorization decision.
      transportError = e;
    }

    if (decision !== undefined) {
      this.store(h, {
        ok: decision,
        exp: now + this.ttlMs,
        staleUntil: decision ? now + this.staleGraceMs : undefined,
      });
      if (!decision) {
        throw new RpcException({
          code: status.UNAUTHENTICATED,
          message: 'Invalid gateway service API key',
        });
      }
      this.assertPropagated(metadata);
      return;
    }

    // Auth was unreachable. Do not cache a negative. Fail-open on a recent
    // positive result within the grace window; otherwise surface UNAVAILABLE.
    if (hit && hit.ok && (hit.staleUntil ?? 0) > now) {
      this.touch(h, hit);
      this.assertPropagated(metadata);
      return;
    }
    const detail =
      transportError instanceof Error && transportError.message
        ? `: ${transportError.message}`
        : '';
    throw new RpcException({
      code: status.UNAVAILABLE,
      message: `Auth service unavailable for gateway key validation${detail}`,
    });
  }

  private store(h: string, entry: CacheEntry): void {
    this.cache.delete(h);
    this.cache.set(h, entry);
    this.evict();
  }

  /** Refresh LRU recency for an existing entry. */
  private touch(h: string, entry: CacheEntry): void {
    this.cache.delete(h);
    this.cache.set(h, entry);
  }

  /** Prune expired entries and enforce the LRU size bound. */
  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      // Keep positive entries alive until their stale window closes so the
      // fail-open path still has something to serve; drop everything else once
      // past its usefulness.
      const keepUntil = v.ok ? Math.max(v.exp, v.staleUntil ?? 0) : v.exp;
      if (keepUntil <= now) {
        this.cache.delete(k);
      }
    }
    // Map preserves insertion order; oldest (least-recently-set/touched) first.
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private assertPropagated(metadata: Metadata | undefined): void {
    try {
      validatePropagatedGatewayMetadata(metadata);
    } catch (e) {
      const err = e as Error & { code?: number };
      throw new RpcException({
        code: err.code ?? status.UNAUTHENTICATED,
        message: err.message,
      });
    }
  }
}
