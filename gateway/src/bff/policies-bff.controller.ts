import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { invalidateModuleCache } from '../guards/gateway-module.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { RequirePermission } from '../guards/require-permission.decorator';
import { MembershipOnly } from '../guards/membership-only.decorator';
import { decodeGrpcProject, encodeGrpcModulePolicies } from './project-grpc.codec';
import {
  evaluatePolicies,
  assessPolicyLockout,
  hasOwnerLockoutRisk,
  grpcRuleToFe,
  type AbacFeRule,
  type GrpcPolicyRule,
} from './policies.map';
import { PolicyImpactService } from './policy-impact.service';

type ProjectSvc = Record<string, (x: unknown, m?: unknown) => unknown>;
type RoleSvc = Record<string, (x: unknown, m?: unknown) => unknown>;

/**
 * BFF for the project ABAC policy editor (SCR-PRJSET-POLICIES, E2-15). Public REST
 * surface that the host's `AbacEditor`/`CrmService.apiGetProjectPolicies` expects,
 * mapped onto control's `ProjectGrpc` (policies are stored as `module_policies` on
 * the project — there is no separate policy store). Project-scoped →
 * `ProjectAccessGuard` enforces membership; reads need membership only, mutations
 * need `project:manage` (FR-MPRJ-26), consistent with `PATCH /projects/:id`.
 *
 * Adapter + validator live in `policies.map.ts`. The access SIMULATOR
 * (`POST /projects/:id/access/simulate`) is served by `RolesBffController`.
 *
 * Known gap: `sharingEnabled`/`sharingNotify` have no backing field on the project
 * yet, so they are returned as `false` and accepted-but-not-persisted on save.
 */
type ReqWithUser = FastifyRequest & { user?: { userId?: string } };

@ApiBearerAuth()
@ApiTags('Policies')
@UseGuards(ProjectAccessGuard)
@Controller({ path: '', version: '1' })
export class PoliciesBffController implements OnModuleInit {
  private project!: ProjectSvc;
  private roles!: RoleSvc;

  constructor(
    @Inject('CONTROL_GRPC') private control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly policyImpact: PolicyImpactService,
  ) {}

  onModuleInit() {
    this.project = this.control.getService('ProjectGrpc');
    this.roles = this.control.getService('RoleGrpc');
  }

  private async authorAllowKeys(req: ReqWithUser, projectId: string): Promise<string[]> {
    const userId = req.user?.userId;
    if (!userId) return [];
    const md = this.outboundMeta.build(req, { projectId });
    const res = (await grpcBffCall(
      this.roles.resolveEffectivePermissions(
        { project_id: projectId, user_id: userId },
        md,
      ) as never,
    )) as { allow?: string[] };
    return Array.isArray(res?.allow) ? res.allow.filter(Boolean) : [];
  }

  /** GET — current ABAC rule set for the editor (membership only). */
  @Get('projects/:projectId/policies')
  @ApiTags('Policies')
  @MembershipOnly()
  async getPolicies(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    const project = decodeGrpcProject(
      (await grpcBffCall(this.project.getProject({ id: projectId }, md) as never)) as Record<
        string,
        unknown
      >,
    ) as { module_policies?: GrpcPolicyRule[]; effective_modules?: string[] };

    const effective = project.effective_modules ?? [];
    const rules = (project.module_policies ?? []).map((r) => grpcRuleToFe(r, effective));
    return { rules, moduleDefaults: [], sharingEnabled: false, sharingNotify: false };
  }

  /**
   * PATCH — validate + persist the rule set (replaces module_policies). Returns the
   * 207-style `{accepted, rejected}` envelope; the accepted set is persisted, the
   * rejected rules (with their `AbacErrorCode`) are surfaced inline by the editor.
   * Guard against wiping a good policy set when the whole submission is invalid:
   * only persist when something was accepted or the caller explicitly cleared all.
   */
  @Patch('projects/:projectId/policies')
  @RequirePermission('project', 'manage')
  @ApiTags('Policies')
  async savePolicies(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body() body: { rules?: AbacFeRule[]; sharingEnabled?: boolean; sharingNotify?: boolean },
  ) {
    const input = Array.isArray(body.rules) ? body.rules : [];
    if (hasOwnerLockoutRisk(input)) {
      throw new BadRequestException({
        code: 'OWNER_LOCKOUT',
        message: 'Запрещено: правило отрезало бы владельцу проекта доступ (anti-lockout).',
      });
    }
    const result = evaluatePolicies(input);
    const authorAllow = await this.authorAllowKeys(req, projectId);
    const lockout = assessPolicyLockout(result.accepted, authorAllow);

    if (lockout.ownerLockout) {
      throw new BadRequestException({
        code: 'OWNER_LOCKOUT',
        message: 'Запрещено: правило отрезало бы владельцу проекта доступ (anti-lockout).',
      });
    }

    if (result.acceptedGrpc.length > 0 || input.length === 0) {
      const md = this.outboundMeta.build(req, { projectId });
      await grpcBffCall(
        this.project.updateProject(
          { id: projectId, module_policies: encodeGrpcModulePolicies(result.acceptedGrpc) },
          md,
        ) as never,
        'write',
      );
      // Same class as Bug B/B2 on the module toggle (v1-data-bff): the module
      // guard snapshots `module_policies` for up to the cache TTL, so a freshly
      // saved DENY/ABAC rule stayed unenforced on crm-bff routes for that window.
      invalidateModuleCache(projectId);
    }

    return {
      accepted: result.accepted,
      rejected: result.rejected,
      selfLockoutWarning: lockout.selfLockoutWarning,
    };
  }

  /** POST — dry-run validate (dual-compile), no persistence (EL-PLC-5). */
  @Post('projects/:projectId/policies/validate')
  @RequirePermission('project', 'manage')
  @ApiTags('Policies')
  async validatePolicies(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body() body: { rules?: AbacFeRule[] },
  ) {
    const result = evaluatePolicies(Array.isArray(body.rules) ? body.rules : []);
    const authorAllow = await this.authorAllowKeys(req, projectId);
    const lockout = assessPolicyLockout(result.accepted, authorAllow);
    const impact = await this.policyImpact.estimate(req, projectId, result.accepted, authorAllow);
    return {
      accepted: result.accepted,
      rejected: result.rejected,
      selfLockoutWarning: lockout.selfLockoutWarning,
      ownerLockout: impact.ownerLockout,
      affectedRecords: impact.affectedRecords,
      affectedUsers: impact.affectedUsers,
    };
  }
}
