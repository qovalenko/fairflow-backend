import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { RedisPubSubService } from '../bff/redis-pubsub.service';
import { SESSION_DENY_PEP_CACHE_MS, sessionDenyRedisKey } from '@fairflow/shared';

/**
 * JTI deny-list PEP for the gateway (BR-AUTH-09 / FR-MPROF-17a).
 *
 * After the JWT signature/exp are verified by the passport strategy, the guard
 * consults the auth domain so that logged-out / revoked / password-changed
 * sessions stop being accepted before their natural `exp` (the contract OQ-7
 * gap: a long access TTL is incompatible with fast revocation without this check).
 *
 * Enforcement is ON by default now that the access TTL is short (24h) and this
 * check is the standard PEP. It can be opted OUT per-stand via
 * `AUTH_SESSION_DENYLIST=false` (also `0`/`off`) — e.g. to avoid the per-request
 * round-trip on auth for a stand that does not need fast revocation.
 *
 * Security posture: revocation AND infrastructure faults are fail-closed
 * (FR-AUTH-130). If auth is unreachable we reject rather than accept a JWT
 * whose session we cannot confirm.
 *
 * NFR-AUTH-020: positive answers are cached briefly in-process; Redis deny keys
 * (pushed by auth on revoke, FR-AUTH-160) are checked before gRPC.
 */
@Injectable()
export class SessionDenyListService implements OnModuleInit {
  private grpc?: { validateSession: (x: unknown, m?: unknown) => unknown };
  private readonly pepCache = new Map<string, { allowed: boolean; until: number }>();

  constructor(
    @Optional() @Inject('AUTH_GRPC') private readonly authClient?: ClientGrpcProxy,
    @Optional() private readonly outboundMeta?: GatewayOutboundMetadataService,
    @Optional() private readonly redis?: RedisPubSubService,
  ) {}

  onModuleInit() {
    if (this.authClient) {
      this.grpc = this.authClient.getService('AuthGrpc');
    }
  }

  get enabled(): boolean {
    // Opt-out (ON by default): only an explicit falsy value disables the PEP.
    const raw = String(process.env.AUTH_SESSION_DENYLIST ?? '')
      .trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  /** Returns true when the token's session is still active (or the check is off). */
  async isAllowed(
    userId: string,
    sessionId: string,
    headers: Record<string, unknown>,
  ): Promise<boolean> {
    return (await this.checkAllowed(userId, sessionId, headers)).allowed;
  }

  async checkAllowed(
    userId: string,
    sessionId: string,
    headers: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.enabled) return { allowed: true };
    if (!this.grpc || !this.outboundMeta) {
      // Not wired — fail-closed when deny-list is expected to be on.
      return { allowed: false, reason: 'session_revoked' };
    }
    if (!userId || !sessionId) return { allowed: false, reason: 'session_revoked' };

    const cacheKey = `${userId}:${sessionId}`;

    if (this.redis?.redisEnabled) {
      const denied = await this.redis.get(sessionDenyRedisKey(sessionId));
      if (denied) {
        const reason = denied === '1' ? 'session_revoked' : denied;
        this.pepCache.set(cacheKey, { allowed: false, until: Date.now() + 5_000 });
        return { allowed: false, reason };
      }
    }

    const cached = this.pepCache.get(cacheKey);
    if (cached && cached.until > Date.now()) {
      return { allowed: cached.allowed, reason: cached.allowed ? undefined : 'session_revoked' };
    }

    try {
      const md = this.outboundMeta.build({
        headers,
        user: { userId, sessionId },
      } as never);
      const res = (await grpcBffCall(
        this.grpc.validateSession({ user_id: userId, session_id: sessionId }, md) as never,
      )) as { valid?: boolean; reason?: string };
      const allowed = Boolean(res?.valid);
      const reason = allowed || !res?.reason?.trim() ? undefined : res.reason.trim();
      this.pepCache.set(cacheKey, {
        allowed,
        until: Date.now() + SESSION_DENY_PEP_CACHE_MS,
      });
      return { allowed, reason: allowed ? undefined : (reason ?? 'session_revoked') };
    } catch {
      // auth unreachable → fail-closed (FR-AUTH-130)
      return { allowed: false, reason: 'session_revoked' };
    }
  }
}
