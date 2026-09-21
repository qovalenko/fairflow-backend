import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { GW_METADATA, newEntityId } from '@fairflow/shared';
import { CONTROL_PROJECT_GRPC } from './project-module-settings.service';

const CACHE_TTL_MS = Number(process.env.PRODUCT_DEPARTMENTS_TTL_MS ?? 30_000) || 30_000;
const CALL_TIMEOUT_MS = Number(process.env.PRODUCT_DEPARTMENTS_TIMEOUT_MS ?? 3_000) || 3_000;

interface OrganizationSvc {
  listDepartments: (
    d: { organization_id?: string; actor_user_id?: string },
    metadata?: Metadata,
  ) => Observable<{ list?: Array<{ id?: string }> }>;
}

/**
 * TODO-293 (E2-08): validates `ownerDepartmentId` against the project's real
 * department list via control `OrganizationGrpc.ListDepartments`.
 *
 * Until now create took whatever id the caller sent. `ownerDepartmentId` is the
 * product OWNER_FIELD (`buildVisibilityFilter`), so a bogus value creates a
 * catalog row nobody but a mode-`all` viewer can see — and update deliberately
 * never rewrites the field (S6), so the only repair is by hand in Mongo.
 *
 * FAIL-CLOSED, like the contact/activity gates on the same class of field:
 * control unreachable → UNAVAILABLE, never "accept unvalidated". `null`
 * (project-level ownership) short-circuits before any RPC — it is the default and
 * must not depend on control being up.
 */
@Injectable()
export class DepartmentValidatorService implements OnModuleInit {
  private readonly logger = new Logger(DepartmentValidatorService.name);
  private organization!: OrganizationSvc;
  private readonly cache = new Map<string, { ids: Set<string>; exp: number }>();
  private readonly apiKey =
    process.env.PRODUCT_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.organization = this.client.getService<OrganizationSvc>('OrganizationGrpc');
  }

  private meta(projectId: string): Metadata {
    const m = new Metadata();
    if (this.apiKey) m.set(GW_METADATA.SERVICE_API_KEY, this.apiKey);
    m.set(GW_METADATA.REQUEST_ID, newEntityId());
    m.set(GW_METADATA.TRACE_ID, newEntityId());
    m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
    m.set(GW_METADATA.ACTOR_TYPE, 'service');
    m.set(GW_METADATA.PROJECT_ID, projectId);
    return m;
  }

  private async departmentIds(projectId: string): Promise<Set<string>> {
    const now = Date.now();
    const hit = this.cache.get(projectId);
    if (hit && hit.exp > now) return hit.ids;
    try {
      const res = await firstValueFrom(
        this.organization
          .listDepartments({ organization_id: '', actor_user_id: '' }, this.meta(projectId))
          .pipe(timeout(CALL_TIMEOUT_MS)),
      );
      const ids = new Set<string>(
        (res?.list ?? []).map((d) => String(d.id ?? '')).filter((id) => id),
      );
      this.cache.set(projectId, { ids, exp: now + CACHE_TTL_MS });
      return ids;
    } catch (err) {
      this.logger.warn(
        `control ListDepartments(${projectId}) failed — ownerDepartmentId check fail-closed: ${String(err)}`,
      );
      throw new RpcException({
        code: grpcStatus.UNAVAILABLE,
        message: 'Проверка подразделения недоступна: сервис control не отвечает',
      });
    }
  }

  /** No-op for null/empty (project-level ownership); unknown id → INVALID_ARGUMENT. */
  async assertOwnerDepartment(projectId: string, ownerDepartmentId?: string | null): Promise<void> {
    const department = String(ownerDepartmentId ?? '').trim();
    if (!department) return;
    const ids = await this.departmentIds(projectId);
    if (!ids.has(department)) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Указано недопустимое подразделение',
        details: { ownerDepartmentId: department },
      });
    }
  }
}
