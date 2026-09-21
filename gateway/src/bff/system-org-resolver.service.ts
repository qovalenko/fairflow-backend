import { Inject, Injectable } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

type ListMyOrganizationsResult = {
  list?: { id?: string }[];
};

type OrgClient = {
  listMyOrganizations: (
    x: { user_id: string },
    m?: unknown,
  ) => Observable<ListMyOrganizationsResult>;
};

type ReqLike = { headers: Record<string, unknown>; user?: { userId?: string } };

/**
 * SystemOrgResolverService (DEORG-GW-1) — resolves THE single organization id of
 * this single-tenant box instance, server-side. The client never supplies an
 * `orgId`: after box de-orgification the URL/headers carry no organization at all,
 * so any route/domain that still needs the org anchor (requisites GET/PATCH, chat
 * DM/group isolation) gets it from here.
 *
 * The anchor is a process-lifetime constant (box is provisioned with exactly one
 * Organization, DEORG-DATA-1), so a single successful resolution is cached for the
 * life of the instance. control's `ListMyOrganizations` returns the caller's org
 * (single-tenant ⇒ the one system org); we cache its id globally — the value is
 * identical for every member. An empty result (pre-bootstrap, or a non-member
 * caller) is NEVER cached, so the first real member resolves it after bootstrap.
 * `invalidate()` drops the cache on (de)activation/re-bootstrap.
 */
@Injectable()
export class SystemOrgResolverService {
  private client?: OrgClient;
  private cachedOrgId?: string;

  constructor(
    @Inject('CONTROL_GRPC') private readonly control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  private getClient(): OrgClient {
    if (!this.client) {
      this.client = this.control.getService<OrgClient>('OrganizationGrpc');
    }
    return this.client;
  }

  /** Last successfully resolved system org id (empty string if never resolved). */
  getCachedOrgId(): string {
    return this.cachedOrgId ?? '';
  }

  /** Drop the cached anchor (bootstrap / (de)activation / tests). */
  invalidate(): void {
    this.cachedOrgId = undefined;
  }

  /**
   * Resolve the system org id for this request. Cached after the first success.
   * Returns '' when it cannot be resolved (pre-bootstrap or non-member caller);
   * callers treat '' fail-closed — control ignores a blank organization_id and
   * re-resolves the singleton on its own for the RPCs that tolerate it.
   */
  async resolveSystemOrgId(req: ReqLike): Promise<string> {
    if (this.cachedOrgId) return this.cachedOrgId;
    const userId = req.user?.userId?.trim();
    if (!userId) return '';
    try {
      const md = this.outboundMeta.build(req as never);
      const res = await firstValueFrom(
        this.getClient().listMyOrganizations({ user_id: userId }, md),
      );
      const id = (res?.list?.[0]?.id ?? '').trim();
      if (id) this.cachedOrgId = id;
      return id;
    } catch {
      return '';
    }
  }
}
