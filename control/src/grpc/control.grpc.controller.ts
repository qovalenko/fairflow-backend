import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { GrpcInboundApiKeyGuard } from '../auth-validation/grpc-inbound-api-key.guard';
import { ProjectsService } from '../projects/projects.service';
import { ModuleDisableImpactService } from '../projects/module-disable-impact.service';
import { ModuleLifecycleService } from '../projects/module-lifecycle.service';
import { ProjectInvitationsService } from '../projects/project-invitations.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { OrgStructureService } from '../organizations/org-structure.service';
import { DepartmentBindingsService } from '../organizations/department-bindings.service';
import { InvitationService } from '../organizations/invitations.service';
import { OrgAuditService } from '../organizations/org-audit.service';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { RecordSharesService } from '../organizations/record-shares.service';
import { AccessUnitService } from '../organizations/access-unit.service';
import { SeatsService } from '../organizations/seats.service';
import { UserDirectoryService } from '../user-directory/user-directory.service';
import { RolesService } from '../roles/roles.service';
import { PdpService } from '../roles/pdp.service';
import {
  IntegrationsService,
  type IntegrationView,
  type ApiKeyView,
  type WebhookDeliveryView,
} from '../integrations/integrations.service';
import { AppError } from '@fairflow/shared';
import { jsonToStruct, structToJson } from './struct-codec';
import {
  GW_METADATA,
  normalizeVisibilityConfig,
  readGatewayMetadata,
  readUserId,
  readIdempotencyKey,
  resolveProjectId,
  type JsonValue,
  type ProjectModuleConfig,
  type ProjectModulePolicyRule,
} from '@fairflow/shared';

/**
 * W0-control-idor (CONFORMANCE §2 BE 5): the trusted actor is the gateway-verified
 * `x-user-id`, NOT a body field. The body value is honored only as a fallback for
 * genuine s2s/internal callers that don't pass through the gateway (no metadata).
 * When trusted metadata is present, it always wins — a body that disagrees is a
 * spoof attempt and must never override the JWT-propagated identity.
 */
function resolveActorUserId(metadata: Metadata | undefined, bodyActorUserId?: string): string {
  const fromMeta = readUserId(metadata);
  if (fromMeta) return fromMeta;
  return (bodyActorUserId ?? '').trim();
}

/** FR-PLATFORM-160: client idempotency key from metadata (gateway) or proto body. */
function resolveIdempotencyKey(
  metadata: Metadata | undefined,
  bodyKey?: string,
): string | undefined {
  const raw = readIdempotencyKey(metadata) || (bodyKey ?? '').trim();
  return raw || undefined;
}

function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : '';
}

type GrpcModuleConfig = {
  module_id?: string;
  moduleId?: string;
  enabled?: boolean;
  personal_settings?: Record<string, unknown>;
  personalSettings?: Record<string, unknown>;
  integration_settings?: Record<string, unknown>;
  integrationSettings?: Record<string, unknown>;
  integration_methods_enabled?: string[];
  integrationMethodsEnabled?: string[];
  // TODO-237: lifecycle state on the wire. Both spellings are accepted — the
  // control server loads the proto with `keepCase: true` (snake_case), but a
  // caller/loader without it delivers camelCase; `installed`/`version` happen to
  // be single-word, they are listed once each and read defensively anyway.
  installed?: boolean;
  version?: string;
  runtime_status?: string;
  runtimeStatus?: string;
  ever_suspended?: boolean;
  everSuspended?: boolean;
  config_state?: string;
  configState?: string;
};

type GrpcModulePolicyRule = {
  id?: string;
  module_id?: string;
  moduleId?: string;
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: Record<string, unknown>;
};

