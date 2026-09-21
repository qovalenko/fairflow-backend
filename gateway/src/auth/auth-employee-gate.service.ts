import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { SystemOrgResolverService } from '../bff/system-org-resolver.service';

/**
 * BOX invariant «logged-in ≡ active employee» for OAuth/OIDC handoffs (FR-AUTH-030).
 */
@Injectable()
export class AuthEmployeeGateService implements OnModuleInit {
  private orgGrpc!: {
    getOrgRole: (x: unknown, m?: unknown) => unknown;
  };

  constructor(
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly systemOrg: SystemOrgResolverService,
  ) {}

  onModuleInit(): void {
    this.orgGrpc = this.controlClient.getService('OrganizationGrpc');
  }

  async isActiveEmployee(userId: string, req: FastifyRequest): Promise<boolean> {
    const uid = userId?.trim();
    if (!uid) return false;
    const organizationId = await this.systemOrg.resolveSystemOrgId({
      headers: req.headers as Record<string, unknown>,
      user: { userId: uid },
    });
    if (!organizationId) return false;
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      const res = (await grpcBffCall(
        this.orgGrpc.getOrgRole({ organization_id: organizationId, user_id: uid }, md) as never,
      )) as { is_member?: boolean; isMember?: boolean; is_active?: boolean; isActive?: boolean };
      return (res.is_member ?? res.isMember) === true && (res.is_active ?? res.isActive) === true;
    } catch {
      return false;
    }
  }
}
