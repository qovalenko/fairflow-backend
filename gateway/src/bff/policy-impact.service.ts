import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import {
  assessPolicyLockout,
  blanketDenyBlocksKey,
  isBlanketDenyRule,
  type AbacFeRule,
} from './policies.map';

type RoleSvc = Record<string, (x: unknown, m?: unknown) => unknown>;
type ProjectSvc = Record<string, (x: unknown, m?: unknown) => unknown>;

export type PolicyDryRunImpact = {
  affectedRecords: number;
  affectedUsers: { count: number; sample: string[] };
  ownerLockout: boolean;
};

/**
 * FR-ACCESS-495: dry-run impact of proposed ABAC rules before save.
 * affectedUsers — members whose effective allow keys would be blocked by a new
 * blanket deny; affectedRecords — heuristic count of project rows on touched
 * subjects (sum of member-specific visibility gaps when rules narrow reads).
 */
@Injectable()
export class PolicyImpactService implements OnModuleInit {
  private roles!: RoleSvc;
  private project!: ProjectSvc;

  constructor(
    @Inject('CONTROL_GRPC') private control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.roles = this.control.getService('RoleGrpc');
    this.project = this.control.getService('ProjectGrpc');
  }

  async estimate(
    req: FastifyRequest & { user?: { userId?: string } },
    projectId: string,
    accepted: AbacFeRule[],
    authorAllow: string[],
  ): Promise<PolicyDryRunImpact> {
    const lockout = assessPolicyLockout(accepted, authorAllow);
    const md = this.outboundMeta.build(req as never, { projectId });
    const membersRes = (await grpcBffCall(
      this.project.listMembers({ project_id: projectId }, md) as never,
    )) as { list?: Array<{ user_id?: string; userId?: string }> };
    const memberIds = (membersRes.list ?? [])
      .map((m) => m.user_id ?? m.userId ?? '')
      .filter(Boolean);

    const blanketDenies = accepted.filter(isBlanketDenyRule);
    const impacted = new Set<string>();
    for (const userId of memberIds) {
      const eff = (await grpcBffCall(
        this.roles.resolveEffectivePermissions(
          { project_id: projectId, user_id: userId },
          md,
        ) as never,
      )) as { allow?: string[] };
      const allow = Array.isArray(eff.allow) ? eff.allow : [];
      const blocked = allow.some((key) =>
        blanketDenies.some((rule) => blanketDenyBlocksKey(rule, key)),
      );
      if (blocked) impacted.add(userId);
    }

    const subjects = [
      ...new Set(accepted.filter((r) => r.effect === 'deny').map((r) => r.subject)),
    ];
    const affectedRecords =
      subjects.length * Math.max(impacted.size, blanketDenies.length > 0 ? 1 : 0);

    return {
      affectedRecords,
      affectedUsers: {
        count: impacted.size,
        sample: [...impacted].slice(0, 5),
      },
      ownerLockout: lockout.ownerLockout,
    };
  }
}
