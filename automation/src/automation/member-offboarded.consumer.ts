import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { RabbitMqService, type ConsumeDisposition } from '../messaging/rabbitmq.service';
import { AutomationService } from './automation.service';

export const MEMBER_OFFBOARDED_KEY = 'control.member.offboarded';

/**
 * FR-AUTOM-105: when a project member is offboarded, disable automation rules
 * they created (`disabled_reason:actor_inactive`) and notify the responsible party.
 */
@Injectable()
export class MemberOffboardedConsumer implements OnModuleInit {
  private readonly logger = new Logger(MemberOffboardedConsumer.name);
  private readonly enabled = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly automation: AutomationService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'automation member-offboarded consumer disabled (MEMBER_OFFBOARD_CONSUMERS_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('automation.member-offboarded');
    try {
      await this.rabbit.consumeEnvelope(queue, [MEMBER_OFFBOARDED_KEY], async (envelope) => {
        const outcome = await this.handle(envelope);
        return outcome as ConsumeDisposition;
      });
      this.logger.log(`automation member-offboarded consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(`automation member-offboarded consumer failed to bind: ${String(err)}`);
    }
  }

  async handle(envelope: EventEnvelope): Promise<'ack' | 'dead'> {
    const projectId = String(envelope.projectId ?? '').trim();
    const body = (envelope.payload ?? {}) as Record<string, unknown>;
    const meta = (body.metadata ?? {}) as Record<string, unknown>;
    const actorUserId = String(
      meta.departingUserId ?? body.entityId ?? envelope.userId ?? '',
    ).trim();
    if (!projectId || !actorUserId) {
      this.logger.error('control.member.offboarded missing projectId/departingUserId — dead-letter');
      return 'dead';
    }
    await this.automation.disableRulesForInactiveActor(projectId, actorUserId);
    return 'ack';
  }
}
