import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout } from 'rxjs';
import { GW_METADATA, newEntityId } from '@fairflow/shared';
import { prefillFromStruct } from './prefill-struct';

export const CONTROL_PROJECT_GRPC = 'CONTROL_PROJECT_GRPC';
const CONTACTS_MODULE_ID = 'contacts';
const CACHE_TTL_MS = Number(process.env.CONTACT_MODULE_SETTINGS_TTL_MS ?? 30_000) || 30_000;

type SettingsWire = { personal_settings?: unknown; integration_settings?: unknown };

/** Read-only control client for per-project contacts settings (FR-CONTACTS-520). */
@Injectable()
export class ProjectModuleSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectModuleSettingsService.name);
  private projectGrpc!: {
    getModulePersonalSettings: (
      d: { project_id: string; module_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<SettingsWire>;
    getModuleIntegrationSettings: (
      d: { project_id: string; module_id: string },
      md?: Metadata,
    ) => import('rxjs').Observable<SettingsWire>;
  };
  private readonly apiKey =
    process.env.CONTACT_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';
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
    moduleId: string = CONTACTS_MODULE_ID,
  ): Promise<Record<string, unknown>> {
    const key = `${projectId}:${moduleId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.exp > now) return hit.settings;

    try {
      // Dedicated tab writes personalSettings (GET/PUT /projects/:id/modules/:id/settings).
      // Integration is a fallback for values saved via the generic Modules tab.
      const [personalRes, integrationRes] = await Promise.all([
        firstValueFrom(
          this.projectGrpc
            .getModulePersonalSettings(
              { project_id: projectId, module_id: moduleId },
              this.meta(projectId),
            )
            .pipe(timeout(2_000)),
        ).catch(() => ({ personal_settings: undefined })),
        firstValueFrom(
          this.projectGrpc
            .getModuleIntegrationSettings(
              { project_id: projectId, module_id: moduleId },
              this.meta(projectId),
            )
            .pipe(timeout(2_000)),
        ).catch(() => ({ integration_settings: undefined })),
      ]);
      const personal = (prefillFromStruct(personalRes?.personal_settings) ?? {}) as Record<
        string,
        unknown
      >;
      const integration = (prefillFromStruct(integrationRes?.integration_settings) ?? {}) as Record<
        string,
        unknown
      >;
      const settings = { ...integration, ...personal };
      this.cache.set(key, { settings, exp: now + CACHE_TTL_MS });
      return settings;
    } catch (err) {
      this.logger.warn(`GetModule*Settings failed for ${projectId}/${moduleId}: ${String(err)}`);
      this.cache.set(key, { settings: {}, exp: now + CACHE_TTL_MS });
      return {};
    }
  }
}
