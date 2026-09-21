import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { projectRoleCan } from '@fairflow/shared';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { PermissionProjectionCacheService } from './permission-projection-cache.service';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { RequirePermission } from '../guards/require-permission.decorator';
import { MembershipOnly } from '../guards/membership-only.decorator';

/**
 * BFF for the RBAC role editor (E2-01 / E2-14). Public REST surface mapped to
 * control's `RoleGrpc`. All routes are project-scoped → `ProjectAccessGuard`
 * enforces membership; mutations require `roles:manage`, reads `roles:read`.
 *
 * Contract: permission-rbac/TZ.md §6.1, contracts/control.md.
 */
type RoleSvc = Record<string, (x: unknown, m?: unknown) => unknown>;
type ReqWithUser = FastifyRequest & { user?: { userId?: string }; __projectRole?: string };

@ApiBearerAuth()
@ApiTags('Roles')
@UseGuards(ProjectAccessGuard)
@Controller({ path: '', version: '1' })
export class RolesBffController implements OnModuleInit {
  private roles!: RoleSvc;
  private controlProject!: RoleSvc;

  constructor(
    @Inject('CONTROL_GRPC') private control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly projectionCache: PermissionProjectionCacheService,
  ) {}

  onModuleInit() {
    this.roles = this.control.getService('RoleGrpc');
    this.controlProject = this.control.getService('ProjectGrpc');
  }

  private actor(req: ReqWithUser): string {
    return req.user?.userId ?? '';
  }

  // ── catalog & roles ───────────────────────────────────────────────────────

  @Get('projects/:projectId/permissions/catalog')
  @RequirePermission('roles', 'read')
  async getCatalog(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(this.roles.getPermissionCatalog({ project_id: projectId }, md) as never);
  }

  @Get('projects/:projectId/roles')
  @RequirePermission('roles', 'read')
  async listRoles(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(this.roles.listRoles({ project_id: projectId }, md) as never);
  }

