import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { GW_METADATA, newEntityId, serializeVisibilityScope } from '@fairflow/shared';

export const CONTROL_PROJECT_GRPC = 'PIPE_CONTROL_PROJECT_GRPC';

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
  ) => Observable<{ list?: Array<{ id?: string }> }>;
}

type CacheEntry = { ids: Set<string>; exp: number };

/** SEC-PEP-2 for deals assigneeId — mirrors activity/project-members.service.ts. */
@Injectable()
export class ProjectMembersService implements OnModuleInit {
  private readonly logger = new Logger(ProjectMembersService.name);
  private project!: ProjectSvc;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = parseInt(process.env.CONTROL_MEMBERS_CACHE_TTL_MS ?? '30000', 10);
  private readonly callTimeoutMs = parseInt(process.env.CONTROL_MEMBERS_TIMEOUT_MS ?? '3000', 10);
  private readonly apiKey =
    process.env.PIPE_SERVICE_API_KEY?.trim() || process.env.GATEWAY_SERVICE_API_KEY?.trim() || '';

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.project = this.client.getService<ProjectSvc>('ProjectGrpc');
  }

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

  private async getMemberIds(projectId: string): Promise<Set<string>> {
    const now = Date.now();
    const hit = this.cache.get(projectId);
    if (hit && hit.exp > now) return hit.ids;
    try {
      const res = await firstValueFrom(
        this.project
          .listMembers({ project_id: projectId }, this.meta(projectId))
          .pipe(timeout(this.callTimeoutMs)),
      );
      const ids = new Set<string>(
        (res?.list ?? []).map((m) => String(m.id ?? '')).filter((id) => id),
      );
      this.cache.set(projectId, { ids, exp: now + this.ttlMs });
      return ids;
    } catch (err) {
      this.logger.warn(
        `control ListMembers(${projectId}) failed — assignee check fail-closed: ${String(err)}`,
      );
      throw new RpcException({
        code: grpcStatus.UNAVAILABLE,
        message: 'Проверка участника проекта недоступна: сервис control не отвечает',
      });
    }
  }

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
}
