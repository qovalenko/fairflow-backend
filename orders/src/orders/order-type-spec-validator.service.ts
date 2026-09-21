import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  GW_METADATA,
  newEntityId,
  rpcInvalidArgument,
  serializeVisibilityScope,
} from '@fairflow/shared';
import {
  collectDocumentTemplateSpecViolations,
  collectFinalActionSpecViolations,
  extractDocumentTemplateIds,
  extractFinalActionExistenceChecks,
  type SpecViolation,
} from './order-type-spec.validation';

const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

interface AutomationSvc {
  getConnection: (
    d: { project_id: string; connection_id: string },
    metadata?: Metadata,
  ) => Observable<Record<string, unknown>>;
}

interface DocumentsSvc {
  getTemplate: (
    d: { project_id: string; id: string; version?: number },
    metadata?: Metadata,
  ) => Observable<Record<string, unknown>>;
}

interface ProjectSvc {
  listMembers: (
    d: { project_id: string },
    metadata?: Metadata,
  ) => Observable<{ list?: Array<{ id?: string }> }>;
}

/**
 * Cross-domain existence checks for order-type revision saves (FR-ORDERS-035 /
 * FR-ORDERS-100). Sync shape rules live in `order-type-spec.validation.ts`; this
 * service resolves webhook connections, document templates and task assignees via
 * s2s gRPC with fail-closed semantics on registry outages.
 */
@Injectable()
export class OrderTypeSpecValidatorService implements OnModuleInit {
  private readonly logger = new Logger(OrderTypeSpecValidatorService.name);
  private automation!: AutomationSvc;
  private documents!: DocumentsSvc;
  private project!: ProjectSvc;
  private readonly apiKey =
    process.env.ORDERS_SERVICE_API_KEY?.trim() || process.env.GATEWAY_SERVICE_API_KEY?.trim() || '';
  private readonly callTimeoutMs = Number(process.env.ORDERS_SPEC_VALIDATE_TIMEOUT_MS ?? 3000);

  constructor(
    @Inject('AUTOMATION_GRPC') private readonly automationClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private readonly documentsClient: ClientGrpcProxy,
    @Inject('CONTROL_PROJECT_GRPC') private readonly controlClient: ClientGrpcProxy,
  ) {}

  onModuleInit(): void {
    this.automation = this.automationClient.getService<AutomationSvc>('AutomationGrpc');
    this.documents = this.documentsClient.getService<DocumentsSvc>('DocumentsGrpc');
    this.project = this.controlClient.getService<ProjectSvc>('ProjectGrpc');
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

  private throwInvalid(violations: SpecViolation[], message?: string): never {
    throw rpcInvalidArgument(message ?? 'Некорректная спецификация типа продажи', {
      code: 'INVALID_ARGUMENT',
      violations,
    });
  }

  private isNotFound(err: unknown): boolean {
    const code = (err as { code?: number })?.code;
    if (code === grpcStatus.NOT_FOUND) return true;
    return /not found|не найден/i.test(String((err as Error)?.message ?? err));
  }

  async assertValid(
    projectId: string,
    spec: {
      fields: unknown[];
      stages: unknown[];
      finalActionSpec?: unknown;
      documentTemplates?: unknown;
    },
  ): Promise<void> {
    const violations: SpecViolation[] = [];
    collectFinalActionSpecViolations(spec.finalActionSpec, violations);
    collectDocumentTemplateSpecViolations(spec.documentTemplates, violations);
    if (violations.length) this.throwInvalid(violations);

    const { connectionId, assigneeId } = extractFinalActionExistenceChecks(spec.finalActionSpec);
    const templateIds = extractDocumentTemplateIds(spec.documentTemplates);

    if (connectionId) {
      try {
        await firstValueFrom(
          this.automation
            .getConnection(
              { project_id: projectId, connection_id: connectionId },
              this.meta(projectId),
            )
            .pipe(timeout(this.callTimeoutMs)),
        );
      } catch (err) {
        if (this.isNotFound(err)) {
          this.throwInvalid(
            [{ field: 'finalActionSpec.config', reason: 'webhook_connection_not_found' }],
            'Подключение webhook не найдено в проекте',
          );
        }
        this.logger.warn(
          `automation GetConnection(${projectId}, ${connectionId}) failed — spec save fail-closed: ${String(err)}`,
        );
        throw new RpcException({
          code: grpcStatus.UNAVAILABLE,
          message: 'Проверка подключения webhook недоступна: сервис automation не отвечает',
        });
      }
    }

    if (assigneeId) {
      try {
        const res = await firstValueFrom(
          this.project
            .listMembers({ project_id: projectId }, this.meta(projectId))
            .pipe(timeout(this.callTimeoutMs)),
        );
        const ids = new Set((res?.list ?? []).map((m) => String(m.id ?? '')).filter((id) => id));
        if (!ids.has(assigneeId)) {
          this.throwInvalid(
            [{ field: 'finalActionSpec.config.userId', reason: 'task_assignee_not_member' }],
            'Исполнитель задачи не является участником проекта',
          );
        }
      } catch (err) {
        if (err instanceof RpcException) throw err;
        this.logger.warn(
          `control ListMembers(${projectId}) failed — assignee check fail-closed: ${String(err)}`,
        );
        throw new RpcException({
          code: grpcStatus.UNAVAILABLE,
          message: 'Проверка исполнителя задачи недоступна: сервис control не отвечает',
        });
      }
    }

    for (const templateId of templateIds) {
      try {
        await firstValueFrom(
          this.documents
            .getTemplate(
              { project_id: projectId, id: templateId, version: 0 },
              this.meta(projectId),
            )
            .pipe(timeout(this.callTimeoutMs)),
        );
      } catch (err) {
        if (this.isNotFound(err)) {
          this.throwInvalid(
            [{ field: 'documentTemplates', reason: `document_template_not_found:${templateId}` }],
            'Шаблон документа не найден в реестре',
          );
        }
        this.logger.warn(
          `documents GetTemplate(${projectId}, ${templateId}) failed — spec save fail-closed: ${String(err)}`,
        );
        throw new RpcException({
          code: grpcStatus.UNAVAILABLE,
          message: 'Проверка шаблонов документов недоступна: сервис documents не отвечает',
        });
      }
    }
  }
}
