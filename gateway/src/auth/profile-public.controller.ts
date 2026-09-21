import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  Inject,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { MembershipOnly } from '../guards/membership-only.decorator';
import { resolveProfileVisibilityLevel, formatVisibilityLevelLabel } from './profile-visibility';

type ApiUser = Record<string, unknown>;

type OrgRoleClient = {
  getOrgRole: (
    x: { organization_id: string; user_id: string },
    m?: unknown,
  ) => Observable<{
    role?: string;
    is_member?: boolean;
    isMember?: boolean;
    is_active?: boolean;
    isActive?: boolean;
  }>;
  listEmployees: (
    x: { organization_id?: string; actor_user_id?: string },
    m?: unknown,
  ) => Observable<{
    list?: { user_id?: string; userId?: string; department_id?: string; departmentId?: string }[];
  }>;
  listDepartments: (
    x: { organization_id?: string; actor_user_id?: string },
    m?: unknown,
  ) => Observable<{ list?: { id?: string; name?: string }[] }>;
};

type ProjectAccessClient = {
  resolveRecordVisibility: (
    x: { project_id: string; user_id: string; resource?: string },
    m?: unknown,
  ) => Observable<{ allowed?: boolean; role?: string }>;
  getMyAccess: (
    x: Record<string, never>,
    m?: unknown,
  ) => Observable<{
    system_roles?: string[];
    systemRoles?: string[];
    projects?: Array<{
      project_id?: string;
      projectId?: string;
      project_name?: string;
      projectName?: string;
      role?: string;
      visibility_level?: string;
      visibilityLevel?: string;
      joined_at?: string;
      joinedAt?: string;
    }>;
  }>;
};

/**
 * Profile BFF on `/api/profile/*` and the public email-confirm endpoint.
 *  - `POST /api/auth/email/confirm` — token-based, @Public.
 *  - `GET /api/profile/users/:id` — foreign-profile projection (FR-MPROF-25);
 *    viewer_context is built here (project_role/platform_role/project_id) and the
 *    field projection runs INSIDE auth (no PII without the right leaves the domain).
 */
