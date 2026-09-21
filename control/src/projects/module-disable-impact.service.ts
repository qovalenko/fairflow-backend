import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import {
  buildServiceOutboundMetadata,
  enabledDependentsOf,
  MODULE_REGISTRY,
  type ProjectModuleConfig,
} from '@fairflow/shared';
import { ProjectsService } from './projects.service';

const IMPACT_TIMEOUT_MS = 3_000;
const UNKNOWN_COUNT = -1;

interface PipeGrpc {
  listDeals(
    data: {
      project_id: string;
      page_index: number;
      page_size: number;
      status?: string;
      include_deleted?: boolean;
    },
    metadata?: Metadata,
  ): unknown;
}

interface OrdersGrpc {
  listOrders(
    data: {
      project_id: string;
      page_index: number;
      page_size: number;
    },
    metadata?: Metadata,
  ): unknown;
}

interface AutomationGrpc {
  listRules(
    data: {
      project_id: string;
      page_index: number;
      page_size: number;
      state?: string;
    },
    metadata?: Metadata,
  ): unknown;
}

export type ModuleDisableImpactResult = {
  dependentEnabledModules: Array<{ id: string; name: string }>;
  unfinishedRecords: number;
  stoppedAutomations: Array<{ id: string; name: string }>;
  /** FR-SHELL-160: outbound webhooks + DLQ delivery pause on automation disable. */
  webhookDlqSuspended: boolean;
};

/**
 * FR-PSET-055 / FR-MPRJ-11: preview consequences before disabling a module.
 * Dependents are computed in control; unfinished counts and automation names are
 * best-effort domain calls with a short timeout (unavailable → -1 / empty).
 */
@Injectable()
export class ModuleDisableImpactService implements OnModuleInit {
  private readonly logger = new Logger(ModuleDisableImpactService.name);
  private pipe!: PipeGrpc;
  private orders!: OrdersGrpc;
  private automation!: AutomationGrpc;

  constructor(
    private readonly projects: ProjectsService,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private readonly ordersClient: ClientGrpcProxy,
    @Inject('AUTOMATION_GRPC') private readonly automationClient: ClientGrpcProxy,
  ) {}

  onModuleInit() {
    this.pipe = this.pipeClient.getService<PipeGrpc>('PipeGrpc');
    this.orders = this.ordersClient.getService<OrdersGrpc>('OrdersGrpc');
    this.automation = this.automationClient.getService<AutomationGrpc>('AutomationGrpc');
  }

  async getImpact(projectId: string, moduleId: string): Promise<ModuleDisableImpactResult> {
    const project = await this.projects.findOne(projectId);
    const configs = (project.moduleConfigs ?? []) as ProjectModuleConfig[];
    const enabled = new Set<string>();
    for (const id of project.effectiveModules ?? []) {
      if (id) enabled.add(id);
    }
    if (!project.effectiveModules?.length) {
      for (const cfg of configs) {
        if (cfg.enabled) enabled.add(cfg.moduleId);
      }
    }
    const installed = new Set<string>();
    for (const cfg of configs) {
      if (cfg.installed || cfg.enabled) installed.add(cfg.moduleId);
    }
    for (const id of enabled) installed.add(id);

    const ctx = { installed, enabled };
    const dependentIds = enabledDependentsOf(moduleId, ctx);
    const dependentEnabledModules = dependentIds.map((id) => ({
      id,
      name: MODULE_REGISTRY[id]?.name ?? id,
    }));

    const meta = this.serviceMeta(projectId);
    const [unfinishedRecords, stoppedAutomations] = await Promise.all([
      this.countUnfinished(moduleId, projectId, meta, enabled),
      this.listStoppedAutomations(moduleId, projectId, meta),
    ]);

    return {
      dependentEnabledModules,
      unfinishedRecords,
      stoppedAutomations,
      webhookDlqSuspended: moduleId === 'automation' && enabled.has('automation'),
    };
  }

  private serviceMeta(projectId: string): Metadata {
    const m = buildServiceOutboundMetadata({
      serviceApiKey:
        process.env.GATEWAY_SERVICE_API_KEY ?? process.env.CONTROL_SERVICE_API_KEY ?? '',
    });
    m.set('x-project-id', projectId);
    return m;
  }

  private async countUnfinished(
    moduleId: string,
    projectId: string,
    meta: Metadata,
    enabled: Set<string>,
  ): Promise<number> {
    if (!enabled.has(moduleId)) return 0;

    try {
      if (moduleId === 'deals') {
        const r = (await this.withTimeout(
          firstValueFrom(
            this.pipe.listDeals(
              {
                project_id: projectId,
                page_index: 0,
                page_size: 1,
                status: 'open',
                include_deleted: false,
              },
              meta,
            ) as never,
          ),
        )) as { total?: number | string } | null;
        if (r == null) return UNKNOWN_COUNT;
        const total = Number(r.total);
        return Number.isFinite(total) ? total : UNKNOWN_COUNT;
      }
      if (moduleId === 'orders') {
        const r = (await this.withTimeout(
          firstValueFrom(
            this.orders.listOrders(
              { project_id: projectId, page_index: 0, page_size: 1 },
              meta,
            ) as never,
          ),
        )) as { total?: number | string } | null;
        if (r == null) return UNKNOWN_COUNT;
        const total = Number(r.total);
        return Number.isFinite(total) ? total : UNKNOWN_COUNT;
      }
    } catch (err) {
      this.logger.warn(
        `unfinished count for ${moduleId} failed: ${err instanceof Error ? err.message : err}`,
      );
      return UNKNOWN_COUNT;
    }
    return UNKNOWN_COUNT;
  }

  private async listStoppedAutomations(
    moduleId: string,
    projectId: string,
    meta: Metadata,
  ): Promise<Array<{ id: string; name: string }>> {
    if (moduleId !== 'automation') return [];
    try {
      const r = (await this.withTimeout(
        firstValueFrom(
          this.automation.listRules(
            { project_id: projectId, page_index: 0, page_size: 20, state: 'enabled' },
            meta,
          ) as never,
        ),
      )) as { list?: Array<{ id?: string; name?: string }> } | null;
      if (!r?.list) return [];
      return r.list
        .filter((row) => row.id)
        .map((row) => ({ id: row.id!, name: row.name?.trim() || row.id! }));
    } catch (err) {
      this.logger.warn(
        `automation preview for disable failed: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms = IMPACT_TIMEOUT_MS): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
