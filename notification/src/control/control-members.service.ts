import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Metadata } from '@grpc/grpc-js';
import {
  buildServiceOutboundMetadata,
  serializeVisibilityScope,
  GW_METADATA,
} from '@fairflow/shared';

export const CONTROL_PROJECT_GRPC = 'CONTROL_PROJECT_GRPC';

/** A resolved project member (control `ProjectGrpc.ListMembers` row). */
export type ProjectMember = {
  /** userId (control returns the member's user id as `id`). */
  id: string;
  /** owner | admin | manager | member | viewer. */
  role: string;
};

/** One org-structure employee (control `OrganizationGrpc.ListEmployees` row). */
type OrgEmployee = {
  /** The employee's user id (snake_case field, keepCase loader). */
  user_id?: string;
  /** FR-MORG-23/43: false = offboarded — excluded from the deactivation fan-out. */
  is_active?: boolean;
  role?: string;
};

/** One org-structure department (control `OrganizationGrpc.ListDepartments` row). */
type OrgDepartment = {
  leader_user_id?: string;
};

/**
 * Fan-out role groups the notification matrix addresses (contract §5.1):
 *  - `pa`     → project owner + admin (PO/PA) — quota/grace, reassign, order-failed.
 *  - `leader` → project manager (руководитель) — order-failed, activity overdue.
 *  - `all`    → every active member — project archived.
 *
 * Full org-structure leadership (`OrganizationGrpc.leaderUserId`, FR-MNOT-31) is
 * UNIONed with the project-level `manager` role when resolving the `leader` group.
 */
export type FanoutGroup = 'pa' | 'leader' | 'all';

const ROLE_MATCHERS: Record<FanoutGroup, (role: string) => boolean> = {
  pa: (r) => r === 'owner' || r === 'admin',
  leader: (r) => r === 'manager',
  all: () => true,
};

type CacheEntry = { members: ProjectMember[]; exp: number };
type ModulesCacheEntry = { modules: string[]; exp: number };

/**
 * Resolves the active members (with roles) of a project via control
 * `ProjectGrpc.ListMembers`, for the consumer's project-wide fan-out
 * (FR-MNOT-4/31). This is the ONLY trusted source of addressees beyond the
 * payload owner/assignee (SEC-N-8): recipients are never taken from external
 * input, only from control + the source-domain payload.
 *
 * Resilience: results are cached ~30 s per project (NFR-MNOT-8) and every call is
 * fail-soft — control down / timeout / empty → returns [], so the consumer falls
 * back to the payload owner/assignee (the current behaviour) rather than dropping
 * the notification or blocking the queue.
 */
