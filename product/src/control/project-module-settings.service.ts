import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout } from 'rxjs';
import { GW_METADATA, newEntityId } from '@fairflow/shared';
import { prefillFromStruct } from '../product/prefill-struct';

export const CONTROL_PROJECT_GRPC = 'CONTROL_PROJECT_GRPC';

const PRODUCTS_MODULE_ID = 'products';
const FALLBACK_CURRENCY = 'RUB';
const CACHE_TTL_MS = Number(process.env.PRODUCT_MODULE_SETTINGS_TTL_MS ?? 30_000) || 30_000;

type IntegrationSettingsWire = { integration_settings?: unknown };

/**
 * Read-only control client for project-level products module settings
 * (FR-PRODUCTS-050 / FR-MPRD-1b). Fail-soft: control down → `RUB`.
 */
@Injectable()
export class ProjectModuleSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectModuleSettingsService.name);
  private projectGrpc!: {
    getModuleIntegrationSettings: (
      d: { project_id: string; module_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<IntegrationSettingsWire>;
  };
  private readonly apiKey =
    process.env.PRODUCT_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';
  private readonly cache = new Map<string, { settings: Record<string, unknown>; exp: number }>();

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly client: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.projectGrpc = this.client.getService('ProjectGrpc');
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

  async getIntegrationSettings(
    projectId: string,
    moduleId: string = PRODUCTS_MODULE_ID,
  ): Promise<Record<string, unknown>> {
    const key = `${projectId}:${moduleId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.exp > now) return hit.settings;

    try {
      const res = await firstValueFrom(
        this.projectGrpc
          .getModuleIntegrationSettings(
            { project_id: projectId, module_id: moduleId },
            this.meta(projectId),
          )
          .pipe(timeout(2_000)),
      );
      const settings = (prefillFromStruct(res?.integration_settings) ?? {}) as Record<
        string,
        unknown
      >;
      this.cache.set(key, { settings, exp: now + CACHE_TTL_MS });
      return settings;
    } catch (err) {
      this.logger.warn(
        `GetModuleIntegrationSettings failed for ${projectId}/${moduleId}: ${String(err)}`,
      );
      this.cache.set(key, { settings: {}, exp: now + CACHE_TTL_MS });
      return {};
    }
  }

  /** Project default currency for new products when the payload omits `currency`. */
  async defaultCurrency(projectId: string): Promise<string> {
    const settings = await this.getIntegrationSettings(projectId);
    const raw = typeof settings.defaultCurrency === 'string' ? settings.defaultCurrency.trim() : '';
    return raw || FALLBACK_CURRENCY;
  }
}
