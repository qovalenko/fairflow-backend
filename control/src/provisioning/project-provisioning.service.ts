import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { buildServiceOutboundMetadata } from '@fairflow/shared';

interface PipeProvisioning {
  provisionDefaults(
    data: {
      project_id: string;
      template_id: string;
      enabled_modules: string[];
    },
    metadata?: Metadata,
  ): unknown;
  seedDemoData(
    data: {
      project_id: string;
      owner_id: string;
      assignee_ids: string[];
      enabled_modules: string[];
    },
    metadata?: Metadata,
  ): unknown;
}
interface OrdersProvisioning {
  provisionDefaults(
    data: {
      project_id: string;
      template_id: string;
      enabled_modules: string[];
    },
    metadata?: Metadata,
  ): unknown;
}
interface DocumentsProvisioning {
  provisionDefaults(
    data: {
      project_id: string;
      enabled_modules: string[];
    },
    metadata?: Metadata,
  ): unknown;
}

/** Модуль, без которого типы продаж шаблона не инстанцируются (FR-ONB-7). */
const ORDERS_MODULE_ID = 'orders';
/** Модуль, без которого стартовые шаблоны документов не сеются (BX-DOCS-5). */
const DOCUMENTS_MODULE_ID = 'documents';

/**
 * Инстанцирование доменов проекта по шаблону (спека §6.2, FR-ONB-5/7/9): после
 * создания проекта control просит `pipe` создать воронку/этапы/источники сделок,
 * а `orders` — типы продаж.
 *
 * Согласование provisioning ↔ итоговый набор модулей (FR-ONB-7, eager):
 *  - воронка создаётся ВСЕГДА (`deals` — locked-модуль, несъёмен);
 *  - типы продаж инстанцируются ТОЛЬКО когда `orders` входит в итоговый набор
 *    модулей проекта (после каскада зависимостей). Иначе control НЕ вызывает
 *    `orders.ProvisionDefaults` — нет «данных без модуля» (INV-ONB-4).
 *
 * `enabled_modules` прокидывается в оба домена (FR-ONB-9): домен кэширует
 * `template_id`+`enabled_modules` локально и при ленивом seeding не создаёт
 * типы продаж, если `orders` выключен — без per-read хопа в control.
 *
 * Вызовы s2s несут service-API-key control'а (x-service-api-key), иначе домены
 * отбивают UNAUTHENTICATED. Идемпотентны (домены защищены уникальным индексом/upsert,
 * FR-ONB-24) и НЕ фатальны: при сбое домена проект уже создан, а ленивый seeding
 * (`ensureProject`/`ensureTypes`) подстрахует по `template_id`. Запускается
 * асинхронно из create-флоу (не блокирует ответ создания проекта).
 */
@Injectable()
export class ProjectProvisioningService implements OnModuleInit {
  private readonly logger = new Logger(ProjectProvisioningService.name);
  private pipe!: PipeProvisioning;
  private orders!: OrdersProvisioning;
  private documents!: DocumentsProvisioning;

  constructor(
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private readonly ordersClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private readonly documentsClient: ClientGrpcProxy,
  ) {}

  onModuleInit() {
    this.pipe = this.pipeClient.getService<PipeProvisioning>('PipeGrpc');
    this.orders = this.ordersClient.getService<OrdersProvisioning>('OrdersGrpc');
    this.documents = this.documentsClient.getService<DocumentsProvisioning>('DocumentsGrpc');
  }

  /**
   * s2s-метадата для вызова pipe/orders. Домены валидируют ключ через auth
   * `ValidateServiceApiKey` и принимают gateway master key — поэтому шлём
   * GATEWAY_SERVICE_API_KEY (control-directory-ключ имеет scope internal:user-directory
   * и доменами провижининга не принимается → "Invalid gateway service API key").
   */
  private serviceMeta(): Metadata {
    return buildServiceOutboundMetadata({
      serviceApiKey:
        process.env.GATEWAY_SERVICE_API_KEY ?? process.env.CONTROL_SERVICE_API_KEY ?? '',
    });
  }