@Controller()
export class ProfilePublicController implements OnModuleInit {
  private grpc!: {
    confirmEmailChange: (x: unknown, m?: unknown) => unknown;
    cancelEmailChange: (x: unknown, m?: unknown) => unknown;
    getUserProfileForViewer: (x: unknown, m?: unknown) => unknown;
  };
  private orgRoleClient?: OrgRoleClient;
  private projectClient?: ProjectAccessClient;

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.grpc = this.authClient.getService('AuthGrpc');
    this.orgRoleClient = this.controlClient.getService<OrgRoleClient>('OrganizationGrpc');
    this.projectClient = this.controlClient.getService<ProjectAccessClient>('ProjectGrpc');
  }

  private mapToApiUser(u: ApiUser, extras?: { departmentName?: string; projectRole?: string }) {
    const s = (v: unknown, fb = '') => (typeof v === 'string' ? v : fb);
    return {
      userId: s(u.id),
      userName: s(u.login),
      email: s(u.email),
      name: s(u.name),
      authority: ['USER'],
      avatar: s(u.avatar_url ?? u.avatarUrl),
      phone: s(u.phone),
      position: s(u.position),
      language: s(u.language),
      timezone: s(u.timezone),
      dateFormat: s(u.date_format ?? u.dateFormat),
      timeFormat: s(u.time_format ?? u.timeFormat),
      thousandsSeparator: s(u.thousands_separator ?? u.thousandsSeparator),
      defaultDealsView: s(u.default_deals_view ?? u.defaultDealsView),
      defaultActivitiesView: s(u.default_activities_view ?? u.defaultActivitiesView),
      lastActiveAt: s(u.last_active_at ?? u.lastActiveAt),
      departmentName: extras?.departmentName ?? '',
      projectRole: extras?.projectRole ?? '',
    };
  }

  private async resolvePlatformRole(
    req: FastifyRequest & { user: { userId: string } },
    userId: string,
  ): Promise<string> {
    try {
      const md = this.outboundMeta.build(req);
      const res = await firstValueFrom(
        this.orgRoleClient!.getOrgRole({ organization_id: '', user_id: userId }, md),
      );
      // A deactivated employee keeps its role row — never let an inactive
      // platform_owner/admin pass the cross-project shortcut (org-pdp contract).
      if ((res?.is_active ?? res?.isActive) === false) return '';
      const role = (res?.role ?? '').toLowerCase();
      if (role === 'platform_owner' || role === 'platform_admin') return role;
      return '';
    } catch {
      return '';
    }
  }

  private async resolveTargetProjectAccess(
    req: FastifyRequest & { user: { userId: string } },
    projectId: string,
    targetId: string,
  ): Promise<{ member: boolean; role: string }> {
    try {
      const md = this.outboundMeta.build(req, { projectId });
      const res = await firstValueFrom(
        this.projectClient!.resolveRecordVisibility(
          { project_id: projectId, user_id: targetId, resource: '' },
          md,
        ),
      );
      return { member: res?.allowed === true, role: (res?.role ?? '').trim() };
    } catch {
      return { member: false, role: '' };
    }
  }

  /** Department name for a colleague — any active org member may read structure. */
  private async resolveTargetDepartmentName(
    req: FastifyRequest & { user: { userId: string } },
    targetId: string,
  ): Promise<string> {
    try {
      const md = this.outboundMeta.build(req);
      const actorId = req.user.userId;
      const [empRes, deptRes] = await Promise.all([
        firstValueFrom(
          this.orgRoleClient!.listEmployees({ organization_id: '', actor_user_id: actorId }, md),
        ),
        firstValueFrom(
          this.orgRoleClient!.listDepartments({ organization_id: '', actor_user_id: actorId }, md),
        ),
      ]);
      const employee = (empRes?.list ?? []).find((e) => (e.user_id ?? e.userId ?? '') === targetId);
      const deptId = (employee?.department_id ?? employee?.departmentId ?? '').trim();
      if (!deptId) return '';
      const dept = (deptRes?.list ?? []).find((d) => d.id === deptId);
      return (dept?.name ?? '').trim();
    } catch {
      return '';
    }
  }

  @Public()
  @Post('auth/email/confirm')
  @ApiTags('Profile')
  @ApiOperation({ summary: 'Confirm email change with the one-time token' })
  async confirmEmail(@Body() body: { token?: string }) {
    const u = (await grpcBffCall(
      this.grpc.confirmEmailChange({ token: body.token ?? '' }) as never,
    )) as ApiUser;
    return { user: this.mapToApiUser(u) };
  }

  @Public()
  @Post('auth/email/cancel')
  @ApiTags('Profile')
  @ApiOperation({ summary: 'Cancel a pending email change (token from security alert)' })
  async cancelEmail(@Body() body: { token?: string }) {
    await grpcBffCall(this.grpc.cancelEmailChange({ token: body.token ?? '' }) as never);
    return { ok: true };
  }

  @Get('profile/my-access')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My projects with role and record-visibility level (FR-PROFILE-280)' })
  async myAccess(@Request() req: { user: { userId: string } }) {
    const fastifyReq = req as unknown as FastifyRequest & { user: { userId: string } };
    const md = this.outboundMeta.build(fastifyReq);
    const res = await firstValueFrom(this.projectClient!.getMyAccess({}, md));
    const systemRoles = res?.system_roles ?? res?.systemRoles ?? [];
    const projects = (res?.projects ?? []).map((p) => {
      const visibilityLevel = (p.visibility_level ?? p.visibilityLevel ?? '').trim();
      return {
        projectId: p.project_id ?? p.projectId ?? '',
        projectName: p.project_name ?? p.projectName ?? '',
        role: p.role ?? '',
        visibilityLevel,
        visibilityLabel: formatVisibilityLevelLabel(visibilityLevel),
        joinedAt: p.joined_at ?? p.joinedAt ?? '',
      };
    });
    return { systemRoles, projects };
  }

  @Get('profile/users/:id')
  @ApiTags('Profile')
  @MembershipOnly()
  @UseGuards(JwtAuthGuard, ProjectAccessGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Foreign user profile (field-projected by viewer role)' })
  async userProfile(
    @Request()
    req: {
      user: { userId: string };
      headers: Record<string, unknown>;
      __projectId?: string;
      __projectRole?: string;
    },
    @Param('id') id: string,
  ) {
    const fastifyReq = req as unknown as FastifyRequest & { user: { userId: string } };
    const projectId =
      req.__projectId ??
      (typeof req.headers['x-project-id'] === 'string'
        ? (req.headers['x-project-id'] as string)
        : '');
    const platformRole = await this.resolvePlatformRole(fastifyReq, req.user.userId);
    const isSystem = platformRole === 'platform_owner' || platformRole === 'platform_admin';
    if (!isSystem && !projectId) {
      throw new BadRequestException({
        code: 'PROJECT_ID_REQUIRED',
        message: 'x-project-id header is required to view profiles in a project context',
      });
    }
    const projectRole = req.__projectRole ?? '';
    const visibilityLevel = resolveProfileVisibilityLevel(projectRole, platformRole);

    let targetProjectRole = '';
    if (projectId) {
      const access = await this.resolveTargetProjectAccess(fastifyReq, projectId, id);
      if (!isSystem && !access.member) throw new NotFoundException('User not found');
      targetProjectRole = access.role;
    }

    const md = this.outboundMeta.build(fastifyReq, { projectId: projectId || undefined });
    const u = (await grpcBffCall(
      this.grpc.getUserProfileForViewer(
        {
          target_id: id,
          viewer_context: {
            project_role: projectRole,
            platform_role: platformRole,
            project_id: projectId,
          },
        },
        md,
      ) as never,
    )) as ApiUser;

    let departmentName = '';
    if (visibilityLevel >= 1) {
      departmentName = await this.resolveTargetDepartmentName(fastifyReq, id);
    }

    return {
      user: this.mapToApiUser(u, {
        departmentName: visibilityLevel >= 1 ? departmentName : '',
        projectRole: visibilityLevel >= 1 ? targetProjectRole : '',
      }),
    };
  }
}
