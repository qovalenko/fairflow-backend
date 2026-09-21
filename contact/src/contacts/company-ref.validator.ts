/**
 * FR-CONTACTS-310: целостность связи «контакт → компания».
 * Домен contact не хранит компании — проверяем существование через company gRPC.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  AppError,
  GW_METADATA,
  newEntityId,
  rpcInvalidArgument,
  serializeVisibilityScope,
} from '@fairflow/shared';

const DEFAULT_TIMEOUT_MS = 3_000;

const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

interface CompanySvc {
  getCompany(
    req: { project_id: string; id: string },
    md?: Metadata,
  ): Observable<Record<string, unknown>>;
}

function buildServiceMetadata(projectId: string, inbound?: Metadata): Metadata {
  const md = new Metadata();
  const apiKey = inbound?.get(GW_METADATA.SERVICE_API_KEY)?.[0];
  if (typeof apiKey === 'string' && apiKey) md.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  md.set(GW_METADATA.REQUEST_ID, newEntityId());
  md.set(GW_METADATA.TRACE_ID, newEntityId());
  md.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  md.set(GW_METADATA.ACTOR_TYPE, 'service');
  md.set(GW_METADATA.PROJECT_ID, projectId);
  md.set(GW_METADATA.VISIBILITY_SCOPE, SERVICE_SCOPE);
  return md;
}

function grpcStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'number') return e.code;
  const nested = e.error;
  if (
    typeof nested === 'object' &&
    nested !== null &&
    typeof (nested as { code?: number }).code === 'number'
  ) {
    return (nested as { code: number }).code;
  }
  return undefined;
}

@Injectable()
export class CompanyRefValidator implements OnModuleInit {
  private readonly logger = new Logger(CompanyRefValidator.name);
  private client: CompanySvc | null = null;

  constructor(@Optional() @Inject('COMPANY_GRPC') private readonly companyGrpc?: ClientGrpc) {}

  onModuleInit(): void {
    if (!this.companyGrpc) return;
    try {
      this.client = this.companyGrpc.getService<CompanySvc>('CompanyGrpc');
    } catch (err) {
      this.logger.error(`company CompanyGrpc client unavailable: ${(err as Error).message}`);
    }
  }

  async assertCompaniesExist(
    projectId: string,
    companyIds: string[] | undefined,
    inbound?: Metadata,
  ): Promise<void> {
    const unique = [...new Set((companyIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    const client = this.client;
    if (!client) {
      throw new AppError('internal', 'Не удалось проверить компании: сервис компаний недоступен');
    }
    const md = buildServiceMetadata(projectId, inbound);
    for (const id of unique) {
      try {
        await firstValueFrom(
          client.getCompany({ project_id: projectId, id }, md).pipe(timeout(DEFAULT_TIMEOUT_MS)),
        );
      } catch (err) {
        const code = grpcStatusCode(err);
        if (code === grpcStatus.UNAVAILABLE || code === grpcStatus.DEADLINE_EXCEEDED) {
          this.logger.warn(
            `company ref check failed project=${projectId} id=${id}: ${String(err)}`,
          );
          throw new AppError(
            'internal',
            'Не удалось проверить компании: сервис компаний недоступен',
          );
        }
        // NOT_FOUND and peer-side INTERNAL (masked not-found on older box builds) both mean
        // the client supplied a company ref this project cannot resolve — reject the write.
        throw rpcInvalidArgument('Указана несуществующая компания', {
          field: 'companyIds',
          companyId: id,
        });
      }
    }
  }
}
