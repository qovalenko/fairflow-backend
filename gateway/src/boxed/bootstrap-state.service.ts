import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';

type ReqLike = FastifyRequest & { user?: { userId?: string } };

/**
 * Probe outcome. `unknown` ("could not ask auth") is deliberately distinct from
 * `not-initialized` ("auth answered: no users yet") — callers must not treat an
 * outage as a fresh box.
 */
export type BootstrapState = 'initialized' | 'not-initialized' | 'unknown';

/**
 * BOX-productize Phase E (§5.2): single-shot bootstrap state.
 *
 * "Is this on-prem instance already initialized?" — source of truth is
 * **the existence of at least one user in the auth domain** (no dedicated flag
 * table). We resolve it via `auth.ListUsers({ take: 1 })` with the gateway
 * service key and cache the *positive* answer in memory for a short TTL so
 * `/api/public-config` (hit before every login) does not fan out to auth on
 * every request. The cache is invalidated after a successful `/api/bootstrap`.
 *
 * FR-ORG-007: bootstrap is complete only when the singleton SystemSettings row
 * exists (control `HasSystem`). A partial failure (user created, org missing)
 * keeps `needsBootstrap` true until org creation succeeds.
 *
 * The cache is intentionally one-directional: once we observe `initialized`
 * we latch it (a box never de-initializes), and while not-yet-initialized we
 * keep re-checking (cheap, and the count is 0/1) so a freshly-created master
 * user is reflected immediately.
 */
@Injectable()
export class BootstrapStateService implements OnModuleInit {
  private static readonly TTL_MS = 30_000;

  private authGrpc!: {
    listUsers: (x: unknown, m?: unknown) => unknown;
  };
  private orgGrpc!: {
    hasSystem: (x: unknown, m?: unknown) => unknown;
  };

  /** Latched `true` once we ever observe a user; `undefined` until first probe. */
  private initialized: boolean | undefined;
  private checkedAt = 0;

  /** Latched `true` once we ever observe the system org row. */
  private systemExists: boolean | undefined;
  private systemCheckedAt = 0;

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.authGrpc = this.authClient.getService('AuthGrpc');
    this.orgGrpc = this.controlClient.getService('OrganizationGrpc');
  }

  /** Mark the instance initialized (called after a successful bootstrap). */
  markInitialized(): void {
    this.markUserExists();
    this.markSystemExists();
  }

  /**
   * Latch «≥1 user» after Register/replay, even if CreateOrganization still
   * fails — otherwise a 30s negative cache lets a *different* email register
   * and become platform_owner (FR-ORG-007).
   */
  markUserExists(): void {
    this.initialized = true;
    this.checkedAt = Date.now();
  }

  /** Mark the singleton system org as present (post CreateOrganization). */
  markSystemExists(): void {
    this.systemExists = true;
    this.systemCheckedAt = Date.now();
  }

  /**
   * `initialized` when the instance already has ≥1 user. Cached positive result
   * for {@link TTL_MS}. On a transient auth outage we report the last known
   * value, or `unknown` when never probed — never `not-initialized`: a gateway
   * that restarted while auth was still coming up would otherwise declare a
   * live box "fresh" and push everyone to the create-first-admin screen.
   */
  async probe(req: ReqLike): Promise<BootstrapState> {
    if (this.initialized === true) return 'initialized';
    const fresh = Date.now() - this.checkedAt < BootstrapStateService.TTL_MS;
    if (this.initialized !== undefined && fresh) {
      return this.initialized ? 'initialized' : 'not-initialized';
    }

    const md = this.outboundMeta.build(req);
    try {
      const r = (await grpcBffCall(this.authGrpc.listUsers({ skip: 0, take: 1 }, md) as never)) as {
        list?: unknown[];
        total?: number;
      };
      const count = Number(r?.total ?? 0) || (Array.isArray(r?.list) ? r.list.length : 0);
      this.initialized = count > 0;
      this.checkedAt = Date.now();
      return this.initialized ? 'initialized' : 'not-initialized';
    } catch {
      // auth unreachable — do not latch; keep the last known answer, otherwise
      // admit we could not check.
      return this.initialized === false ? 'not-initialized' : 'unknown';
    }
  }

  /**
   * `true` when the instance already has ≥1 user. Cached positive result for
   * {@link TTL_MS}. On a transient auth outage returns the last known value, or
   * `false` when never probed — bootstrap may proceed; the DB-unique Register is
   * the real guard.
   */
  async isInitialized(req: ReqLike): Promise<boolean> {
    if (this.initialized === true) return true;
    const fresh = Date.now() - this.checkedAt < BootstrapStateService.TTL_MS;
    if (this.initialized !== undefined && fresh) return this.initialized;

    const md = this.outboundMeta.build(req);
    try {
      const r = (await grpcBffCall(this.authGrpc.listUsers({ skip: 0, take: 1 }, md) as never)) as {
        list?: unknown[];
        total?: number;
      };
      const count = Number(r?.total ?? 0) || (Array.isArray(r?.list) ? r.list.length : 0);
      this.initialized = count > 0;
      this.checkedAt = Date.now();
      return this.initialized;
    } catch {
      return this.initialized ?? false;
    }
  }

  /**
   * FR-ORG-007: `true` when control's singleton SystemSettings row exists.
   * Drives `needsBootstrap` in public-config (org missing → keep onboarding).
   */
  async hasSystem(req: ReqLike): Promise<boolean> {
    if (this.systemExists === true) return true;
    const fresh = Date.now() - this.systemCheckedAt < BootstrapStateService.TTL_MS;
    if (this.systemExists !== undefined && fresh) return this.systemExists;

    const md = this.outboundMeta.build(req);
    try {
      const r = (await grpcBffCall(this.orgGrpc.hasSystem({}, md) as never)) as {
        exists?: boolean;
      };
      this.systemExists = Boolean(r?.exists);
      this.systemCheckedAt = Date.now();
      return this.systemExists;
    } catch {
      return this.systemExists ?? false;
    }
  }
}