@UseGuards(GrpcInboundApiKeyGuard)
@Controller()
export class ControlGrpcController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly moduleDisableImpact: ModuleDisableImpactService,
    private readonly lifecycle: ModuleLifecycleService,
    private readonly organizations: OrganizationsService,
    private readonly structure: OrgStructureService,
    private readonly departmentBindings: DepartmentBindingsService,
    private readonly invitations: InvitationService,
    private readonly orgAudit: OrgAuditService,
    private readonly visibility: VisibilityResolverService,
    private readonly shares: RecordSharesService,
    private readonly users: UserDirectoryService,
    private readonly roles: RolesService,
    private readonly accessUnits: AccessUnitService,
    private readonly accessEpoch: ProjectAccessEpochService,
    private readonly pdp: PdpService,
    private readonly integrations: IntegrationsService,
    private readonly seats: SeatsService,
    private readonly orgPdp: OrgPdpService,
    private readonly projectInvitations: ProjectInvitationsService,
  ) {}

  private toModuleConfigs(input: unknown): ProjectModuleConfig[] {
    if (!Array.isArray(input)) return [];
    const configs: ProjectModuleConfig[] = [];
    for (const item of input as GrpcModuleConfig[]) {
      const moduleId = item.module_id ?? item.moduleId ?? '';
      if (!moduleId) continue;
      configs.push({
        moduleId,
        enabled: item.enabled ?? false,
        // TODO-237: additive lifecycle fields. Only a POSITIVE assertion is
        // carried over (`installed:true`, a non-empty `version`); `false`/absent
        // stays `undefined` so ProjectsService.update merges the stored fact
        // instead of erasing it (proto3 cannot tell false from absent).
        ...(item.installed === true && { installed: true }),
        ...(typeof item.version === 'string' && item.version.length > 0
          ? { version: item.version }
          : {}),
        ...(item.runtime_status === 'active' || item.runtime_status === 'suspended'
          ? { runtimeStatus: item.runtime_status }
          : item.runtimeStatus === 'active' || item.runtimeStatus === 'suspended'
            ? { runtimeStatus: item.runtimeStatus }
            : {}),
        ...(item.ever_suspended === true || item.everSuspended === true
          ? { everSuspended: true }
          : {}),
        ...(item.config_state === 'ready' ||
        item.config_state === 'needs_config' ||
        item.configState === 'ready' ||
        item.configState === 'needs_config'
          ? {
              configState:
                item.config_state === 'needs_config' || item.configState === 'needs_config'
                  ? 'needs_config'
                  : 'ready',
            }
          : {}),
        personalSettings: this.toJsonRecord(item.personal_settings ?? item.personalSettings),
        integrationSettings: this.toJsonRecord(
          item.integration_settings ?? item.integrationSettings,
        ),
        integrationMethodsEnabled:
          item.integration_methods_enabled ?? item.integrationMethodsEnabled ?? [],
      });
    }
    return configs;
  }

  private toModulePolicies(input: unknown): ProjectModulePolicyRule[] {
    if (!Array.isArray(input)) return [];
    const rules: ProjectModulePolicyRule[] = [];
    for (const item of input as GrpcModulePolicyRule[]) {
      const id = item.id ?? '';
      const moduleId = item.module_id ?? item.moduleId ?? '';
      if (!id || !moduleId) continue;
      rules.push({
        id,
        moduleId,
        effect: item.effect === 'deny' ? 'deny' : 'allow',
        subject: item.subject ?? '',
        action: item.action ?? '',
        resource: item.resource ?? '*',
        condition: this.toJsonRecord(item.condition),
      });
    }
    return rules;
  }

  /**
   * Inbound Struct-typed field → plain JSON map. The gateway encodes
   * `personal_settings` / `integration_settings` to the Struct wire format
   * (`{fields:…}`, see struct-codec.ts) — decode it; a plain map from an older
   * peer or a same-process test passes through unchanged.
   */
  private toJsonRecord(value: unknown): Record<string, JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return structToJson(value) as Record<string, JsonValue>;
  }

  private mapProject(project: {
    id: string;
    name: string;
    ownerId: string;
    templateId?: string | null;
    modules?: string[];
    moduleConfigs?: ProjectModuleConfig[];
    modulePolicies?: ProjectModulePolicyRule[];
    visibilityConfig?: Record<string, unknown>;
    effectiveModules?: string[];
    status?: string;
    deletionScheduledAt?: Date | null;
    provisioningStatus?: string;
  }) {
    return {
      id: project.id,
      name: project.name,
      color: '#6366f1',
      template_id: project.templateId ?? '',
      // DEORG-W1: box is single-tenant — every project is owned by the System.
      // The proto field is kept (server-fixed) for FE compat; value is constant.
      owner_type: 'ORGANIZATION',
      owner_id: project.ownerId,
      visibility_config: project.visibilityConfig ?? {},
      status: project.status ?? 'active',
      deletion_scheduled_at:
        project.deletionScheduledAt instanceof Date
          ? project.deletionScheduledAt.toISOString()
          : '',
      modules: project.modules ?? [],
      module_configs: (project.moduleConfigs ?? []).map((cfg) => ({
        module_id: cfg.moduleId,
        enabled: cfg.enabled,
        // TODO-237: the return leg — without it the client round-trips a config
        // with no install fact/version and the next PATCH wipes them.
        installed: cfg.installed ?? cfg.enabled,
        version: cfg.version ?? '',
        runtime_status:
          cfg.runtimeStatus === 'active' || cfg.runtimeStatus === 'suspended'
            ? cfg.runtimeStatus
            : cfg.enabled
              ? 'active'
              : 'suspended',
        ever_suspended: cfg.everSuspended === true,
        config_state: cfg.configState === 'needs_config' ? 'needs_config' : 'ready',
        personal_settings: jsonToStruct(cfg.personalSettings ?? {}),
        integration_settings: jsonToStruct(cfg.integrationSettings ?? {}),
        integration_methods_enabled: cfg.integrationMethodsEnabled ?? [],
      })),
      module_policies: (project.modulePolicies ?? []).map((rule) => ({
        id: rule.id,
        module_id: rule.moduleId,
        effect: rule.effect,
        subject: rule.subject,
        action: rule.action,
        resource: rule.resource,
        condition: jsonToStruct(rule.condition ?? {}),
      })),
      effective_modules: project.effectiveModules ?? project.modules ?? [],
      provisioning_status: project.provisioningStatus ?? 'complete',
    };
  }

  @GrpcMethod('ProjectGrpc', 'ListProjectsByOwner')
  async listProjectsByOwner(data: {
    owner_type?: string;
    ownerType?: string;
    owner_id?: string;
    ownerId?: string;
  }) {
    // DEORG-W1: ownership is always the System — the client-supplied owner_type is
    // ignored; only the system anchor (owner_id) selects the project set.
    const ownerId = data.owner_id ?? data.ownerId ?? '';
    if (!ownerId) return { list: [] };
    const rows = await this.projects.findByOwner(ownerId);
    const list = rows.map((p) => this.mapProject(p));
    return { list };
  }

  @GrpcMethod('ProjectGrpc', 'ListMyProjects')
  async listMyProjects(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    // W0: the subject is the JWT-propagated x-user-id, never a client-supplied
    // query param (closes IDOR — "?userId=other" leaking foreign projects).
    const userId = resolveActorUserId(metadata, data.user_id ?? data.userId);
    if (!userId) return { list: [] };
    const rows = await this.projects.findMyProjects(userId);
    const list = rows.map((p) => this.mapProject(p));
    return { list };
  }

  @GrpcMethod('ProjectGrpc', 'GetMyAccess')
  async getMyAccess(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    const userId = resolveActorUserId(metadata, data.user_id ?? data.userId);
    if (!userId) return { system_roles: [], projects: [] };
    const entries = await this.projects.getMyAccess(userId);
    const orgId = await this.organizations.resolveSystemAnchorId();
    const orgRole = await this.structure.getRole(orgId, userId);
    const systemRoles: string[] = [];
    if (orgRole.isActive !== false) {
      const role = (orgRole.role ?? '').toLowerCase();
      if (role === 'platform_owner' || role === 'platform_admin') {
        systemRoles.push(role);
      }
    }
    return {
      system_roles: systemRoles,
      projects: entries.map((e) => ({
        project_id: e.projectId,
        project_name: e.projectName,
        role: e.role,
        visibility_level: e.visibilityLevel,
        joined_at: e.joinedAt,
      })),
    };
  }

  @GrpcMethod('ProjectGrpc', 'CreateProject')
  async createProject(data: {
    owner_type?: string;
    ownerType?: string;
    owner_id?: string;
    ownerId?: string;
    name?: string;
    template_id?: string;
    templateId?: string;
    modules?: string[];
    module_configs?: GrpcModuleConfig[];
    moduleConfigs?: GrpcModuleConfig[];
    module_policies?: GrpcModulePolicyRule[];
    modulePolicies?: GrpcModulePolicyRule[];
    created_by_user_id?: string;
    createdByUserId?: string;
    seed_demo_data?: boolean;
    seedDemoData?: boolean;
  }) {
    // DEORG-W1: box is single-tenant — the client-supplied owner_type is ignored
    // (there is no personal vector). Ownership is always the System; `owner_id` is
    // the system anchor supplied by the gateway from the singleton.
    const ownerId = data.owner_id ?? data.ownerId ?? '';
    const name = data.name ?? '';
    const rawConfigs = data.module_configs ?? data.moduleConfigs;
    const rawPolicies = data.module_policies ?? data.modulePolicies;
    if (!ownerId || !name) throw new Error('ownerId and name required');
    const project = await this.projects.create({
      ownerId,
      name,
      templateId: data.template_id ?? data.templateId,
      modules: data.modules,
      moduleConfigs: rawConfigs ? this.toModuleConfigs(rawConfigs) : undefined,
      modulePolicies: rawPolicies ? this.toModulePolicies(rawPolicies) : undefined,
      createdByUserId: data.created_by_user_id ?? data.createdByUserId,
      seedDemoData: data.seed_demo_data ?? data.seedDemoData ?? false,
    });
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'GetProject')
  async getProject(data: { id?: string }) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const project = await this.projects.findOne(id);
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'UpdateProject')
  async updateProject(
    data: {
      id?: string;
      name?: string;
      modules?: string[];
      module_configs?: GrpcModuleConfig[];
      moduleConfigs?: GrpcModuleConfig[];
      module_policies?: GrpcModulePolicyRule[];
      modulePolicies?: GrpcModulePolicyRule[];
      visibility_config?: Record<string, string>;
      visibilityConfig?: Record<string, unknown>;
      applied_preset?: string;
      appliedPreset?: string;
      cascade?: boolean;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    const rawConfigs = data.module_configs ?? data.moduleConfigs;
    const rawPolicies = data.module_policies ?? data.modulePolicies;
    const rawVisibility = data.visibility_config ?? data.visibilityConfig;
    if (!id) throw new Error('id required');
    // Actor for the PEP (`assertCanManage`, TODO-085) and the module-policy
    // audit/event (P8 T5.2). Fail-closed: an empty actor denies the update.
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    const project = await this.projects.update(
      id,
      {
        name: data.name || undefined,
        modules: data.modules,
        moduleConfigs: rawConfigs ? this.toModuleConfigs(rawConfigs) : undefined,
        modulePolicies: rawPolicies ? this.toModulePolicies(rawPolicies) : undefined,
        visibilityConfig: rawVisibility ? normalizeVisibilityConfig(rawVisibility) : undefined,
        // BX-MODEL-6: preset marker for the `preset.applied` audit fact.
        appliedPreset: data.applied_preset ?? data.appliedPreset,
        cascade: data.cascade === true,
      },
      actor,
    );
    // K3-invalidation (Д-4): module_policies / visibility_config changes affect
    // access → bump the epoch so the gateway re-resolves cached decisions.
    await this.accessEpoch.bump(id);
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'GetModuleDisableImpact')
  async getModuleDisableImpact(
    data: { project_id?: string; projectId?: string; module_id?: string; moduleId?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const moduleId = (data.module_id ?? data.moduleId ?? '').trim();
    if (!projectId || !moduleId) throw new AppError('invalid', 'project_id and module_id required');
    const actor = resolveActorUserId(metadata);
    await this.projects.assertCanManage(projectId, actor);
    const impact = await this.moduleDisableImpact.getImpact(projectId, moduleId);
    return {
      dependent_enabled_modules: impact.dependentEnabledModules.map((m) => ({
        id: m.id,
        name: m.name,
      })),
      unfinished_records: impact.unfinishedRecords,
      stopped_automations: impact.stoppedAutomations.map((a) => ({
        id: a.id,
        name: a.name,
      })),
      webhook_dlq_suspended: impact.webhookDlqSuspended,
    };
  }

  @GrpcMethod('ProjectGrpc', 'ListMembers')
  async listMembers(data: { project_id?: string; projectId?: string }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    if (!projectId) return { list: [] };
    const members = await this.projects.getMembers(projectId);
    const profiles = await this.users.resolve(members.map((m) => m.userId));
    return {
      list: members.map((m) => {
        const p = profiles.get(m.userId);
        return {
          id: m.userId,
          name: p?.name || p?.login || m.userId,
          email: p?.email ?? '',
          role: m.role,
        };
      }),
    };
  }

  private mapProjectMember(m: {
    id: string;
    projectId: string;
    userId: string;
    role: string;
    createdAt: Date;
  }) {
    return {
      id: m.id,
      project_id: m.projectId,
      user_id: m.userId,
      role: m.role,
      created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
    };
  }

  @GrpcMethod('ProjectGrpc', 'AddMember')
  async addMember(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      role?: string;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    // C5: actor is the JWT-propagated x-user-id; domain re-checks `manage` (PEP).
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const member = await this.projects.addMember(projectId, userId, data.role ?? 'member', actor);
    await this.accessEpoch.bump(projectId); // K3 (Д-4): membership change
    return this.mapProjectMember(member);
  }

  @GrpcMethod('ProjectGrpc', 'UpdateMemberRole')
  async updateMemberRole(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      role?: string;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!projectId || !userId) throw new AppError('invalid', 'projectId and userId required');
    const member = await this.projects.updateMemberRole(projectId, userId, data.role ?? '', actor);
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role change
    return this.mapProjectMember(member);
  }

  @GrpcMethod('ProjectGrpc', 'RemoveMember')
  async removeMember(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      actor_user_id?: string;
      actorUserId?: string;
      reassign_to_user_id?: string;
      reassignToUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    const reassignTo =
      (data.reassign_to_user_id ?? data.reassignToUserId ?? '').trim() || undefined;
    if (!projectId || !userId) throw new AppError('invalid', 'projectId and userId required');
    const result = await this.projects.removeMember(projectId, userId, actor, reassignTo);
    await this.accessEpoch.bump(projectId);
    return result;
  }

  @GrpcMethod('ProjectGrpc', 'PreviewRemoveMember')
  async previewRemoveMember(
    data: {
      project_id?: string;
      projectId?: string;
      user_id?: string;
      userId?: string;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!projectId || !userId) throw new AppError('invalid', 'projectId and userId required');
    const r = await this.projects.previewRemoveMember(projectId, userId, actor);
    return {
      owned_count: r.ownedCount,
      breakdown: r.breakdown.map((b) => ({ domain: b.domain, count: b.count })),
    };
  }

  @GrpcMethod('ProjectGrpc', 'CreateProjectInvitation')
  async createProjectInvitation(
    data: {
      project_id?: string;
      email?: string;
      role?: string;
      invited_by_user_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const r = await this.projectInvitations.create(
      projectId,
      data.email ?? '',
      data.role,
      data.invited_by_user_id ?? actor,
      actor,
    );
    return {
      id: r.invitation.id,
      project_id: r.invitation.projectId,
      project_name: r.projectName,
      email: r.invitation.email,
      role: r.invitation.role,
      status: r.invitation.status,
      token: r.emailToken,
      expired: r.invitation.expiresAt.getTime() < Date.now(),
      expires_at: r.invitation.expiresAt.toISOString(),
    };
  }

  @GrpcMethod('ProjectGrpc', 'GetProjectInvitation')
  async getProjectInvitation(data: { token?: string }) {
    const row = await this.projectInvitations.getByToken(data.token ?? '');
    return {
      id: row.id,
      project_id: row.projectId,
      project_name: row.projectName,
      email: row.email,
      role: row.role,
      status: row.status,
      token: '',
      expired: row.expired,
      expires_at: row.expiresAt.toISOString(),
    };
  }

  @GrpcMethod('ProjectGrpc', 'AcceptProjectInvitation')
  async acceptProjectInvitation(data: { token?: string; user_id?: string }) {
    const r = await this.projectInvitations.accept(data.token ?? '', data.user_id ?? '');
    return {
      project_id: r.projectId,
      project_name: r.projectName,
      role: r.role,
    };
  }

  @GrpcMethod('ProjectGrpc', 'SetModulePersonalSettings')
  async setModulePersonalSettings(
    data: {
      project_id?: string;
      projectId?: string;
      module_id?: string;
      moduleId?: string;
      personal_settings?: Record<string, unknown>;
      personalSettings?: Record<string, unknown>;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const moduleId = (data.module_id ?? data.moduleId ?? '').trim();
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!moduleId) throw new AppError('invalid', 'moduleId required');
    const settings = this.toJsonRecord(data.personal_settings ?? data.personalSettings);
    const saved = await this.projects.setModulePersonalSettings(
      projectId,
      moduleId,
      settings,
      actor,
    );
    // Encode to the Struct wire format — a plain map would serialize to an
    // empty Struct and the gateway would echo `{}` for every save.
    return { personal_settings: jsonToStruct(saved) };
  }

  @GrpcMethod('ProjectGrpc', 'GetModulePersonalSettings')
  async getModulePersonalSettings(
    data: { project_id?: string; projectId?: string; module_id?: string; moduleId?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const moduleId = (data.module_id ?? data.moduleId ?? '').trim();
    if (!moduleId) throw new AppError('invalid', 'moduleId required');
    const settings = await this.projects.getModulePersonalSettings(projectId, moduleId);
    return { personal_settings: jsonToStruct(settings) };
  }

  @GrpcMethod('ProjectGrpc', 'GetModuleIntegrationSettings')
  async getModuleIntegrationSettings(
    data: { project_id?: string; projectId?: string; module_id?: string; moduleId?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const moduleId = (data.module_id ?? data.moduleId ?? '').trim();
    if (!moduleId) throw new AppError('invalid', 'moduleId required');
    const settings = await this.projects.getModuleIntegrationSettings(projectId, moduleId);
    return { integration_settings: jsonToStruct(settings) };
  }

  @GrpcMethod('ProjectGrpc', 'ArchiveProject')
  async archiveProject(
    data: { id?: string; archived?: boolean; actor_user_id?: string; actorUserId?: string },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!id) throw new AppError('invalid', 'id required');
    const project = await this.projects.setArchived(id, data.archived ?? true, actor);
    await this.accessEpoch.bump(id); // K3 (Д-4): archive flips effective access
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'RequestProjectDeletion')
  async requestProjectDeletion(
    data: {
      id?: string;
      actor_user_id?: string;
      actorUserId?: string;
      confirm_name?: string;
      confirmName?: string;
    },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    const confirmName = data.confirm_name ?? data.confirmName;
    if (!id) throw new AppError('invalid', 'id required');
    const project = await this.projects.requestDeletion(id, actor, confirmName);
    await this.accessEpoch.bump(id); // K3 (Д-4): pending_deletion changes effective access
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'RestoreProject')
  async restoreProject(
    data: { id?: string; actor_user_id?: string; actorUserId?: string },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!id) throw new AppError('invalid', 'id required');
    const project = await this.projects.restore(id, actor);
    await this.accessEpoch.bump(id);
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'ApplyTemplate')
  async applyTemplate(
    data: {
      project_id?: string;
      projectId?: string;
      template_id?: string;
      templateId?: string;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const templateId = data.template_id ?? data.templateId ?? '';
    const actor = resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId);
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const project = await this.projects.applyTemplate(projectId, templateId, actor);
    return this.mapProject(project);
  }

  @GrpcMethod('ProjectGrpc', 'CheckAccess')
  async checkAccess(data: {
    project_id?: string;
    projectId?: string;
    user_id?: string;
    userId?: string;
  }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    if (!projectId || !userId) return { allowed: false, role: '' };
    const r = await this.projects.checkAccess(projectId, userId);
    return { allowed: r.allowed, role: r.role ?? '' };
  }

  @GrpcMethod('ProjectGrpc', 'ResolveRecordVisibility')
  async resolveRecordVisibility(data: {
    project_id?: string;
    projectId?: string;
    user_id?: string;
    userId?: string;
    resource?: string;
    inline?: boolean;
  }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    // [#19] Domain-side hydration re-asks control with inline=true to expand an
    // oversized (deferred) scope into the full ownerIds/sharedRecordIds lists.
    const inline = data.inline === true;
    const r = await this.visibility.resolve(projectId, userId, data.resource ?? '', { inline });
    // K3-invalidation (Д-4): stamp the decision with the access epoch it was
    // resolved at. The gateway caches (decision, epoch) and invalidates as soon
    // as the project's current epoch diverges (any access-affecting mutation).
    const epoch = await this.accessEpoch.get(projectId);
    return {
      allowed: r.allowed,
      role: r.role,
      level: r.level,
      mode: r.mode,
      owner_ids: r.ownerIds,
      shared_record_ids: r.sharedRecordIds,
      viewer_department_ids: r.viewerDepartmentIds ?? [],
      department_ids: r.departmentIds,
      epoch,
      // [#19] Oversized scopes are deferred: lists above are empty, descriptor
      // below carries the compact seeds for the domain to resolve server-side.
      deferred: r.deferred,
      descriptor: r.descriptor
        ? {
            unit_ids: r.descriptor.unitIds,
            led_unit_ids: r.descriptor.ledUnitIds,
            selected_group_ids: r.descriptor.selectedGroupIds,
            rule_kinds: r.descriptor.ruleKinds,
            uses_sharing: r.descriptor.usesSharing,
            org_id: r.descriptor.orgId,
          }
        : undefined,
      viewer_unit_ids: r.viewerUnitIds ?? [],
    };
  }

  @GrpcMethod('ProjectGrpc', 'GetProjectAccessEpoch')
  async getProjectAccessEpoch(data: { project_id?: string; projectId?: string }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const epoch = await this.accessEpoch.get(projectId);
    return { epoch };
  }

  private mapShare(s: {
    id: string;
    projectId: string;
    resource: string;
    recordId: string;
    granteeType: string;
    granteeId: string;
    createdBy: string;
    createdAt?: Date | string | null;
    expiresAt?: Date | string | null;
  }) {
    return {
      id: s.id,
      project_id: s.projectId,
      resource: s.resource,
      record_id: s.recordId,
      grantee_type: s.granteeType,
      grantee_id: s.granteeId,
      created_by: s.createdBy,
      created_at: toIso(s.createdAt),
      expires_at: s.expiresAt ? toIso(s.expiresAt) : '',
    };
  }

  @GrpcMethod('ProjectGrpc', 'ShareRecord')
  async shareRecord(
    data: {
      project_id?: string;
      resource?: string;
      record_id?: string;
      grantee_type?: string;
      grantee_id?: string;
      actor_user_id?: string;
      expires_at?: string;
      record_owner_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
    const share = await this.shares.share(
      projectId,
      data.resource ?? '',
      data.record_id ?? '',
      data.grantee_type ?? 'user',
      data.grantee_id ?? '',
      actorUserId,
      expiresAt,
      data.record_owner_user_id,
    );
    await this.accessEpoch.bump(projectId); // K3 (Д-4): share grants access
    return this.mapShare(share);
  }

  @GrpcMethod('ProjectGrpc', 'ListRecordShares')
  async listRecordShares(
    data: { project_id?: string; resource?: string; record_id?: string },
    metadata?: Metadata,
  ) {
    // W0: read is scoped to the trusted x-project-id so shares of a foreign
    // project never leak via a guessed/forged body projectId.
    const projectId = resolveProjectId(metadata, data.project_id);
    const list = await this.shares.list(projectId, data.resource ?? '', data.record_id ?? '');
    return { list: list.map((s) => this.mapShare(s)) };
  }

  @GrpcMethod('ProjectGrpc', 'UnshareRecord')
  async unshareRecord(
    data: { id?: string; actor_user_id?: string; project_id?: string },
    metadata?: Metadata,
  ) {
    // W0 (SEC-BLOCKER): the delete MUST be scoped by the trusted x-project-id so a
    // member of project A can never drop a share belonging to project B by guessing
    // its id (cross-project mutation). Actor comes from the JWT, not the body.
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const result = await this.shares.unshare(data.id ?? '', projectId, actorUserId);
    await this.accessEpoch.bump(projectId); // K3 (Д-4): share revoked
    return result;
  }

  // ─── E2-01 RBAC: roles / assignments / grants / effective resolve / simulate ───

  private mapRoleMsg(r: import('../roles/roles.service').RoleView) {
    return {
      id: r.id,
      scope_type: r.scopeType,
      scope_id: r.scopeId ?? '',
      key: r.key ?? '',
      name: r.name,
      kind: r.kind,
      is_archived: r.isArchived,
      permissions: r.permissions,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  private mapAssignmentMsg(a: import('../roles/roles.service').RoleAssignmentView) {
    return {
      id: a.id,
      project_id: a.projectId,
      subject_type: a.subjectType,
      subject_id: a.subjectId,
      role_id: a.roleId,
      role_name: a.roleName,
      role_key: a.roleKey ?? '',
      scope: a.scope,
      expires_at: a.expiresAt ?? '',
      created_by: a.createdBy,
      created_at: a.createdAt,
    };
  }

  @GrpcMethod('RoleGrpc', 'GetPermissionCatalog')
  async getPermissionCatalog(data: { project_id?: string }) {
    const projectId = data.project_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const catalog = await this.roles.getCatalog(projectId);
    return {
      entries: catalog.entries.map((e) => ({
        subject: e.subject,
        actions: e.actions,
        module_ids: e.moduleIds,
      })),
      keys: catalog.keys,
    };
  }

  @GrpcMethod('RoleGrpc', 'ListRoles')
  async listRoles(data: { project_id?: string }) {
    const projectId = data.project_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const roles = await this.roles.listRoles(projectId);
    return { list: roles.map((r) => this.mapRoleMsg(r)) };
  }

  @GrpcMethod('RoleGrpc', 'CreateRole')
  async createRole(data: {
    project_id?: string;
    actor_user_id?: string;
    name?: string;
    permissions?: string[];
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    const result = await this.roles.createRole({
      projectId,
      actorUserId: actor,
      name: data.name ?? '',
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
    });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role definition added
    return { role: this.mapRoleMsg(result.role), warnings: result.warnings };
  }

  @GrpcMethod('RoleGrpc', 'UpdateRole')
  async updateRole(data: {
    project_id?: string;
    actor_user_id?: string;
    role_id?: string;
    name?: string;
    permissions?: string[];
    set_permissions?: boolean;
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.role_id) throw new AppError('invalid', 'role_id required');
    const result = await this.roles.updateRole({
      projectId,
      actorUserId: actor,
      roleId: data.role_id,
      name: data.name ? data.name : undefined,
      permissions: data.set_permissions
        ? Array.isArray(data.permissions)
          ? data.permissions
          : []
        : undefined,
    });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role permissions changed
    return { role: this.mapRoleMsg(result.role), warnings: result.warnings };
  }

  @GrpcMethod('RoleGrpc', 'DeleteRole')
  async deleteRole(data: { project_id?: string; actor_user_id?: string; role_id?: string }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.role_id) throw new AppError('invalid', 'role_id required');
    await this.roles.deleteRole({ projectId, actorUserId: actor, roleId: data.role_id });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role definition removed
    return { ok: true };
  }

  @GrpcMethod('RoleGrpc', 'CloneRole')
  async cloneRole(data: {
    project_id?: string;
    actor_user_id?: string;
    role_id?: string;
    name?: string;
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.role_id) throw new AppError('invalid', 'role_id required');
    const role = await this.roles.cloneRole({
      projectId,
      actorUserId: actor,
      roleId: data.role_id,
      name: data.name ?? '',
    });
    return this.mapRoleMsg(role);
  }

  @GrpcMethod('RoleGrpc', 'ListRoleAssignments')
  async listRoleAssignments(data: {
    project_id?: string;
    subject_id?: string;
    subject_type?: string;
  }) {
    const projectId = data.project_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const list = await this.roles.listAssignments({
      projectId,
      subjectId: data.subject_id || undefined,
      subjectType: data.subject_type || undefined,
    });
    return { list: list.map((a) => this.mapAssignmentMsg(a)) };
  }

  @GrpcMethod('RoleGrpc', 'GrantRole')
  async grantRole(data: {
    project_id?: string;
    actor_user_id?: string;
    subject_type?: string;
    subject_id?: string;
    role_id?: string;
    scope?: string;
    expires_at?: string;
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.role_id) throw new AppError('invalid', 'role_id required');
    const subjectType =
      data.subject_type === 'department'
        ? 'department'
        : data.subject_type === 'unit'
          ? 'unit'
          : 'user';
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
    const a = await this.roles.grantRole({
      projectId,
      actorUserId: actor,
      subjectType,
      subjectId: data.subject_id ?? '',
      roleId: data.role_id,
      scope: data.scope || 'project',
      expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
    });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role granted to subject
    return this.mapAssignmentMsg(a);
  }

  @GrpcMethod('RoleGrpc', 'RevokeRole')
  async revokeRole(data: { project_id?: string; actor_user_id?: string; assignment_id?: string }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.assignment_id) throw new AppError('invalid', 'assignment_id required');
    await this.roles.revokeRole({
      projectId,
      actorUserId: actor,
      assignmentId: data.assignment_id,
    });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): role assignment revoked
    return { ok: true };
  }

  @GrpcMethod('RoleGrpc', 'ResolveEffectivePermissions')
  async resolveEffectivePermissions(data: { project_id?: string; user_id?: string }) {
    const projectId = data.project_id ?? '';
    const userId = data.user_id ?? '';
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const r = await this.roles.resolveEffective(projectId, userId);
    return {
      allow: r.allow,
      deny: r.deny,
      role: r.role,
      sources: Object.entries(r.sources).map(([key, source]) => ({ key, source })),
    };
  }

  @GrpcMethod('RoleGrpc', 'SimulateAccess')
  async simulateAccess(data: {
    project_id?: string;
    user_id?: string;
    subject?: string;
    action?: string;
  }) {
    const projectId = data.project_id ?? '';
    const userId = data.user_id ?? '';
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const r = await this.roles.simulate({
      projectId,
      userId,
      subject: data.subject ?? '',
      action: data.action ?? '',
    });
    return {
      decision: r.decision,
      reason: r.reason,
      matched_keys: r.matchedKeys,
      role: r.role,
    };
  }

  /**
   * TODO-027 (PEP↔PDP): the gateway's enforcement decision. Same `decideRbac`
   * engine as `SimulateAccess`/`SimulateAccessExplain`, batched and stamped with
   * the project access epoch so the PEP can cache under the existing K3
   * invalidation. Invalid input throws (AppError → gRPC error → the PEP denies).
   */
  @GrpcMethod('RoleGrpc', 'CheckPermissions')
  async checkPermissions(data: {
    project_id?: string;
    projectId?: string;
    user_id?: string;
    userId?: string;
    checks?: Array<{ subject?: string; action?: string }>;
  }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    const checks = (Array.isArray(data.checks) ? data.checks : []).map((c) => ({
      subject: c?.subject ?? '',
      action: c?.action ?? '',
    }));
    const r = await this.pdp.checkPermissions({ projectId, userId, checks });
    return {
      decisions: r.decisions.map((d) => ({
        subject: d.subject,
        action: d.action,
        decision: d.decision,
        reason: d.reason,
        matched_keys: d.matchedKeys,
        not_applicable: d.notApplicable,
      })),
      role: r.role,
      epoch: r.epoch,
    };
  }

  // K3fe-be (E2-09): PDP explain on the production path. The same layer pipeline
  // as enforcement (RBAC→ABAC→visibility→sharing) in explain mode (FR-ABAC-19).
  @GrpcMethod('RoleGrpc', 'SimulateAccessExplain')
  async simulateAccessExplain(data: {
    project_id?: string;
    user_id?: string;
    subject?: string;
    action?: string;
    resource?: string;
    record_id?: string;
  }) {
    const projectId = data.project_id ?? '';
    const userId = data.user_id ?? '';
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const r = await this.pdp.simulateExplain({
      projectId,
      userId,
      subject: data.subject ?? '',
      action: data.action ?? '',
      resource: data.resource ?? '',
      recordId: data.record_id ?? '',
    });
    return {
      decision: r.decision,
      reason: r.reason,
      role: r.role,
      trace: r.trace.map((s) => ({
        layer: s.layer,
        effect: s.effect,
        rule_id: s.ruleId ?? '',
        reason: s.reason,
        inactive: s.inactive ?? false,
      })),
    };
  }

  // K3fe-be (API-2): PermissionProjection for the current (user, project).
  @GrpcMethod('RoleGrpc', 'ResolvePermissionProjection')
  async resolvePermissionProjection(data: { project_id?: string; user_id?: string }) {
    const projectId = data.project_id ?? '';
    const userId = data.user_id ?? '';
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const p = await this.pdp.resolveProjection(projectId, userId);
    return {
      project_id: p.projectId,
      allowed: p.allowed,
      module_policy_flags: Object.entries(p.modulePolicyFlags).map(([moduleId, flags]) => ({
        module_id: moduleId,
        flags,
      })),
      visibility_scope: {
        mode: p.visibilityScope.mode,
        level: p.visibilityScope.level,
        self_id: p.visibilityScope.selfId,
        department_ids: p.visibilityScope.departmentIds,
      },
      epoch: p.epoch,
    };
  }

  @GrpcMethod('RoleGrpc', 'ListRoleAuditLog')
  async listRoleAuditLog(data: {
    project_id?: string;
    limit?: number;
    cursor?: string;
    filter_actor_user_id?: string;
    filter_entity_type?: string;
    filter_entity_id?: string;
    from_ts?: string;
    to_ts?: string;
  }) {
    const projectId = data.project_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const fromTs = (data.from_ts ?? '').trim();
    const toTs = (data.to_ts ?? '').trim();
    const { list, nextCursor } = await this.roles.listAuditLog({
      projectId,
      limit: data.limit,
      cursor: data.cursor,
      filterActorUserId: data.filter_actor_user_id,
      filterEntityType: data.filter_entity_type,
      filterEntityId: data.filter_entity_id,
      fromTs: fromTs ? new Date(fromTs) : undefined,
      toTs: toTs ? new Date(toTs) : undefined,
    });
    return {
      list: list.map((e) => ({
        id: e.id,
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId ?? '',
        summary: e.summary ?? '',
        actor_user_id: e.actorUserId ?? '',
        created_at: e.createdAt,
      })),
      next_cursor: nextCursor,
    };
  }

  // ── BX-ACL-BE-4: PermissionGrant write-API ─────────────────────────────────

  @GrpcMethod('RoleGrpc', 'ListPermissionGrants')
  async listPermissionGrants(data: { project_id?: string }) {
    const projectId = data.project_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const list = await this.roles.listGrants(projectId);
    return { list: list.map((g) => this.mapGrantMsg(g)) };
  }

  @GrpcMethod('RoleGrpc', 'UpsertPermissionGrant')
  async upsertPermissionGrant(data: {
    project_id?: string;
    actor_user_id?: string;
    effect?: string;
    subject?: string;
    action?: string;
    grantee_type?: string;
    grantee_id?: string;
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    const g = await this.roles.upsertGrant({
      projectId,
      actorUserId: actor,
      effect: data.effect ?? '',
      subject: data.subject ?? '',
      action: data.action ?? '',
      granteeType: data.grantee_type ?? '',
      granteeId: data.grantee_id ?? '',
    });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): grant overlay changed
    return this.mapGrantMsg(g);
  }

  @GrpcMethod('RoleGrpc', 'RevokePermissionGrant')
  async revokePermissionGrant(data: {
    project_id?: string;
    actor_user_id?: string;
    grant_id?: string;
  }) {
    const projectId = data.project_id ?? '';
    const actor = data.actor_user_id ?? '';
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'actor_user_id required');
    if (!data.grant_id) throw new AppError('invalid', 'grant_id required');
    await this.roles.deleteGrant({ projectId, actorUserId: actor, grantId: data.grant_id });
    await this.accessEpoch.bump(projectId); // K3 (Д-4): grant overlay revoked
    return { ok: true };
  }

  private mapGrantMsg(g: {
    id: string;
    projectId: string;
    moduleId: string;
    effect: string;
    subject: string;
    action: string;
    resource: string;
    granteeType: string | null;
    granteeId: string | null;
    createdBy: string;
    createdAt: string;
  }) {
    return {
      id: g.id,
      project_id: g.projectId,
      module_id: g.moduleId,
      effect: g.effect,
      subject: g.subject,
      action: g.action,
      resource: g.resource,
      grantee_type: g.granteeType ?? '',
      grantee_id: g.granteeId ?? '',
      created_by: g.createdBy,
      created_at: g.createdAt,
    };
  }

  private mapOrganization(
    org: {
      id: string;
      name: string;
      slug: string;
      inn?: string | null;
      kpp?: string | null;
      ogrn?: string | null;
      legalAddress?: string | null;
      actualAddress?: string | null;
      phone?: string | null;
      email?: string | null;
      logoUrl?: string | null;
      description?: string | null;
    },
    role = '',
  ) {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role,
      inn: org.inn ?? '',
      kpp: org.kpp ?? '',
      ogrn: org.ogrn ?? '',
      legal_address: org.legalAddress ?? '',
      actual_address: org.actualAddress ?? '',
      phone: org.phone ?? '',
      email: org.email ?? '',
      logo_url: org.logoUrl ?? '',
      description: org.description ?? '',
    };
  }

  @GrpcMethod('OrganizationGrpc', 'HasSystem')
  async hasSystem() {
    const exists = await this.organizations.hasSystem();
    return { exists };
  }

  @GrpcMethod('OrganizationGrpc', 'CreateOrganization')
  async createOrganization(data: {
    name?: string;
    slug?: string;
    user_id?: string;
    userId?: string;
    inn?: string;
    kpp?: string;
    ogrn?: string;
    legal_address?: string;
    legalAddress?: string;
    actual_address?: string;
    actualAddress?: string;
    phone?: string;
    email?: string;
    logo_url?: string;
    logoUrl?: string;
    description?: string;
  }) {
    const name = data.name ?? '';
    const userId = data.user_id ?? data.userId ?? '';
    if (!name || !userId) throw new Error('name and user_id required');
    const { org, role } = await this.organizations.create({
      name,
      slug: data.slug,
      userId,
      inn: data.inn,
      kpp: data.kpp,
      ogrn: data.ogrn,
      legalAddress: data.legal_address ?? data.legalAddress,
      actualAddress: data.actual_address ?? data.actualAddress,
      phone: data.phone,
      email: data.email,
      logoUrl: data.logo_url ?? data.logoUrl,
      description: data.description,
    });
    return this.mapOrganization(org, role);
  }

  @GrpcMethod('OrganizationGrpc', 'GetOrganization')
  async getOrganization(
    data: { id?: string; user_id?: string; userId?: string },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const actor = resolveActorUserId(metadata, data.user_id ?? data.userId);
    const { org, role } = await this.organizations.get(id, actor);
    return this.mapOrganization(org, role);
  }

  @GrpcMethod('OrganizationGrpc', 'UpdateOrganization')
  async updateOrganization(
    data: {
      id?: string;
      name?: string;
      inn?: string;
      kpp?: string;
      ogrn?: string;
      legal_address?: string;
      legalAddress?: string;
      actual_address?: string;
      actualAddress?: string;
      phone?: string;
      email?: string;
      logo_url?: string;
      logoUrl?: string;
      description?: string;
      actor_user_id?: string;
      actorUserId?: string;
    },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const { org } = await this.organizations.update(
      id,
      {
        name: data.name,
        inn: data.inn,
        kpp: data.kpp,
        ogrn: data.ogrn,
        legalAddress: data.legal_address ?? data.legalAddress,
        actualAddress: data.actual_address ?? data.actualAddress,
        phone: data.phone,
        email: data.email,
        logoUrl: data.logo_url ?? data.logoUrl,
        description: data.description,
      },
      resolveActorUserId(metadata, data.actor_user_id ?? data.actorUserId),
    );
    return this.mapOrganization(org);
  }

  @GrpcMethod('OrganizationGrpc', 'ListMyOrganizations')
  async listMyOrganizations(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    // W0: subject is the JWT-propagated x-user-id, never a client query param
    // (closes IDOR — "?userId=other" leaking foreign orgs + roles).
    const userId = resolveActorUserId(metadata, data.user_id ?? data.userId);
    if (!userId) return { list: [] };
    const list = await this.organizations.listMy(userId);
    return {
      list: list.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
      })),
    };
  }

  private mapEmployee(e: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    departmentId?: string | null;
    isActive?: boolean | null;
    createdAt?: Date | string | null;
  }) {
    return {
      id: e.id,
      organization_id: e.organizationId,
      user_id: e.userId,
      role: e.role,
      department_id: e.departmentId ?? '',
      is_active: e.isActive ?? true,
      created_at: toIso(e.createdAt),
    };
  }

  private mapDepartment(d: {
    id: string;
    organizationId: string;
    name: string;
    parentId?: string | null;
    leaderUserId?: string | null;
    createdAt?: Date | string | null;
  }) {
    return {
      id: d.id,
      organization_id: d.organizationId,
      name: d.name,
      parent_id: d.parentId ?? '',
      leader_user_id: d.leaderUserId ?? '',
      created_at: toIso(d.createdAt),
    };
  }

  @GrpcMethod('OrganizationGrpc', 'ListEmployees')
  async listEmployees(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: resolve the system singleton; the client-supplied
    // organization_id is untrusted and ignored (box is single-tenant).
    const orgId = await this.organizations.resolveSystemAnchorId();
    const list = await this.structure.listEmployees(
      orgId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return { list: list.map((e) => this.mapEmployee(e)) };
  }

  @GrpcMethod('OrganizationGrpc', 'ListColleagueDirectory')
  async listColleagueDirectory(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    const orgId = await this.organizations.resolveSystemAnchorId();
    const list = await this.structure.listColleagueDirectory(
      orgId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return {
      list: list.map((e) => ({
        user_id: e.userId,
        department_id: e.departmentId,
        department_name: e.departmentName,
        manager_user_id: e.managerUserId,
      })),
    };
  }

  @GrpcMethod('OrganizationGrpc', 'AddEmployee')
  async addEmployee(
    data: {
      organization_id?: string;
      user_id?: string;
      role?: string;
      department_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) throw new Error('user_id required');
    const employee = await this.structure.addEmployee(
      orgId,
      userId,
      data.role,
      data.department_id || undefined,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapEmployee(employee);
  }

  @GrpcMethod('OrganizationGrpc', 'UpdateEmployee')
  async updateEmployee(
    data: {
      organization_id?: string;
      user_id?: string;
      role?: string;
      department_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) throw new Error('user_id required');
    const employee = await this.structure.updateEmployee(
      orgId,
      userId,
      { role: data.role, departmentId: data.department_id },
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapEmployee(employee);
  }

  @GrpcMethod('OrganizationGrpc', 'RemoveEmployee')
  async removeEmployee(
    data: {
      organization_id?: string;
      user_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) throw new Error('user_id required');
    return this.structure.removeEmployee(
      orgId,
      userId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
  }

  @GrpcMethod('OrganizationGrpc', 'DeactivateEmployee')
  async deactivateEmployee(
    data: {
      organization_id?: string;
      user_id?: string;
      actor_user_id?: string;
      reassign_to_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) throw new AppError('invalid', 'user_id required');
    const employee = await this.structure.deactivateEmployee(
      orgId,
      userId,
      resolveActorUserId(metadata, data.actor_user_id),
      data.reassign_to_user_id ?? '',
    );
    return this.mapEmployee(employee);
  }

  @GrpcMethod('OrganizationGrpc', 'ReactivateEmployee')
  async reactivateEmployee(
    data: { organization_id?: string; user_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) throw new AppError('invalid', 'user_id required');
    const employee = await this.structure.reactivateEmployee(
      orgId,
      userId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapEmployee(employee);
  }

  @GrpcMethod('OrganizationGrpc', 'TransferOwnership')
  async transferOwnership(
    data: { organization_id?: string; new_owner_user_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const newOwnerUserId = data.new_owner_user_id ?? '';
    if (!newOwnerUserId) {
      throw new AppError('invalid', 'new_owner_user_id required');
    }
    const employee = await this.structure.transferOwnership(
      orgId,
      newOwnerUserId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapEmployee(employee);
  }

  @GrpcMethod('OrganizationGrpc', 'GetOrgSeats')
  async getOrgSeats(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    // Membership (read) gate: seats are visible to any member (FR-MORG-35).
    await this.structure.assertOrgMember(orgId, resolveActorUserId(metadata, data.actor_user_id));
    const s = await this.seats.getSeats(orgId);
    return { used: s.used, total: s.total, over_limit: s.overLimit, plan: s.plan };
  }

  @GrpcMethod('OrganizationGrpc', 'GetOrgRole')
  async getOrgRole(
    data: { organization_id?: string; user_id?: string; userId?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    // Thin membership/role lookup for the gateway OrgAccessGuard (P8-T3.1).
    // getRole does NOT throw on non-membership → empty role, is_member=false.
    const r = await this.structure.getRole(
      orgId,
      resolveActorUserId(metadata, data.user_id ?? data.userId),
    );
    return { role: r.role, is_member: r.isMember, is_active: r.isActive };
  }

  @GrpcMethod('OrganizationGrpc', 'GetOrgPermissionProjection')
  async getOrgPermissionProjection(
    data: { organization_id?: string; user_id?: string; userId?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    // Thin projection for the FE gating (P8-T4.3). allowed = PDP allow-set; the
    // system org roles are lazily seeded inside resolveOrgEffective's caller path,
    // but the allow-set floor is a pure expansion (no DB row needed), so a
    // non-member yields an empty set (fail-closed) without side effects.
    const userId = resolveActorUserId(metadata, data.user_id ?? data.userId);
    const { allow, orgRole, isMember } = await this.orgPdp.resolveOrgEffective(orgId, userId);
    return { allowed: allow, org_role: orgRole, is_member: isMember };
  }

  @GrpcMethod('OrganizationGrpc', 'DeactivateOrganization')
  async deactivateOrganization(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const { org } = await this.organizations.setActive(
      orgId,
      false,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapOrganization(org);
  }

  @GrpcMethod('OrganizationGrpc', 'ReactivateOrganization')
  async reactivateOrganization(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const { org } = await this.organizations.setActive(
      orgId,
      true,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapOrganization(org);
  }

  @GrpcMethod('OrganizationGrpc', 'PreviewReorg')
  async previewReorg(
    data: {
      organization_id?: string;
      department_id?: string;
      target_parent_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = data.department_id ?? '';
    if (!deptId) {
      throw new AppError('invalid', 'department_id required');
    }
    const r = await this.structure.previewReorg(
      orgId,
      deptId,
      data.target_parent_id || null,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return {
      organization_id: r.organizationId,
      department_id: r.departmentId,
      department_name: r.departmentName,
      current_parent_id: r.currentParentId,
      target_parent_id: r.targetParentId,
      affected_department_count: r.affectedDepartmentCount,
      affected_department_ids: r.affectedDepartmentIds,
      affected_employee_count: r.affectedEmployeeCount,
      valid: r.valid,
      issues: r.issues,
    };
  }

  @GrpcMethod('OrganizationGrpc', 'GetMyMembership')
  async getMyMembership(
    data: { organization_id?: string; user_id?: string; userId?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    // Self-scoped: the subject is always the gateway-verified x-user-id.
    const m = await this.structure.getMyMembership(
      orgId,
      resolveActorUserId(metadata, data.user_id ?? data.userId),
    );
    return {
      is_member: m.isMember,
      user_id: m.userId,
      role: m.role,
      is_active: m.isActive,
      department_id: m.departmentId,
      department_name: m.departmentName,
      leader_user_id: m.leaderUserId,
      projects: m.projects.map((p) => ({
        project_id: p.projectId,
        project_name: p.projectName,
      })),
    };
  }

  @GrpcMethod('OrganizationGrpc', 'PreviewOffboard')
  async previewOffboard(
    data: { organization_id?: string; user_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const userId = data.user_id ?? '';
    if (!userId) {
      throw new AppError('invalid', 'user_id required');
    }
    const r = await this.structure.previewOffboard(
      orgId,
      userId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return {
      user_id: r.userId,
      is_owner: r.isOwner,
      projects: r.projects.map((p) => ({
        project_id: p.projectId,
        project_name: p.projectName,
      })),
      partial: r.partial,
    };
  }

  @GrpcMethod('OrganizationGrpc', 'ListDepartments')
  async listDepartments(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const list = await this.structure.listDepartments(
      orgId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return { list: list.map((d) => this.mapDepartment(d)) };
  }

  @GrpcMethod('OrganizationGrpc', 'CreateDepartment')
  async createDepartment(
    data: {
      organization_id?: string;
      name?: string;
      parent_id?: string;
      actor_user_id?: string;
      leader_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const dept = await this.structure.createDepartment(
      orgId,
      data.name ?? '',
      data.parent_id || undefined,
      resolveActorUserId(metadata, data.actor_user_id),
      data.leader_user_id || undefined,
    );
    return this.mapDepartment(dept);
  }

  @GrpcMethod('OrganizationGrpc', 'UpdateDepartment')
  async updateDepartment(
    data: {
      id?: string;
      name?: string;
      parent_id?: string;
      actor_user_id?: string;
      leader_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const dept = await this.structure.updateDepartment(
      id,
      { name: data.name, parentId: data.parent_id, leaderUserId: data.leader_user_id },
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapDepartment(dept);
  }

  @GrpcMethod('OrganizationGrpc', 'DeleteDepartment')
  async deleteDepartment(
    data: { id?: string; actor_user_id?: string; strategy?: string },
    metadata?: Metadata,
  ) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    return this.structure.deleteDepartment(
      id,
      resolveActorUserId(metadata, data.actor_user_id),
      data.strategy,
    );
  }

  // ─── Department→project bindings (FR-MORG-7/8/9/10/11) ────────────────────

  private mapBinding(b: {
    id: string;
    organizationId: string;
    departmentId: string;
    projectId: string;
    projectName?: string;
    defaultRole: string;
    scope: string;
    status: string;
    createdBy?: string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  }) {
    return {
      id: b.id,
      organization_id: b.organizationId,
      department_id: b.departmentId,
      project_id: b.projectId,
      project_name: b.projectName ?? '',
      default_role: b.defaultRole,
      scope: b.scope,
      status: b.status,
      created_by: b.createdBy ?? '',
      created_at: toIso(b.createdAt),
      updated_at: toIso(b.updatedAt),
    };
  }

  @GrpcMethod('OrganizationGrpc', 'ListDepartmentBindings')
  async listDepartmentBindings(
    data: { organization_id?: string; department_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = data.department_id ?? '';
    if (!deptId) throw new Error('department_id required');
    const list = await this.departmentBindings.list(
      orgId,
      deptId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return { list: list.map((b) => this.mapBinding(b)) };
  }

  @GrpcMethod('OrganizationGrpc', 'CreateDepartmentBinding')
  async createDepartmentBinding(
    data: {
      organization_id?: string;
      department_id?: string;
      project_id?: string;
      default_role?: string;
      scope?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = data.department_id ?? '';
    if (!deptId) throw new Error('department_id required');
    const binding = await this.departmentBindings.create(
      orgId,
      deptId,
      {
        projectId: data.project_id ?? '',
        defaultRole: data.default_role ?? '',
        scope: data.scope || undefined,
      },
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapBinding(binding);
  }

  @GrpcMethod('OrganizationGrpc', 'UpdateDepartmentBinding')
  async updateDepartmentBinding(
    data: {
      organization_id?: string;
      department_id?: string;
      id?: string;
      default_role?: string;
      scope?: string;
      status?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = data.department_id ?? '';
    const id = data.id ?? '';
    if (!deptId) throw new Error('department_id required');
    if (!id) throw new Error('id required');
    // Empty string over the wire = field not provided → leave unchanged.
    const binding = await this.departmentBindings.update(
      orgId,
      deptId,
      id,
      {
        defaultRole: data.default_role ? data.default_role : undefined,
        scope: data.scope ? data.scope : undefined,
        status: data.status ? data.status : undefined,
      },
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapBinding(binding);
  }

  @GrpcMethod('OrganizationGrpc', 'DeleteDepartmentBinding')
  async deleteDepartmentBinding(
    data: { organization_id?: string; department_id?: string; id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = data.department_id ?? '';
    const id = data.id ?? '';
    if (!deptId) throw new Error('department_id required');
    if (!id) throw new Error('id required');
    return this.departmentBindings.remove(
      orgId,
      deptId,
      id,
      resolveActorUserId(metadata, data.actor_user_id),
    );
  }

  // ─── Invitations ──────────────────────────────────────────────────────────

  /** Map stored `projectGrants` JSON → proto `ProjectGrant[]` (FR-ONB-10). */
  private mapProjectGrants(raw: unknown): { project_id: string; role: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((g) => ({
        project_id: String((g as { projectId?: string })?.projectId ?? '').trim(),
        role: String((g as { role?: string })?.role ?? '').trim(),
      }))
      .filter((g) => g.project_id);
  }

  private mapInvitation(i: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    departmentId?: string | null;
    status: string;
    invitedByUserId: string;
    acceptedUserId?: string | null;
    token: string;
    emailToken?: string;
    projectGrants?: unknown;
    createdAt?: Date | string | null;
    expiresAt?: Date | string | null;
  }) {
    return {
      id: i.id,
      organization_id: i.organizationId,
      email: i.email,
      role: i.role,
      department_id: i.departmentId ?? '',
      status: i.status,
      invited_by_user_id: i.invitedByUserId,
      accepted_user_id: i.acceptedUserId ?? '',
      created_at: toIso(i.createdAt),
      expires_at: toIso(i.expiresAt),
      token: i.emailToken ?? i.token,
      project_grants: this.mapProjectGrants(i.projectGrants),
    };
  }

  /**
   * W0 (SEC-BLOCKER): list/revoke responses MUST NOT carry the invitation
   * `token` — it is a bearer secret (whoever holds it can join the org via
   * AcceptInvitation). The token is server-side only, returned by control just
   * once to create/resend so the gateway can hand it to notification for the
   * email. This mapper drops it for read-shaped responses (no secret in lists).
   */
  private mapInvitationNoToken(i: Parameters<ControlGrpcController['mapInvitation']>[0]) {
    const { token: _token, ...rest } = this.mapInvitation(i);
    void _token;
    return rest;
  }

  @GrpcMethod('OrganizationGrpc', 'CreateInvitation')
  async createInvitation(
    data: {
      organization_id?: string;
      email?: string;
      role?: string;
      department_id?: string;
      invited_by_user_id?: string;
      actor_user_id?: string;
      project_grants?: { project_id?: string; role?: string }[];
    },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    // proto ProjectGrant[] (snake_case) → service shape (camelCase).
    const grants = (data.project_grants ?? []).map((g) => ({
      projectId: g.project_id ?? '',
      role: g.role ?? '',
    }));
    const invitation = await this.invitations.create(
      orgId,
      data.email ?? '',
      data.role,
      data.department_id || undefined,
      data.invited_by_user_id ?? actor,
      actor,
      grants,
    );
    // token kept here only for notification (email) — never surfaced to the client.
    return this.mapInvitation(invitation);
  }

  @GrpcMethod('OrganizationGrpc', 'ListInvitations')
  async listInvitations(
    data: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) {
    // DEORG-BE-16: system singleton; client organization_id ignored.
    const orgId = await this.organizations.resolveSystemAnchorId();
    const list = await this.invitations.list(
      orgId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    // W0: strip the bearer token from list rows (it must not leak to any client).
    return { list: list.map((i) => this.mapInvitationNoToken(i)) };
  }

  @GrpcMethod('OrganizationGrpc', 'RevokeInvitation')
  async revokeInvitation(data: { id?: string; actor_user_id?: string }, metadata?: Metadata) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const invitation = await this.invitations.revoke(
      id,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    // W0: a revoked invite never needs its token returned.
    return this.mapInvitationNoToken(invitation);
  }

  @GrpcMethod('OrganizationGrpc', 'ResendInvitation')
  async resendInvitation(data: { id?: string; actor_user_id?: string }, metadata?: Metadata) {
    const id = data.id ?? '';
    if (!id) throw new Error('id required');
    const invitation = await this.invitations.resend(
      id,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return this.mapInvitation(invitation);
  }

  @GrpcMethod('OrganizationGrpc', 'GetInvitation')
  async getInvitation(data: { token?: string }) {
    const token = data.token ?? '';
    if (!token) throw new Error('token required');
    const i = await this.invitations.getByToken(token);
    const expired = i.expiresAt.getTime() < Date.now();
    return {
      id: i.id,
      organization_id: i.organizationId,
      organization_name: i.organization?.name ?? '',
      email: i.email,
      role: i.role,
      status: i.status,
      expired,
      expires_at: toIso(i.expiresAt),
      project_grants: this.mapProjectGrants(i.projectGrants),
    };
  }

  @GrpcMethod('OrganizationGrpc', 'AcceptInvitation')
  async acceptInvitation(data: { token?: string; user_id?: string }) {
    const token = data.token ?? '';
    const userId = data.user_id ?? '';
    if (!token || !userId) throw new Error('token and user_id required');
    const r = await this.invitations.accept(token, userId);
    return {
      organization_id: r.organizationId,
      user_id: r.userId,
      // FR-ONB-10: granted projects → gateway lands user on /p/<projectId>.
      project_grants: (r.projectGrants ?? []).map((g) => ({
        project_id: g.projectId,
        role: g.role,
      })),
    };
  }

  // ─── Org audit ────────────────────────────────────────────────────────────

  @GrpcMethod('OrganizationGrpc', 'ListOrgAudit')
  async listOrgAudit(
    data: {
      organization_id?: string;
      actor_user_id?: string;
      limit?: number;
      cursor?: string;
      filter_entity_type?: string;
      filter_actor_user_id?: string;
      from_ts?: string;
      to_ts?: string;
    },
    metadata?: Metadata,
  ) {
    const orgId = await this.organizations.resolveSystemAnchorId();
    const fromTs = data.from_ts?.trim() ? new Date(data.from_ts) : undefined;
    const toTs = data.to_ts?.trim() ? new Date(data.to_ts) : undefined;
    const { list, nextCursor } = await this.orgAudit.list(
      orgId,
      resolveActorUserId(metadata, data.actor_user_id),
      {
        limit: data.limit || 100,
        cursor: data.cursor,
        filterEntityType: data.filter_entity_type,
        filterActorUserId: data.filter_actor_user_id,
        fromTs: fromTs && !Number.isNaN(fromTs.getTime()) ? fromTs : undefined,
        toTs: toTs && !Number.isNaN(toTs.getTime()) ? toTs : undefined,
      },
    );
    return {
      list: list.map((e) => ({
        id: e.id,
        organization_id: e.organizationId,
        actor_user_id: e.actorUserId ?? '',
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId ?? '',
        metadata_json: e.metadata != null ? JSON.stringify(e.metadata) : '',
        created_at: toIso(e.createdAt),
      })),
      next_cursor: nextCursor,
    };
  }

  @GrpcMethod('OrganizationGrpc', 'GetDepartmentSummary')
  async getDepartmentSummary(
    data: {
      organization_id?: string;
      department_id?: string;
      actor_user_id?: string;
    },
    metadata?: Metadata,
  ) {
    const orgId = await this.organizations.resolveSystemAnchorId();
    const deptId = (data.department_id ?? '').trim();
    if (!deptId) throw new Error('department_id required');
    const summary = await this.structure.getDepartmentSummary(
      orgId,
      deptId,
      resolveActorUserId(metadata, data.actor_user_id),
    );
    return {
      employee_count: summary.employeeCount,
      active_seats: summary.activeSeats,
      pending_invitations: summary.pendingInvitations,
      unassigned_records_count: summary.unassignedRecordsCount,
    };
  }

  // chat (M-CHAT-12, B-3): communication-boundary check for DM/group/@mention.
  // org/workspace boundary is taken from TRUSTED metadata (gateway-stamped),
  // falling back to the body only for s2s callers without metadata.
  @GrpcMethod('OrganizationGrpc', 'ResolveCommunicationScope')
  async resolveCommunicationScope(
    data: {
      actor_user_id?: string;
      peer_user_ids?: string[];
      organization_id?: string;
      workspace_id?: string;
      project_id?: string;
    },
    metadata?: Metadata,
  ) {
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const organizationId =
      readGatewayMetadata(metadata, GW_METADATA.ORGANIZATION_ID).trim() ||
      (data.organization_id ?? '').trim();
    const workspaceId =
      readGatewayMetadata(metadata, GW_METADATA.WORKSPACE_ID).trim() ||
      (data.workspace_id ?? '').trim();
    // Trusted project scope (x-project-id wins over body). The service derives the
    // org/workspace boundary from the project owner server-side — the client never
    // asserts which org a DM/group belongs to.
    const projectId = resolveProjectId(metadata, data.project_id);
    const r = await this.structure.resolveCommunicationScope({
      actorUserId,
      peerUserIds: Array.isArray(data.peer_user_ids) ? data.peer_user_ids : [],
      organizationId: organizationId || undefined,
      workspaceId: workspaceId || undefined,
      projectId: projectId || undefined,
    });
    return {
      allowed: r.allowed,
      scope_kind: r.scopeKind,
      scope_id: r.scopeId,
      denied_user_ids: r.deniedUserIds,
    };
  }

  // ─── E2-06 Access Unit / Group ─────────────────────────────────────────────

  private mapAccessUnit(u: {
    id: string;
    scopeType: string;
    scopeId: string;
    name: string;
    kind: string;
    parentId?: string | null;
    leaderUserId?: string | null;
    archivedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }) {
    return {
      id: u.id,
      scope_type: u.scopeType,
      scope_id: u.scopeId,
      name: u.name,
      kind: u.kind,
      parent_id: u.parentId ?? '',
      leader_user_id: u.leaderUserId ?? '',
      archived_at: toIso(u.archivedAt),
      created_at: toIso(u.createdAt),
    };
  }

  private mapAccessUnitMember(m: {
    id: string;
    unitId: string;
    memberType: string;
    memberId: string;
    addedBy?: string | null;
    addedAt?: Date | string | null;
  }) {
    return {
      id: m.id,
      unit_id: m.unitId,
      member_type: m.memberType,
      member_id: m.memberId,
      added_by: m.addedBy ?? '',
      added_at: toIso(m.addedAt),
    };
  }

  /**
   * K3 (Д-4 × E2-06): an access-unit structural/membership change invalidates the
   * permission cache. PROJECT-scope units affect just that project; ORGANIZATION-
   * scope units (groups shared across the org) affect every project under the org,
   * so bump them all. Best-effort — never breaks the underlying mutation.
   */
  private async bumpForUnitScope(scopeType: string, scopeId: string): Promise<void> {
    if (!scopeId) return;
    if (scopeType === 'PROJECT') {
      await this.accessEpoch.bump(scopeId);
    } else if (scopeType === 'ORGANIZATION') {
      await this.accessEpoch.bumpOrgProjects(scopeId);
    }
  }

  @GrpcMethod('AccessUnitGrpc', 'ListAccessUnits')
  async listAccessUnits(data: {
    scope_type?: string;
    scope_id?: string;
    actor_user_id?: string;
    include_archived?: boolean;
  }) {
    const list = await this.accessUnits.listUnits(
      data.scope_type ?? '',
      data.scope_id ?? '',
      data.actor_user_id,
      Boolean(data.include_archived),
    );
    return { list: list.map((u) => this.mapAccessUnit(u)) };
  }

  @GrpcMethod('AccessUnitGrpc', 'CreateAccessUnit')
  async createAccessUnit(data: {
    scope_type?: string;
    scope_id?: string;
    name?: string;
    kind?: string;
    parent_id?: string;
    leader_user_id?: string;
    actor_user_id?: string;
  }) {
    const unit = await this.accessUnits.createUnit(
      {
        scopeType: data.scope_type ?? '',
        scopeId: data.scope_id ?? '',
        name: data.name ?? '',
        kind: data.kind,
        parentId: data.parent_id || null,
        leaderUserId: data.leader_user_id || null,
      },
      data.actor_user_id,
    );
    await this.bumpForUnitScope(unit.scopeType, unit.scopeId); // K3 (Д-4): new group
    return this.mapAccessUnit(unit);
  }

  @GrpcMethod('AccessUnitGrpc', 'UpdateAccessUnit')
  async updateAccessUnit(data: {
    id?: string;
    name?: string;
    kind?: string;
    leader_user_id?: string;
    actor_user_id?: string;
  }) {
    if (!data.id) throw new AppError('invalid', 'id required');
    const unit = await this.accessUnits.updateUnit(
      data.id,
      {
        name: data.name,
        kind: data.kind,
        leaderUserId: data.leader_user_id,
      },
      data.actor_user_id,
    );
    // K3 (Д-4): leader change affects own_subgroups(roots=led) → invalidate.
    await this.bumpForUnitScope(unit.scopeType, unit.scopeId);
    return this.mapAccessUnit(unit);
  }

  @GrpcMethod('AccessUnitGrpc', 'SetUnitParent')
  async setUnitParent(data: { id?: string; parent_id?: string; actor_user_id?: string }) {
    if (!data.id) throw new AppError('invalid', 'id required');
    const unit = await this.accessUnits.setUnitParent(
      data.id,
      data.parent_id || null,
      data.actor_user_id,
    );
    // K3 (Д-4): parent change moves own_subgroups subtree → invalidate.
    await this.bumpForUnitScope(unit.scopeType, unit.scopeId);
    return this.mapAccessUnit(unit);
  }

  @GrpcMethod('AccessUnitGrpc', 'ArchiveAccessUnit')
  async archiveAccessUnit(data: { id?: string; archived?: boolean; actor_user_id?: string }) {
    if (!data.id) throw new AppError('invalid', 'id required');
    const unit = await this.accessUnits.archiveUnit(
      data.id,
      data.archived ?? true,
      data.actor_user_id,
    );
    // K3 (Д-4): archiving a group removes its members from resolve → invalidate.
    await this.bumpForUnitScope(unit.scopeType, unit.scopeId);
    return this.mapAccessUnit(unit);
  }

  @GrpcMethod('AccessUnitGrpc', 'ListUnitMembers')
  async listUnitMembers(data: { unit_id?: string; actor_user_id?: string }) {
    if (!data.unit_id) throw new AppError('invalid', 'unit_id required');
    const list = await this.accessUnits.listMembers(data.unit_id, data.actor_user_id);
    return { list: list.map((m) => this.mapAccessUnitMember(m)) };
  }

  @GrpcMethod('AccessUnitGrpc', 'ListUnitsOfUser')
  async listUnitsOfUser(data: {
    scope_type?: string;
    scope_id?: string;
    user_id?: string;
    actor_user_id?: string;
  }) {
    const list = await this.accessUnits.listUnitsOfUser(
      data.scope_type ?? '',
      data.scope_id ?? '',
      data.user_id ?? '',
      data.actor_user_id,
    );
    return { list: list.map((u) => this.mapAccessUnit(u)) };
  }

  @GrpcMethod('AccessUnitGrpc', 'AddUnitMember')
  async addUnitMember(data: {
    unit_id?: string;
    member_type?: string;
    member_id?: string;
    actor_user_id?: string;
  }) {
    if (!data.unit_id) throw new AppError('invalid', 'unit_id required');
    const member = await this.accessUnits.addMember(
      data.unit_id,
      data.member_type ?? 'user',
      data.member_id ?? '',
      data.actor_user_id,
    );
    // K3 (Д-4): member/composition added → invalidate the scope's projects.
    const scope = await this.accessUnits.getUnitScope(data.unit_id);
    if (scope) await this.bumpForUnitScope(scope.scopeType, scope.scopeId);
    return this.mapAccessUnitMember(member);
  }

  @GrpcMethod('AccessUnitGrpc', 'RemoveUnitMember')
  async removeUnitMember(data: {
    unit_id?: string;
    member_type?: string;
    member_id?: string;
    actor_user_id?: string;
  }) {
    if (!data.unit_id) throw new AppError('invalid', 'unit_id required');
    const scope = await this.accessUnits.getUnitScope(data.unit_id);
    const result = await this.accessUnits.removeMember(
      data.unit_id,
      data.member_type ?? 'user',
      data.member_id ?? '',
      data.actor_user_id,
    );
    // K3 (Д-4): member/composition removed → invalidate the scope's projects.
    if (scope) await this.bumpForUnitScope(scope.scopeType, scope.scopeId);
    return result;
  }

  @GrpcMethod('AccessUnitGrpc', 'PreviewUnitComposition')
  async previewUnitComposition(data: {
    unit_id?: string;
    add_group_id?: string;
    actor_user_id?: string;
  }) {
    if (!data.unit_id) throw new AppError('invalid', 'unit_id required');
    const preview = await this.accessUnits.previewComposition({
      unitId: data.unit_id,
      addGroupId: data.add_group_id || undefined,
      actorUserId: data.actor_user_id,
    });
    return {
      current_user_count: preview.currentUserCount,
      projected_user_count: preview.projectedUserCount,
      added_user_count: preview.addedUserCount,
      cross_scope_dropped: preview.crossScopeDropped,
    };
  }

  // ─── Module lifecycle (R4-E1-05) ──────────────────────────────────────────

  private mapModuleState(e: {
    moduleId: string;
    state: string;
    enabled: boolean;
    installed: boolean;
    locked: boolean;
    kind: string;
    version: string;
    latestVersion: string;
    upgradeAvailable: boolean;
    runtimeStatus: 'active' | 'suspended';
    everSuspended: boolean;
    configState: 'ready' | 'needs_config';
  }) {
    return {
      module_id: e.moduleId,
      state: e.state,
      enabled: e.enabled,
      installed: e.installed,
      locked: e.locked,
      kind: e.kind,
      version: e.version,
      latest_version: e.latestVersion,
      upgrade_available: e.upgradeAvailable,
      runtime_status: e.runtimeStatus,
      ever_suspended: e.everSuspended,
      config_state: e.configState,
    };
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'ListModuleStates')
  async listModuleStates(data: { project_id?: string; projectId?: string }) {
    const projectId = data.project_id ?? data.projectId ?? '';
    if (!projectId) throw new Error('project_id required');
    const list = await this.lifecycle.listStates(projectId);
    return { list: list.map((e) => this.mapModuleState(e)) };
  }

  // TODO-085: lifecycle mutations persist through the now PEP-gated
  // `ProjectsService.update`, so they carry the trusted actor (gateway-verified
  // `x-user-id`, body `actor_user_id` only as an s2s fallback — same rule as
  // UpdateProject). An empty actor fails closed in the domain.
  @GrpcMethod('ModuleLifecycleControlGrpc', 'InstallModule')
  async installModule(
    data: {
      project_id?: string;
      module_id?: string;
      actor_user_id?: string;
      idempotency_key?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(await this.lifecycle.install(projectId, moduleId, actor, idem));
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'UninstallModule')
  async uninstallModule(
    data: {
      project_id?: string;
      module_id?: string;
      actor_user_id?: string;
      idempotency_key?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(await this.lifecycle.uninstall(projectId, moduleId, actor, idem));
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'EnableModule')
  async enableModule(
    data: {
      project_id?: string;
      module_id?: string;
      actor_user_id?: string;
      idempotency_key?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(await this.lifecycle.enable(projectId, moduleId, actor, idem));
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'DisableModule')
  async disableModule(
    data: {
      project_id?: string;
      module_id?: string;
      cascade?: boolean;
      actor_user_id?: string;
      idempotency_key?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(
      await this.lifecycle.disable(projectId, moduleId, Boolean(data.cascade), actor, idem),
    );
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'UpgradeModulePreview')
  async upgradeModulePreview(data: {
    project_id?: string;
    module_id?: string;
    to_version?: string;
  }) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const p = await this.lifecycle.upgradePreview(projectId, moduleId, data.to_version ?? '');
    return {
      module_id: p.moduleId,
      from_version: p.fromVersion,
      to_version: p.toVersion,
      upgrade_class: p.upgradeClass,
      requires_confirmation: p.requiresConfirmation,
      migration_required: p.migrationRequired,
      migrations: p.migrations.map((m) => ({
        from_major: m.fromMajor,
        to_major: m.toMajor,
        script_ref: m.scriptRef,
        reversible: Boolean(m.reversible),
      })),
    };
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'UpgradeModule')
  async upgradeModule(
    data: {
      project_id?: string;
      module_id?: string;
      to_version?: string;
      confirm_major?: boolean;
      actor_user_id?: string;
      idempotency_key?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(
      await this.lifecycle.upgrade(
        projectId,
        moduleId,
        data.to_version ?? '',
        Boolean(data.confirm_major),
        actor,
        idem,
      ),
    );
  }

  @GrpcMethod('ModuleLifecycleControlGrpc', 'ResumeModuleDelivery')
  async resumeModuleDelivery(
    data: {
      project_id?: string;
      module_id?: string;
      actor_user_id?: string;
      idempotency_key?: string;
      dlq?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = data.project_id ?? '';
    const moduleId = data.module_id ?? '';
    if (!projectId || !moduleId) throw new Error('project_id and module_id required');
    const dlq = data.dlq === 'deliver' ? 'deliver' : data.dlq === 'discard' ? 'discard' : '';
    if (!dlq) throw new AppError('invalid', 'dlq must be discard or deliver');
    const actor = resolveActorUserId(metadata, data.actor_user_id);
    const idem = resolveIdempotencyKey(metadata, data.idempotency_key);
    return this.mapModuleState(
      await this.lifecycle.resumeDelivery(projectId, moduleId, dlq, actor, idem),
    );
  }

  // ─── F3-integ-be (U8/U4): project integrations + per-project API keys ───────
  // Isolation: project_id from trusted x-project-id (rejects body/metadata
  // mismatch). PEP: the service requires project `manage` for every mutation and
  // fail-closes on an empty actor. Secrets never echoed — only masked / one-time.

  private mapIntegration(v: IntegrationView) {
    return {
      id: v.id,
      project_id: v.projectId,
      name: v.name,
      type: v.type,
      config: v.config ?? {},
      secret_set: v.secretSet,
      secret_masked: v.secretMasked,
      status: v.status,
      created_by: v.createdBy,
      created_at: toIso(v.createdAt),
      updated_at: toIso(v.updatedAt),
    };
  }

  private mapWebhookDelivery(v: WebhookDeliveryView) {
    return {
      id: v.id,
      project_id: v.projectId,
      integration_id: v.integrationId,
      event_type: v.eventType,
      url: v.url,
      http_code: v.httpCode ?? 0,
      status: v.status,
      attempts: v.attempts,
      error: v.error ?? '',
      created_at: toIso(v.createdAt),
    };
  }

  private mapApiKey(v: ApiKeyView) {
    return {
      id: v.id,
      project_id: v.projectId,
      name: v.name,
      prefix: v.prefix,
      key_masked: v.keyMasked,
      status: v.status,
      created_by: v.createdBy,
      created_at: toIso(v.createdAt),
      last_used_at: v.lastUsedAt ? toIso(v.lastUsedAt) : '',
      revoked_at: v.revokedAt ? toIso(v.revokedAt) : '',
    };
  }

  @GrpcMethod('IntegrationGrpc', 'ListIntegrations')
  async listIntegrations(data: { project_id?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const list = await this.integrations.listIntegrations(projectId);
    return { list: list.map((v) => this.mapIntegration(v)) };
  }

  @GrpcMethod('IntegrationGrpc', 'GetIntegration')
  async getIntegration(data: { project_id?: string; id?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const v = await this.integrations.getIntegration(projectId, data.id ?? '');
    return this.mapIntegration(v);
  }

  @GrpcMethod('IntegrationGrpc', 'CreateIntegration')
  async createIntegration(
    data: {
      project_id?: string;
      actor_user_id?: string;
      name?: string;
      type?: string;
      config?: Record<string, unknown>;
      secret?: string;
      status?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const v = await this.integrations.createIntegration({
      projectId,
      actorUserId,
      name: data.name ?? '',
      type: data.type ?? '',
      config: this.toJsonRecord(data.config),
      secret: data.secret ?? '',
      status: data.status,
    });
    return this.mapIntegration(v);
  }

  @GrpcMethod('IntegrationGrpc', 'UpdateIntegration')
  async updateIntegration(
    data: {
      project_id?: string;
      actor_user_id?: string;
      id?: string;
      name?: string;
      config?: Record<string, unknown>;
      secret?: string;
      set_secret?: boolean;
      status?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const v = await this.integrations.updateIntegration({
      projectId,
      actorUserId,
      id: data.id ?? '',
      name: data.name,
      config: data.config != null ? this.toJsonRecord(data.config) : undefined,
      secret: data.secret,
      setSecret: Boolean(data.set_secret),
      status: data.status || undefined,
    });
    return this.mapIntegration(v);
  }

  @GrpcMethod('IntegrationGrpc', 'DeleteIntegration')
  async deleteIntegration(
    data: { project_id?: string; actor_user_id?: string; id?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    return this.integrations.deleteIntegration({ projectId, actorUserId, id: data.id ?? '' });
  }

  @GrpcMethod('IntegrationGrpc', 'ListApiKeys')
  async listApiKeys(data: { project_id?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const list = await this.integrations.listApiKeys(projectId);
    return { list: list.map((v) => this.mapApiKey(v)) };
  }

  @GrpcMethod('IntegrationGrpc', 'CreateApiKey')
  async createApiKey(
    data: { project_id?: string; actor_user_id?: string; name?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    const r = await this.integrations.createApiKey({
      projectId,
      actorUserId,
      name: data.name ?? '',
    });
    // The plaintext is surfaced exactly once here for the gateway to relay to the
    // UI — it is never persisted and never returned by any list/get.
    return { key: this.mapApiKey(r.key), plaintext: r.plaintext };
  }

  @GrpcMethod('IntegrationGrpc', 'RevokeApiKey')
  async revokeApiKey(
    data: { project_id?: string; actor_user_id?: string; id?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const actorUserId = resolveActorUserId(metadata, data.actor_user_id);
    return this.integrations.revokeApiKey({ projectId, actorUserId, id: data.id ?? '' });
  }

  // Internal PDP for the public API: the gateway ProjectApiKeyGuard hashes the
  // presented `ffk_…` and calls this to resolve the owning project. No project
  // metadata here — this call IS the auth check; projectId comes from the key.
  @GrpcMethod('IntegrationGrpc', 'ValidateProjectApiKey')
  async validateProjectApiKey(data: { key_hash?: string }) {
    const r = await this.integrations.validateApiKey(data.key_hash ?? '');
    return {
      valid: r.valid,
      project_id: r.projectId,
      key_id: r.keyId,
      name: r.name,
      status: r.status,
    };
  }

  @GrpcMethod('IntegrationGrpc', 'ListWebhookDeliveries')
  async listWebhookDeliveries(
    data: { project_id?: string; integration_id?: string; limit?: number },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id);
    const list = await this.integrations.listWebhookDeliveries(
      projectId,
      data.integration_id ?? '',
      data.limit || undefined,
    );
    return { list: list.map((v) => this.mapWebhookDelivery(v)) };
  }
}
