import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import {
  buildServiceOutboundMetadata,
  GW_METADATA,
  readRuntimeStatus,
  type DlqResumeFate,
  type ProjectModuleConfig,
} from '@fairflow/shared';

interface AutomationLifecycleGrpc {
  freezeRules(
    data: { project_id: string; reason: string },
    metadata?: Metadata,
  ): { frozen_rules?: number; paused_dlq?: number };
  unfreezeRules(
    data: { project_id: string; reason: string },
    metadata?: Metadata,
  ): { unfrozen_rules?: number };
  reconcileRuleDependencies(
    data: { project_id: string; enabled_modules?: string[] },
    metadata?: Metadata,
  ): { updated_rules?: number };
  disableRulesForInactiveActor(
    data: { project_id: string; actor_user_id: string },
    metadata?: Metadata,
  ): { disabled_rules?: number };
  resumePausedDlq(
    data: { project_id: string; dlq_fate: string },
    metadata?: Metadata,
  ): { processed?: number };
}

const AUTOMATION_MODULE_ID = 'automation';

/**
 * FR-MAUT-PRE-2 / TODO-283: synchronous push of module/archive lifecycle into
 * automation (`state=frozen` in DB). Best-effort like provisioning — a down
 * automation domain must not block project settings, but the call is awaited
 * before the control RPC returns when automation is reachable.
 */
@Injectable()
export class AutomationLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(AutomationLifecycleService.name);
  private automation!: AutomationLifecycleGrpc;

  constructor(@Inject('AUTOMATION_GRPC') private readonly client: ClientGrpcProxy) {}

  onModuleInit() {
    this.automation = this.client.getService<AutomationLifecycleGrpc>('AutomationGrpc');
  }

  private serviceMeta(projectId: string): Metadata {
    const m = buildServiceOutboundMetadata({
      serviceApiKey:
        process.env.GATEWAY_SERVICE_API_KEY ?? process.env.CONTROL_SERVICE_API_KEY ?? '',
    });
    m.set(GW_METADATA.PROJECT_ID, projectId);
    return m;
  }

  private async call(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(
        `Automation lifecycle ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async freezeRules(
    projectId: string,
    reason: 'module_disabled' | 'project_archived',
  ): Promise<void> {
    await this.call(`freezeRules(${reason})`, () =>
      firstValueFrom(
        this.automation.freezeRules(
          { project_id: projectId, reason },
          this.serviceMeta(projectId),
        ) as never,
      ),
    );
  }

  async unfreezeRules(
    projectId: string,
    reason: 'module_enabled' | 'project_unarchived',
  ): Promise<void> {
    await this.call(`unfreezeRules(${reason})`, () =>
      firstValueFrom(
        this.automation.unfreezeRules(
          { project_id: projectId, reason },
          this.serviceMeta(projectId),
        ) as never,
      ),
    );
  }

  async resumePausedDlq(projectId: string, dlq: DlqResumeFate): Promise<void> {
    await this.call(`resumePausedDlq(${dlq})`, () =>
      firstValueFrom(
        this.automation.resumePausedDlq(
          { project_id: projectId, dlq_fate: dlq },
          this.serviceMeta(projectId),
        ) as never,
      ),
    );
  }

  /**
   * Apply lifecycle facts from `ProjectsService.update` (module enable/disable).
   * Re-enable after suspend (FR-PLATFORM-115) must NOT auto-unfreeze rules.
   */
  async syncModuleTransitions(
    projectId: string,
    facts: Array<{ routingKey: string; moduleId: string }>,
    configs: ProjectModuleConfig[],
    enabledModuleIds: string[] = [],
  ): Promise<void> {
    const cfgById = new Map(configs.map((c) => [c.moduleId, c]));
    for (const fact of facts) {
      if (fact.moduleId !== AUTOMATION_MODULE_ID) continue;
      if (fact.routingKey === 'control.module.disabled') {
        await this.freezeRules(projectId, 'module_disabled');
      } else if (fact.routingKey === 'control.module.enabled') {
        const cfg = cfgById.get(AUTOMATION_MODULE_ID);
        if (cfg && readRuntimeStatus(cfg) === 'active') {
          await this.unfreezeRules(projectId, 'module_enabled');
        }
      } else if (fact.routingKey === 'control.module.runtime_resumed') {
        // Re-enable after suspend does not auto-unfreeze; resume-delivery does.
        await this.unfreezeRules(projectId, 'module_enabled');
      }
    }
    if (enabledModuleIds.length) {
      await this.call(`reconcileRuleDependencies`, () =>
        firstValueFrom(
          this.automation.reconcileRuleDependencies(
            { project_id: projectId, enabled_modules: enabledModuleIds },
            this.serviceMeta(projectId),
          ) as never,
        ),
      );
    }
  }

  async disableRulesForInactiveActor(projectId: string, actorUserId: string): Promise<void> {
    await this.call(`disableRulesForInactiveActor(${actorUserId})`, () =>
      firstValueFrom(
        this.automation.disableRulesForInactiveActor(
          { project_id: projectId, actor_user_id: actorUserId },
          this.serviceMeta(projectId),
        ) as never,
      ),
    );
  }

  async syncArchiveTransition(
    projectId: string,
    wasArchived: boolean,
    isArchived: boolean,
  ): Promise<void> {
    if (isArchived && !wasArchived) {
      await this.freezeRules(projectId, 'project_archived');
    } else if (!isArchived && wasArchived) {
      await this.unfreezeRules(projectId, 'project_unarchived');
    }
  }
}
