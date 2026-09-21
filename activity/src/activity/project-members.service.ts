import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { GW_METADATA, newEntityId, serializeVisibilityScope } from '@fairflow/shared';

export const CONTROL_PROJECT_GRPC = 'CONTROL_PROJECT_GRPC';

/**
 * s2s admin scope: control `ProjectGrpc.ListMembers` is not visibility-gated, but a
 * fail-closed control resolver returns empty/404 when the header is absent. Sending an
 * explicit `mode:'all'` scope keeps the member resolve working regardless of a
 * control-side hydration guard.
 */
const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

interface ProjectSvc {
  listMembers: (
    d: { project_id: string },
    metadata?: Metadata,
  ) => Observable<{ list?: Array<{ id?: string; name?: string }> }>;
}

/** FIELD-ACT-departmentId (W-6): справочник подразделений живёт в control. */
interface OrganizationSvc {
  listDepartments: (
    d: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) => Observable<{ list?: Array<{ id?: string }> }>;
}

type MemberCacheEntry = { ids: Set<string>; names: Map<string, string>; exp: number };
type DepartmentCacheEntry = { ids: Set<string>; exp: number };

/**
 * SEC-PEP-2: resolves the set of member userIds of a project via control
 * `ProjectGrpc.ListMembers`, so the activity domain can reject an `assigneeId` that
 * does not belong to the project (visibility escalation via OWNER_FIELD='assigneeId').
 *
 * Resilience contract (FAIL-CLOSED — this is a security check, not a UX enrichment):
 *  - control answers → set of member ids, cached ~30 s per project;
 *  - control down / timeout / any error → the resolve THROWS gRPC UNAVAILABLE, so the
 *    mutation is rejected rather than silently accepting an unvalidated assignee.
 * The caller must short-circuit the empty (no-assignee) and self-assign cases before
 * calling here, so a momentary control outage never blocks a user from creating their
 * own activity.
 */
