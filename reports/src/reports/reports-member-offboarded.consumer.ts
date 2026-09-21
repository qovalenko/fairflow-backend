import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ReportsService } from './reports.service';
import { ReportsRabbitMqConsumer } from '../messaging/rabbitmq-consumer.service';

/** Routing-key control (BX-OFFB-2): участник покинул проект. */
export const MEMBER_OFFBOARDED_KEY = 'control.member.offboarded';

export type OffboardReassignOutcome = 'reassigned' | 'skipped' | 'dead_letter';

/**
 * BR-REPORTS-060: при offboard владельца проектного custom-отчёта переназначаем
 * `createdBy` на выбранного Admin/Owner — «сирот» в списке не остаётся.
 */
@Injectable()
export class ReportsMemberOffboardedConsumer implements OnModuleInit {
  private readonly logger = new Logger(ReportsMemberOffboardedConsumer.name);
  private readonly enabled = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly reports: ReportsService,
    private readonly rabbit: ReportsRabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'reports member-offboarded consumer disabled (MEMBER_OFFBOARD_CONSUMERS_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('reports.member-offboarded');
    try {
      await this.rabbit.consume(queue, [MEMBER_OFFBOARDED_KEY], async (payload) => {
        await this.handle(payload);
      });
      this.logger.log(
        `reports member-offboarded consumer bound queue=${queue} to ${MEMBER_OFFBOARDED_KEY}`,
      );
    } catch (err) {
      this.logger.error(
        `reports member-offboarded consumer failed to bind: ${String(err)}`,
      );
    }
  }

  async handle(payload: Record<string, unknown>): Promise<OffboardReassignOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const meta = (body.metadata ?? {}) as Record<string, unknown>;
    const from =
      typeof meta.departingUserId === 'string' && meta.departingUserId.trim()
        ? meta.departingUserId.trim()
        : typeof body.entityId === 'string'
          ? body.entityId.trim()
          : '';
    const to = typeof meta.reassignToUserId === 'string' ? meta.reassignToUserId.trim() : '';
    if (!projectId || !from || !to) {
      this.logger.warn(
        'control.member.offboarded missing projectId/departingUserId/reassignToUserId — dead-lettering',
      );
      return 'dead_letter';
    }
    const { reassigned } = await this.reports.reassignOrphanedSharedReports(projectId, from, to);
    this.logger.log(`offboard reassign project=${projectId} ${from}→${to}: reports=${reassigned}`);
    return reassigned > 0 ? 'reassigned' : 'skipped';
  }
}