  /**
   * @param enabledModules итоговый набор включённых модулей проекта (после
   *   каскада зависимостей). Управляет тем, инстанцируются ли типы продаж (FR-ONB-7).
   */
  async provisionFromTemplate(
    projectId: string,
    templateId?: string | null,
    enabledModules: string[] = [],
    /**
     * Когда задан — после дефолт-провижининга проект наполняется демо-данными
     * (по включённым модулям). Best-effort, не фатально (как и остальное здесь).
     */
    seedDemo?: { ownerId: string; assigneeIds?: string[] },
  ): Promise<boolean> {
    const template_id = templateId ?? '';
    const enabled_modules = enabledModules ?? [];
    const ordersEnabled = enabled_modules.includes(ORDERS_MODULE_ID);
    const documentsEnabled = enabled_modules.includes(DOCUMENTS_MODULE_ID);
    const tasks: Promise<boolean>[] = [
      // Воронка — всегда (deals locked).
      this.call('pipe', () =>
        firstValueFrom(
          this.pipe.provisionDefaults(
            {
              project_id: projectId,
              template_id,
              enabled_modules,
            },
            this.serviceMeta(),
          ) as never,
        ),
      ),
    ];

    // Типы продаж — только если модуль orders включён в проекте (FR-ONB-7 eager).
    if (ordersEnabled) {
      tasks.push(
        this.call('orders', () =>
          firstValueFrom(
            this.orders.provisionDefaults(
              {
                project_id: projectId,
                template_id,
                enabled_modules,
              },
              this.serviceMeta(),
            ) as never,
          ),
        ),
      );
    } else {
      this.logger.debug(
        `Skipping orders provisioning for project "${projectId}": module "orders" not enabled`,
      );
    }

    // Стартовые шаблоны документов — только если модуль `documents` включён
    if (documentsEnabled) {
      tasks.push(
        this.call('documents', () =>
          firstValueFrom(
            this.documents.provisionDefaults(
              {
                project_id: projectId,
                enabled_modules,
              },
              this.serviceMeta(),
            ) as never,
          ),
        ),
      );
    } else {
      this.logger.debug(
        `Skipping documents provisioning for project "${projectId}": module "documents" not enabled`,
      );
    }

    const results = await Promise.all(tasks);
    let failed = results.some((ok) => !ok);

    if (seedDemo?.ownerId) {
      const demoOk = await this.call('pipe:seed-demo', () =>
        firstValueFrom(
          this.pipe.seedDemoData(
            {
              project_id: projectId,
              owner_id: seedDemo.ownerId,
              assignee_ids: seedDemo.assigneeIds ?? [],
              enabled_modules,
            },
            this.serviceMeta(),
          ) as never,
        ),
      );
      if (!demoOk) failed = true;
    }
    return !failed;
  }

  /** FR-PSET-530: bounded retries before marking provisioning failed. */
  private static readonly PROVISION_MAX_ATTEMPTS = 3;
  private static readonly PROVISION_RETRY_BASE_MS = 150;

  private async call(domain: string, fn: () => Promise<unknown>): Promise<boolean> {
    for (let attempt = 1; attempt <= ProjectProvisioningService.PROVISION_MAX_ATTEMPTS; attempt++) {
      try {
        await fn();
        return true;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        if (attempt >= ProjectProvisioningService.PROVISION_MAX_ATTEMPTS) {
          this.logger.warn(
            `Template provisioning failed for domain "${domain}" after ${attempt} attempt(s): ${message}`,
          );
          return false;
        }
        const delayMs = ProjectProvisioningService.PROVISION_RETRY_BASE_MS * attempt;
        this.logger.warn(
          `Template provisioning attempt ${attempt} for "${domain}" failed (${message}); retry in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }
}