@Injectable()
export class ProjectMembersService implements OnModuleInit {
  private readonly logger = new Logger(ProjectMembersService.name);
  private project!: ProjectSvc;
  private organization!: OrganizationSvc;
  private readonly cache = new Map<string, MemberCacheEntry>();
  private readonly departmentCache = new Map<string, DepartmentCacheEntry>();
  private readonly ttlMs = parseInt(process.env.CONTROL_MEMBERS_CACHE_TTL_MS ?? '30000', 10);
  private readonly callTimeoutMs = parseInt(process.env.CONTROL_MEMBERS_TIMEOUT_MS ?? '3000', 10);
  private readonly apiKey =
    process.env.ACTIVITY_SERVICE_API_KEY?.trim() ||
    process.env.GATEWAY_SERVICE_API_KEY?.trim() ||
    '';

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.project = this.client.getService<ProjectSvc>('ProjectGrpc');
    this.organization = this.client.getService<OrganizationSvc>('OrganizationGrpc');
  }

  /** s2s metadata accepted by control's inbound api-key guard + fail-closed all-scope. */
  private meta(projectId: string): Metadata {
    const m = new Metadata();
    if (this.apiKey) m.set(GW_METADATA.SERVICE_API_KEY, this.apiKey);
    m.set(GW_METADATA.REQUEST_ID, newEntityId());
    m.set(GW_METADATA.TRACE_ID, newEntityId());
    m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
    m.set(GW_METADATA.ACTOR_TYPE, 'service');
    m.set(GW_METADATA.PROJECT_ID, projectId);
    m.set(GW_METADATA.VISIBILITY_SCOPE, SERVICE_SCOPE);
    return m;
  }

  /**
   * Member userIds of a project (cached ~30 s). FAIL-CLOSED: throws gRPC UNAVAILABLE
   * on control down / timeout / any transport error.
   */
  private async getMemberIds(projectId: string): Promise<Set<string>> {
    const entry = await this.loadMembers(projectId);
    return entry.ids;
  }

  /**
   * Resolve a project member display name (fail-soft: empty string when unknown).
   * Uses the same cached ListMembers snapshot as assignee membership checks.
   */
  async resolveMemberName(projectId: string, userId: string | undefined): Promise<string> {
    const id = String(userId ?? '').trim();
    if (!projectId || !id) return '';
    try {
      const entry = await this.loadMembers(projectId);
      return entry.names.get(id) ?? '';
    } catch {
      return '';
    }
  }

  private async loadMembers(projectId: string): Promise<MemberCacheEntry> {
    const now = Date.now();
    const hit = this.cache.get(projectId);
    if (hit && hit.exp > now) return hit;
    try {
      const res = await firstValueFrom(
        this.project
          .listMembers({ project_id: projectId }, this.meta(projectId))
          .pipe(timeout(this.callTimeoutMs)),
      );
      const names = new Map<string, string>();
      const ids = new Set<string>();
      for (const m of res?.list ?? []) {
        const mid = String(m.id ?? '').trim();
        if (!mid) continue;
        ids.add(mid);
        const name = String(m.name ?? '').trim();
        if (name) names.set(mid, name);
      }
      const entry: MemberCacheEntry = { ids, names, exp: now + this.ttlMs };
      this.cache.set(projectId, entry);
      return entry;
    } catch (err) {
      // Fail-closed: cannot verify membership → reject the mutation (do NOT accept an
      // unvalidated assignee). UNAVAILABLE signals a transient control outage to retry.
      this.logger.warn(
        `control ListMembers(${projectId}) failed — assignee check fail-closed: ${String(err)}`,
      );
      throw new RpcException({
        code: grpcStatus.UNAVAILABLE,
        message: 'Проверка участника проекта недоступна: сервис control не отвечает',
      });
    }
  }

  /**
   * Assert that `assigneeId` belongs to the project (SEC-PEP-2). No-op for:
   *  - empty assignee (ownership defaulting handled by the caller), and
   *  - self-assign (`selfId === assigneeId`) — the caller is a member by definition,
   *    so an outage must not block them from owning their own activity.
   * Non-member → INVALID_ARGUMENT; control unreachable → UNAVAILABLE (fail-closed).
   */
  async assertAssigneeMember(
    projectId: string,
    assigneeId: string | undefined,
    selfId?: string,
  ): Promise<void> {
    const assignee = String(assigneeId ?? '');
    if (!assignee) return;
    if (selfId && assignee === selfId) return;
    if (!projectId) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'projectId обязателен (projectId)',
      });
    }
    const ids = await this.getMemberIds(projectId);
    if (!ids.has(assignee)) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'assignee не является участником проекта (assigneeId)',
      });
    }
  }

  /** Ids of the org departments visible to this project (cached ~30 s, fail-closed). */
  private async getDepartmentIds(projectId: string): Promise<Set<string>> {
    const now = Date.now();
    const hit = this.departmentCache.get(projectId);
    if (hit && hit.exp > now) return hit.ids;
    try {
      const res = await firstValueFrom(
        this.organization
          .listDepartments({ organization_id: '', actor_user_id: '' }, this.meta(projectId))
          .pipe(timeout(this.callTimeoutMs)),
      );
      const ids = new Set<string>(
        (res?.list ?? []).map((d) => String(d.id ?? '')).filter((id) => id),
      );
      this.departmentCache.set(projectId, { ids, exp: now + this.ttlMs });
      return ids;
    } catch (err) {
      this.logger.warn(
        `control ListDepartments(${projectId}) failed — department check fail-closed: ${String(err)}`,
      );
      throw new RpcException({
        code: grpcStatus.UNAVAILABLE,
        message: 'Проверка подразделения недоступна: сервис control не отвечает',
      });
    }
  }

  /**
   * FIELD-ACT-departmentId (W-6): assert that `departmentId` exists in the project's
   * organization. Same fail-closed contract as the assignee check — `departmentId` is
   * a visibility key, so an unvalidated value hides the activity from everyone whose
   * mode is not `all`. The caller short-circuits the empty (not set) case.
   */
  async assertDepartmentValid(projectId: string, departmentId: string): Promise<void> {
    const department = String(departmentId ?? '').trim();
    if (!department) return;
    if (!projectId) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'projectId обязателен (projectId)',
      });
    }
    const ids = await this.getDepartmentIds(projectId);
    if (!ids.has(department)) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Указано недопустимое подразделение (departmentId)',
      });
    }
  }
}