@Injectable()
export class ControlMembersService implements OnModuleInit {
  private readonly logger = new Logger(ControlMembersService.name);
  private projectGrpc!: {
    listMembers: (
      d: { project_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<{ list?: ProjectMember[] }>;
    getProject: (
      d: { id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<{
      owner_type?: string;
      ownerType?: string;
      owner_id?: string;
      ownerId?: string;
      effective_modules?: string[];
      effectiveModules?: string[];
    }>;
  };
  private orgGrpc!: {
    listEmployees: (
      d: { organization_id: string; actor_user_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<{ list?: OrgEmployee[] }>;
    listDepartments: (
      d: { organization_id: string; actor_user_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<{ list?: OrgDepartment[] }>;
  };
  private readonly cache = new Map<string, CacheEntry>();
  private readonly modulesCache = new Map<string, ModulesCacheEntry>();
  private readonly maxCacheSize = parseInt(process.env.CONTROL_MEMBERS_CACHE_MAX ?? '500', 10);
  private readonly ttlMs = parseInt(process.env.CONTROL_MEMBERS_CACHE_TTL_MS ?? '30000', 10);
  private readonly callTimeoutMs = parseInt(process.env.CONTROL_MEMBERS_TIMEOUT_MS ?? '3000', 10);

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.projectGrpc = this.client.getService('ProjectGrpc');
    this.orgGrpc = this.client.getService('OrganizationGrpc');
  }

  private serviceApiKey(): string {
    return (
      process.env.NOTIFICATION_SERVICE_API_KEY?.trim() ||
      process.env.GATEWAY_SERVICE_API_KEY?.trim() ||
      ''
    );
  }

  /**
   * s2s metadata for the control call: the service-API-key envelope PLUS a
   * fail-closed `x-visibility-scope` of mode `all`. ListMembers itself is not
   * visibility-gated, but a fail-closed control resolver returns empty/404 when
   * the header is absent; sending an explicit all-scope keeps the fan-out working
   * regardless of a domain-side hydration guard.
   */
  private metadata(): Metadata {
    const md = buildServiceOutboundMetadata({ serviceApiKey: this.serviceApiKey() });
    md.set(
      GW_METADATA.VISIBILITY_SCOPE,
      serializeVisibilityScope({
        mode: 'all',
        level: 'all',
        selfId: '',
        ownerIds: [],
        sharedRecordIds: [],
      }),
    );
    return md;
  }

  /**
   * All active members of a project (cached ~30 s).
   * `ok: false` means control was unreachable — callers must not trust payload-only
   * addressees (SEC-N-8 / FR-NOTIF-160). `ok: true` with `members: []` is a real
   * empty project.
   */
  async getMembersWithStatus(
    projectId: string,
  ): Promise<{ members: ProjectMember[]; ok: boolean }> {
    if (!projectId) return { members: [], ok: true };
    const now = Date.now();
    const hit = this.cache.get(projectId);
    if (hit && hit.exp > now) return { members: hit.members, ok: true };
    try {
      const res = await firstValueFrom(
        this.projectGrpc
          .listMembers({ project_id: projectId }, this.metadata())
          .pipe(timeout(this.callTimeoutMs)),
      );
      const members = (res?.list ?? [])
        .map((m) => ({ id: String(m.id ?? ''), role: String(m.role ?? '') }))
        .filter((m) => m.id);
      this.cacheSet(projectId, { members, exp: now + this.ttlMs });
      return { members, ok: true };
    } catch (err) {
      this.logger.warn(
        `control ListMembers(${projectId}) failed — payload addressees cannot be verified: ${String(err)}`,
      );
      return { members: [], ok: false };
    }
  }

  /** All active members of a project (cached ~30 s). Fail-soft → [] on any error. */
  async getMembers(projectId: string): Promise<ProjectMember[]> {
    const { members } = await this.getMembersWithStatus(projectId);
    return members;
  }

  /**
   * Effective modules enabled in a project (FR-NOTIF-240). Cached ~30 s.
   * `ok: false` when control is unreachable — callers must fail-closed.
   */
  async getEffectiveModulesWithStatus(
    projectId: string,
  ): Promise<{ modules: string[]; ok: boolean }> {
    if (!projectId) return { modules: [], ok: true };
    const now = Date.now();
    const hit = this.modulesCache.get(projectId);
    if (hit && hit.exp > now) return { modules: hit.modules, ok: true };
    try {
      const res = await firstValueFrom(
        this.projectGrpc.getProject({ id: projectId }, this.metadata()).pipe(timeout(this.callTimeoutMs)),
      );
      const modules = (res?.effective_modules ?? res?.effectiveModules ?? [])
        .map((m) => String(m))
        .filter(Boolean);
      this.modulesCacheSet(projectId, { modules, exp: now + this.ttlMs });
      return { modules, ok: true };
    } catch (err) {
      this.logger.warn(
        `control GetProject(${projectId}) failed — cannot verify effectiveModules: ${String(err)}`,
      );
      return { modules: [], ok: false };
    }
  }

  async getEffectiveModules(projectId: string): Promise<string[]> {
    const { modules } = await this.getEffectiveModulesWithStatus(projectId);
    return modules;
  }

  isModuleEnabled(modules: string[], moduleId: string): boolean {
    if (!moduleId) return true;
    // System modules (notifications, statistics) are always-on in box.
    if (moduleId === 'notifications' || moduleId === 'statistics') return true;
    return modules.includes(moduleId);
  }

  /**
   * Resolve the extra addressees (user-ids) for the requested fan-out groups.
   * `leader` = project `manager` role ∪ org-structure `leaderUserId` for members
   * (FR-MNOT-31 / FR-NOTIF-170). Returns [] when control is unavailable for the
   * member lookup path (caller keeps payload addressees).
   */
  async resolveFanout(projectId: string, groups: readonly FanoutGroup[]): Promise<string[]> {
    if (!projectId || groups.length === 0) return [];
    const members = await this.getMembers(projectId);
    if (members.length === 0) return [];
    const matchers = groups.map((g) => ROLE_MATCHERS[g]);
    const out = new Set<string>();
    for (const m of members) {
      if (matchers.some((match) => match(m.role))) out.add(m.id);
    }
    if (groups.includes('leader')) {
      for (const id of await this.resolveOrgStructureLeaders(projectId, members)) {
        out.add(id);
      }
    }
    return Array.from(out);
  }

  /**
   * Department leaders (`leaderUserId`) who are also active project members.
   * Fail-soft: transport errors → [] so fan-out degrades to the manager-role proxy.
   */
  private async resolveOrgStructureLeaders(
    projectId: string,
    members: ProjectMember[],
  ): Promise<string[]> {
    const memberIds = new Set(members.map((m) => m.id));
    const actorUserId =
      members.find((m) => m.role === 'owner')?.id ??
      members.find((m) => m.role === 'admin')?.id ??
      members[0]?.id ??
      '';
    if (!actorUserId) return [];
    try {
      const project = await firstValueFrom(
        this.projectGrpc.getProject({ id: projectId }, this.metadata()).pipe(timeout(this.callTimeoutMs)),
      );
      const ownerType = String(project?.owner_type ?? project?.ownerType ?? '').toUpperCase();
      const organizationId = String(project?.owner_id ?? project?.ownerId ?? '').trim();
      if (ownerType !== 'ORGANIZATION' || !organizationId) return [];
      const res = await firstValueFrom(
        this.orgGrpc
          .listDepartments(
            { organization_id: organizationId, actor_user_id: actorUserId },
            this.metadata(),
          )
          .pipe(timeout(this.callTimeoutMs)),
      );
      return Array.from(
        new Set(
          (res?.list ?? [])
            .map((d) => String(d?.leader_user_id ?? '').trim())
            .filter((id) => id && memberIds.has(id)),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `control ListDepartments for project ${projectId} failed — leader fan-out falls back to manager role: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * Active employees (user-ids) of an organization via control
   * `OrganizationGrpc.ListEmployees` (FR-MORG). Used for the org-wide fan-out of
   * `control.org.deactivated`: those employees ARE the entire audience, there is no
   * payload owner/assignee fallback.
   *
   * `actorUserId` is the owner that triggered the deactivation (envelope actor);
   * control `listEmployees` gates on org membership (`assertMember`) and the owner
   * remains a `platform_owner` employee after a SOFT org deactivation, so the s2s
   * call is authorized.
   *
   * NOT fail-soft (unlike `getMembers`/`resolveFanout`): a transport error THROWS so
   * the consumer nacks into the retry ladder (NFR-MNOT-4) rather than silently
   * dropping the whole notification — there is no other recipient source to degrade
   * to. A successful empty list (org genuinely has no active employees) returns [].
   */
  async getOrgActiveMembers(organizationId: string, actorUserId: string): Promise<string[]> {
    if (!organizationId) return [];
    const res = await firstValueFrom(
      this.orgGrpc
        .listEmployees(
          { organization_id: organizationId, actor_user_id: actorUserId },
          this.metadata(),
        )
        .pipe(timeout(this.callTimeoutMs)),
    );
    const ids = (res?.list ?? [])
      .filter((e) => e?.is_active && e?.user_id)
      .map((e) => String(e.user_id));
    return Array.from(new Set(ids));
  }

  private cacheSet(projectId: string, entry: CacheEntry): void {
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(projectId, entry);
  }

  private modulesCacheSet(projectId: string, entry: ModulesCacheEntry): void {
    if (this.modulesCache.size >= this.maxCacheSize) {
      const oldest = this.modulesCache.keys().next().value;
      if (oldest) this.modulesCache.delete(oldest);
    }
    this.modulesCache.set(projectId, entry);
  }
}
