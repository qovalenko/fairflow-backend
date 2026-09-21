/**
 * TODO-366 / FR-COMPANIES-300: проверка цели переназначения владельца компании.
 * Зеркало contact/reassign-target.validator.ts — ownerId участвует в видимости,
 * поэтому переназначение на пользователя вне scope актора прячет запись.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  AppError,
  CONTROL_VISIBILITY_GRPC,
  GW_METADATA,
  isRecordVisible,
  type VisibilityScope,
} from '@fairflow/shared';

const FORWARD_KEYS: readonly string[] = [
  GW_METADATA.SERVICE_API_KEY,
  GW_METADATA.GATEWAY_API_KEY_ID,
  GW_METADATA.REQUEST_ID,
  GW_METADATA.TRACEPARENT,
  GW_METADATA.TRACE_ID,
  GW_METADATA.GATEWAY_ISSUED_AT,
  GW_METADATA.ACTOR_TYPE,
  GW_METADATA.USER_ID,
  GW_METADATA.PROJECT_ID,
];

const DEFAULT_TIMEOUT_MS = 3_000;
const MEMBERS_TTL_MS = 10_000;

interface MemberWire {
  id?: string;
}
interface ProjectMembersClient {
  listMembers(req: { project_id: string }, md: Metadata): Observable<{ list?: MemberWire[] }>;
}
interface DepartmentWire {
  id?: string;
}
interface OrganizationClient {
  listDepartments(
    req: { organization_id?: string; actor_user_id?: string },
    md: Metadata,
  ): Observable<{ list?: DepartmentWire[] }>;
}

function buildForwardMetadata(inbound?: Metadata): Metadata {
  const md = new Metadata();
  if (!inbound) return md;
  for (const key of FORWARD_KEYS) {
    const v = inbound.get(key)?.[0];
    if (typeof v === 'string' && v) md.set(key, v);
  }
  return md;
}

@Injectable()
export class ReassignTargetValidator {
  private readonly logger = new Logger(ReassignTargetValidator.name);
  private client: ProjectMembersClient | null = null;
  private orgClient: OrganizationClient | null = null;
  private readonly cache = new Map<string, { ids: Set<string>; expiresAt: number }>();
  private readonly deptCache = new Map<string, { ids: Set<string>; expiresAt: number }>();

  constructor(@Optional() @Inject(CONTROL_VISIBILITY_GRPC) private readonly control?: ClientGrpc) {}

  private getClient(): ProjectMembersClient | null {
    if (this.client) return this.client;
    if (!this.control) return null;
    try {
      this.client = this.control.getService<ProjectMembersClient>('ProjectGrpc');
    } catch (err) {
      this.logger.error(`control ProjectGrpc client unavailable: ${(err as Error).message}`);
      return null;
    }
    return this.client;
  }

  private getOrgClient(): OrganizationClient | null {
    if (this.orgClient) return this.orgClient;
    if (!this.control) return null;
    try {
      this.orgClient = this.control.getService<OrganizationClient>('OrganizationGrpc');
    } catch (err) {
      this.logger.error(`control OrganizationGrpc client unavailable: ${(err as Error).message}`);
      return null;
    }
    return this.orgClient;
  }

  private async projectMemberIds(projectId: string, inbound?: Metadata): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.cache.get(projectId);
    if (cached && cached.expiresAt > now) return cached.ids;
    const client = this.getClient();
    if (!client) {
      throw new AppError(
        'internal',
        'Не удалось проверить нового владельца: сервис проектов недоступен',
      );
    }
    let res: { list?: MemberWire[] };
    try {
      res = await firstValueFrom(
        client
          .listMembers({ project_id: projectId }, buildForwardMetadata(inbound))
          .pipe(timeout(DEFAULT_TIMEOUT_MS)),
      );
    } catch (err) {
      this.logger.warn(
        `reassign target check failed project=${projectId}: ${(err as Error).message}`,
      );
      throw new AppError(
        'internal',
        'Не удалось проверить нового владельца: сервис проектов недоступен',
      );
    }
    const ids = new Set(
      (res?.list ?? []).map((m) => String(m?.id ?? '')).filter((id) => id.length > 0),
    );
    this.cache.set(projectId, { ids, expiresAt: now + MEMBERS_TTL_MS });
    return ids;
  }

  private async departmentIds(projectId: string, inbound?: Metadata): Promise<Set<string>> {
    const cacheKey = `dept:${projectId}`;
    const now = Date.now();
    const cached = this.deptCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.ids;
    const client = this.getOrgClient();
    if (!client) {
      throw new AppError(
        'internal',
        'Не удалось проверить подразделение: сервис организации недоступен',
      );
    }
    const actorUserId = inbound?.get(GW_METADATA.USER_ID)?.[0];
    let res: { list?: DepartmentWire[] };
    try {
      res = await firstValueFrom(
        client
          .listDepartments(
            {
              organization_id: '',
              actor_user_id: typeof actorUserId === 'string' ? actorUserId : '',
            },
            buildForwardMetadata(inbound),
          )
          .pipe(timeout(DEFAULT_TIMEOUT_MS)),
      );
    } catch (err) {
      this.logger.warn(
        `reassign department check failed project=${projectId}: ${(err as Error).message}`,
      );
      throw new AppError(
        'internal',
        'Не удалось проверить подразделение: сервис организации недоступен',
      );
    }
    const ids = new Set(
      (res?.list ?? []).map((d) => String(d?.id ?? '')).filter((id) => id.length > 0),
    );
    this.deptCache.set(cacheKey, { ids, expiresAt: now + MEMBERS_TTL_MS });
    return ids;
  }

  assertOwnerVisibleToSubject(
    scope: VisibilityScope | undefined,
    newOwnerId: string,
    field = 'newOwnerId',
  ): void {
    if (!isRecordVisible(scope, newOwnerId, false)) {
      throw new AppError('invalid', 'Указан недопустимый владелец', { field });
    }
  }

  async assertDepartmentAssignable(
    projectId: string,
    newDepartmentId: string,
    inbound?: Metadata,
    field = 'newDepartmentId',
  ): Promise<void> {
    const target = (newDepartmentId ?? '').trim();
    if (!target) {
      throw new AppError('invalid', 'Указано недопустимое подразделение', { field });
    }
    const ids = await this.departmentIds(projectId, inbound);
    if (!ids.has(target)) {
      throw new AppError('invalid', 'Указано недопустимое подразделение', { field });
    }
  }

  async assertOwnerAssignable(
    projectId: string,
    newOwnerId: string,
    inbound?: Metadata,
    field = 'newOwnerId',
    scope?: VisibilityScope,
  ): Promise<void> {
    const target = (newOwnerId ?? '').trim();
    if (!target) {
      throw new AppError('invalid', 'Указан недопустимый владелец', { field });
    }
    const ids = await this.projectMemberIds(projectId, inbound);
    if (!ids.has(target)) {
      throw new AppError('invalid', 'Указан недопустимый владелец', { field });
    }
    if (scope && scope.mode !== 'all') {
      this.assertOwnerVisibleToSubject(scope, target, field);
    }
  }
}
