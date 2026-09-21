import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by company when two records are merged (FR-COMPANIES-140). */
export const COMPANY_MERGED_KEY = 'crm.company.merged';

/** Terminal outcome of one delivery (exposed for unit tests). */
export type CompanyMergedOutcome = 'rewritten' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.company.merged` (FR-COMPANIES-140): rewrites company links on every
 * activity in the project that still references a merge-tombstone loser company.
 */
@Injectable()
export class CompanyMergedConsumer implements OnModuleInit {
  private readonly logger = new Logger(CompanyMergedConsumer.name);
  private readonly enabled = process.env.COMPANY_MERGED_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly activity: ActivityService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('company-merged consumer disabled (COMPANY_MERGED_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('activity.company-merged');
    try {
      await this.rabbit.consume(
        queue,
        [COMPANY_MERGED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.COMPANY_MERGED_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`company-merged consumer bound queue=${queue} to ${COMPANY_MERGED_KEY}`);
    } catch (err) {
      this.logger.error(
        `company-merged consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  async handle(payload: Record<string, unknown>): Promise<CompanyMergedOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const masterId = typeof body.masterId === 'string' ? body.masterId.trim() : '';
    const loserId = typeof body.loserId === 'string' ? body.loserId.trim() : '';
    const mergeKey =
      typeof env.idempotencyKey === 'string' && env.idempotencyKey.trim()
        ? env.idempotencyKey.trim()
        : `company.merged:${loserId}`;
    if (!projectId || !masterId || !loserId) {
      this.logger.error(
        'crm.company.merged missing projectId/masterId/loserId — dead-lettering poison message',
      );
      return 'dead_letter';
    }
    const { rewritten } = await this.activity.rewriteCompanyLinksOnMerge(
      projectId,
      loserId,
      masterId,
      mergeKey,
    );
    if (rewritten > 0) {
      this.logger.log(
        `company merge project=${projectId} ${loserId}→${masterId}: rewrote ${rewritten} activity link(s)`,
      );
    }
    return rewritten > 0 ? 'rewritten' : 'skipped';
  }
}