  @Post('projects/:projectId/roles')
  @RequirePermission('roles', 'manage')
  async createRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body() body: { name?: string; permissions?: string[] },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.createRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          name: body.name ?? '',
          permissions: Array.isArray(body.permissions) ? body.permissions : [],
        },
        md,
      ) as never,
      'write',
    );
  }

  @Patch('projects/:projectId/roles/:roleId')
  @RequirePermission('roles', 'manage')
  async updateRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
    @Body() body: { name?: string; permissions?: string[] },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.updateRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          role_id: roleId,
          name: body.name,
          permissions: Array.isArray(body.permissions) ? body.permissions : [],
          set_permissions: body.permissions !== undefined,
        },
        md,
      ) as never,
      'write',
    );
  }

  @Delete('projects/:projectId/roles/:roleId')
  @RequirePermission('roles', 'manage')
  async deleteRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.deleteRole(
        { project_id: projectId, actor_user_id: this.actor(req), role_id: roleId },
        md,
      ) as never,
      'write',
    );
  }

  @Post('projects/:projectId/roles/:roleId/clone')
  @RequirePermission('roles', 'manage')
  async cloneRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
    @Body() body: { name?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.cloneRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          role_id: roleId,
          name: body.name ?? '',
        },
        md,
      ) as never,
      'write',
    );
  }

  // ── assignments ───────────────────────────────────────────────────────────

  /** FR-ACCESS-590: project-wide role assignment listing for the rights UI. */
  @Get('projects/:projectId/role-assignments')
  @RequirePermission('roles', 'read')
  async listProjectRoleAssignments(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(this.roles.listRoleAssignments({ project_id: projectId }, md) as never);
  }

  @Get('projects/:projectId/members/:userId/roles')
  @RequirePermission('roles', 'read')
  async listMemberRoles(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.listRoleAssignments(
        { project_id: projectId, subject_id: userId, subject_type: 'user' },
        md,
      ) as never,
    );
  }

  @Post('projects/:projectId/members/:userId/roles')
  @RequirePermission('roles', 'manage')
  async grantMemberRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { roleId?: string; scope?: string; expiresAt?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.grantRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          subject_type: 'user',
          subject_id: userId,
          role_id: body.roleId ?? '',
          scope: body.scope ?? 'project',
          expires_at: body.expiresAt ?? '',
        },
        md,
      ) as never,
      'write',
    );
  }

  @Delete('projects/:projectId/members/:userId/roles/:assignmentId')
  @RequirePermission('roles', 'manage')
  async revokeMemberRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.revokeRole(
        { project_id: projectId, actor_user_id: this.actor(req), assignment_id: assignmentId },
        md,
      ) as never,
      'write',
    );
  }

  @Post('projects/:projectId/departments/:deptId/roles')
  @RequirePermission('roles', 'manage')
  async grantDeptRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('deptId') deptId: string,
    @Body() body: { roleId?: string; scope?: string; expiresAt?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.grantRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          subject_type: 'department',
          subject_id: deptId,
          role_id: body.roleId ?? '',
          scope: body.scope ?? 'project',
          expires_at: body.expiresAt ?? '',
        },
        md,
      ) as never,
      'write',
    );
  }

  @Delete('projects/:projectId/departments/:deptId/roles/:assignmentId')
  @RequirePermission('roles', 'manage')
  async revokeDeptRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.revokeRole(
        { project_id: projectId, actor_user_id: this.actor(req), assignment_id: assignmentId },
        md,
      ) as never,
      'write',
    );
  }

  // ── role assignment to an AccessUnit / group (BX-ACL-BE-5) ─────────────────

  /** Grant a project role to an AccessUnit; reaches the unit's effective members. */
  @Post('projects/:projectId/access-units/:unitId/roles')
  @RequirePermission('roles', 'manage')
  async grantUnitRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Body() body: { roleId?: string; scope?: string; expiresAt?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.grantRole(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          subject_type: 'unit',
          subject_id: unitId,
          role_id: body.roleId ?? '',
          scope: body.scope ?? 'project',
          expires_at: body.expiresAt ?? '',
        },
        md,
      ) as never,
      'write',
    );
  }

  @Delete('projects/:projectId/access-units/:unitId/roles/:assignmentId')
  @RequirePermission('roles', 'manage')
  async revokeUnitRole(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.revokeRole(
        { project_id: projectId, actor_user_id: this.actor(req), assignment_id: assignmentId },
        md,
      ) as never,
      'write',
    );
  }

  // ── simulator, my permissions, projection, audit ──────────────────────────

  /**
   * PDP simulator / explain (E2-09, FR-ABAC-19). "Why allow/deny" for a
   * (user, action, record) along the SAME production resolver path as
   * enforcement (RBAC→ABAC→visibility→sharing), returning a layered trace.
   * Source: permission-abac-visibility/TZ §6.2.
   */
  @Post('projects/:projectId/access/simulate')
  @RequirePermission('roles', 'manage')
  async simulate(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      userId?: string;
      subject?: string;
      action?: string;
      resource?: string;
      recordId?: string;
    },
  ) {
    const actor = this.actor(req);
    const requestedUserId = (body.userId ?? '').trim();
    if (
      requestedUserId &&
      requestedUserId !== actor &&
      !projectRoleCan(req.__projectRole, 'manage')
    ) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Simulating access for another user requires project manage rights',
      });
    }
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.simulateAccessExplain(
        {
          project_id: projectId,
          user_id: requestedUserId || actor,
          subject: body.subject ?? '',
          action: body.action ?? '',
          resource: body.resource ?? '',
          record_id: body.recordId ?? '',
        },
        md,
      ) as never,
    );
  }

  /**
   * API-3 (ui-shell §6): batch record-dependent permission checks — reserve path B
   * when `can.*` flags are absent from the cached record (FR-SHELL-130).
   * Any project member may check their OWN rights; uses the production PDP path
   * (`SimulateAccessExplain`) without the roles:manage gate of `/access/simulate`.
   */
  @Post('projects/:projectId/can')
  @MembershipOnly()
  async batchCan(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      checks?: Array<{
        subject?: string;
        action?: string;
        recordRef?: { resource?: string; recordId?: string };
      }>;
    },
  ) {
    const userId = this.actor(req);
    const rawChecks = Array.isArray(body.checks) ? body.checks : [];
    /** Reserve path — keep the fan-out bounded (fail-closed beyond the cap). */
    const BATCH_CAN_LIMIT = 32;
    const checks = rawChecks.slice(0, BATCH_CAN_LIMIT);
    const overflow = rawChecks.slice(BATCH_CAN_LIMIT);
    const md = this.outboundMeta.build(req, { projectId });

    const results = await Promise.all(
      checks.map(async (check) => {
        const subject = (check.subject ?? '').trim();
        const action = (check.action ?? '').trim();
        const resource = (check.recordRef?.resource ?? subject).trim();
        const recordId = (check.recordRef?.recordId ?? '').trim();

        if (!userId) {
          return {
            subject,
            action,
            recordRef: check.recordRef ?? null,
            allow: false,
            reason: 'UNAUTHENTICATED',
          };
        }

        if (!subject || !action) {
          return {
            subject,
            action,
            recordRef: check.recordRef ?? null,
            allow: false,
            reason: 'INVALID_CHECK',
          };
        }

        try {
          const res = (await grpcBffCall(
            this.roles.simulateAccessExplain(
              {
                project_id: projectId,
                user_id: userId,
                subject,
                action,
                resource,
                record_id: recordId,
              },
              md,
            ) as never,
          )) as { decision?: string; reason?: string };

          return {
            subject,
            action,
            recordRef: check.recordRef ?? null,
            allow: res.decision === 'allow',
            reason: res.reason ?? (res.decision === 'allow' ? 'OK' : 'DENIED'),
          };
        } catch {
          return {
            subject,
            action,
            recordRef: check.recordRef ?? null,
            allow: false,
            reason: 'PDP_UNAVAILABLE',
          };
        }
      }),
    );

    const overflowResults = overflow.map((check) => ({
      subject: (check.subject ?? '').trim(),
      action: (check.action ?? '').trim(),
      recordRef: check.recordRef ?? null,
      allow: false,
      reason: 'BATCH_LIMIT',
    }));

    return { results: [...results, ...overflowResults] };
  }

  /** "My permissions" (FR-PERM-19): only membership required, no roles:read. */
  @Get('projects/:projectId/me/permissions')
  @MembershipOnly()
  async myPermissions(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.resolveEffectivePermissions(
        { project_id: projectId, user_id: this.actor(req) },
        md,
      ) as never,
    );
  }

  /**
   * FR-ACCESS-570: readable per-module visibility summary for the current user
   * (manager+ self-service; membership only).
   */
  @Get('projects/:projectId/me/visibility-summary')
  @MembershipOnly()
  async myVisibilitySummary(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const userId = this.actor(req);
    const md = this.outboundMeta.build(req, { projectId });
    const resources = ['contacts', 'companies', 'deals', 'orders', 'activities'];
    const modules: Array<{ module: string; mode: string; level: string }> = [];
    for (const resource of resources) {
      try {
        const vis = (await grpcBffCall(
          this.controlProject.resolveRecordVisibility(
            { project_id: projectId, user_id: userId, resource },
            md,
          ) as never,
        )) as { mode?: string; level?: string };
        modules.push({
          module: resource,
          mode: vis.mode ?? 'restricted',
          level: vis.level ?? 'custom',
        });
      } catch {
        // Module disabled or resolver fail-soft — omit from summary.
      }
    }
    return { modules };
  }

  /**
   * API-2 (ui-shell §5.1): `PermissionProjection` for the current (user, project)
   * — the source `usePermissionProjection` (R3-E1-10) reads to switch FE gating
   * from permissive to fail-closed. Only membership required (no roles:read), the
   * projection is the user's own effective rights. New engine computation (RBAC +
   * module policies + visibility), not a passthrough of `x-permissions`.
   */
  @Get('projects/:projectId/permissions')
  @MembershipOnly()
  async permissionProjection(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    const userId = this.actor(req);
    // LKG cache (P0-3): control is always the source of truth, but a single
    // transport failure must not collapse the owner's sidebar. The reshaped
    // projection is cached; on UNAVAILABLE/DEADLINE we replay the last good one.
    return this.projectionCache.resolve(userId, projectId, async () => {
      const res = (await grpcBffCall(
        this.roles.resolvePermissionProjection(
          { project_id: projectId, user_id: userId },
          md,
        ) as never,
      )) as {
        project_id?: string;
        allowed?: string[];
        module_policy_flags?: Array<{ module_id?: string; flags?: Record<string, boolean> }>;
        visibility_scope?: {
          mode?: string;
          level?: string;
          self_id?: string;
          department_ids?: string[];
        };
        epoch?: number | string;
      };
      // Reshape the gRPC repeated<ModulePolicyFlagSet> into the FE projection map.
      const modulePolicyFlags: Record<string, Record<string, boolean>> = {};
      for (const set of res.module_policy_flags ?? []) {
        if (set.module_id) modulePolicyFlags[set.module_id] = set.flags ?? {};
      }
      const vs = res.visibility_scope ?? {};
      return {
        projectId: res.project_id ?? projectId,
        allowed: res.allowed ?? [],
        modulePolicyFlags,
        visibilityScope: {
          mode: vs.mode ?? 'restricted',
          level: vs.level ?? 'only_own',
          selfId: vs.self_id ?? userId,
          departmentIds: vs.department_ids ?? [],
        },
        epoch: Number(res.epoch ?? 0) || 0,
      };
    });
  }

  // ── addressed permission grants (BX-ACL-BE-4) ─────────────────────────────

  /** List the project's addressed allow/deny grants (PermissionGrant overlay). */
  @Get('projects/:projectId/grants')
  @RequirePermission('roles', 'read')
  async listGrants(@Req() req: ReqWithUser, @Param('projectId') projectId: string) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(this.roles.listPermissionGrants({ project_id: projectId }, md) as never);
  }

  /**
   * Create/replace an addressed grant. Control enforces the fail-closed rules
   * (catalog + project-grantable + no-self-escalation for allow, no blanket deny,
   * no deny on access-subjects). A grant is a project-wide blanket in v1 — the UI
   * does not narrow by resource/condition.
   */
  @Post('projects/:projectId/grants')
  @RequirePermission('roles', 'manage')
  async upsertGrant(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      effect?: string;
      subject?: string;
      action?: string;
      granteeType?: string;
      granteeId?: string;
    },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.upsertPermissionGrant(
        {
          project_id: projectId,
          actor_user_id: this.actor(req),
          effect: body.effect ?? '',
          subject: body.subject ?? '',
          action: body.action ?? '',
          grantee_type: body.granteeType ?? '',
          grantee_id: body.granteeId ?? '',
        },
        md,
      ) as never,
      'write',
    );
  }

  @Delete('projects/:projectId/grants/:grantId')
  @RequirePermission('roles', 'manage')
  async revokeGrant(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Param('grantId') grantId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.revokePermissionGrant(
        { project_id: projectId, actor_user_id: this.actor(req), grant_id: grantId },
        md,
      ) as never,
      'write',
    );
  }

  @Get('projects/:projectId/audit/roles')
  @RequirePermission('roles', 'read')
  async roleAudit(
    @Req() req: ReqWithUser,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('fromTs') fromTs?: string,
    @Query('toTs') toTs?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.roles.listRoleAuditLog(
        {
          project_id: projectId,
          limit: limit ? parseInt(limit, 10) : 50,
          cursor: cursor ?? '',
          filter_actor_user_id: actorUserId ?? '',
          filter_entity_type: entityType ?? '',
          filter_entity_id: entityId ?? '',
          from_ts: fromTs ?? '',
          to_ts: toTs ?? '',
        },
        md,
      ) as never,
    );
  }
}
