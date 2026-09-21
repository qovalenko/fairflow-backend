import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { DriftRabbitMqConsumer } from './rabbitmq-consumer.service';
import { DocumentsService } from '../documents/documents.service';

/**
 * documents drift-listener (FR-MDOC-30, contract §5.2).
 *
 * Subscribes to the source-record change facts on the shared bus and flags every
 * released document group bound to the changed record as `driftStale`, emitting
 * `document.drift_detected` (handled in {@link DocumentsService.markDriftForRecord}).
 *
 * Queue: `<BUS_NAMESPACE>.documents.drift` → DLQ `…documents.drift.dlq`. The
 * record id is read ONLY from the envelope payload produced by the source domain
 * (already scoped to `projectId`), never from caller input.
 */

/** Map a `crm.<entity>.updated` routing key → (contextType, payload id field). */
const DRIFT_SOURCES: Record<string, { contextType: string; idFields: string[] }> = {
  'crm.contact.updated': { contextType: 'contact', idFields: ['contactId', 'id'] },
  'crm.company.updated': { contextType: 'company', idFields: ['companyId', 'id'] },
  'crm.deal.updated': { contextType: 'deal', idFields: ['dealId', 'id'] },
  'crm.order.updated': { contextType: 'order', idFields: ['orderId', 'id'] },
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

@Injectable()
export class DriftListener implements OnModuleInit {
  private readonly logger = new Logger(DriftListener.name);
  private readonly enabled = process.env.DOCUMENTS_DRIFT_LISTENER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: DriftRabbitMqConsumer,
    private readonly documents: DocumentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('documents drift-listener disabled (DOCUMENTS_DRIFT_LISTENER_ENABLED=false)');
      return;
    }
    try {
      await this.rabbit.consume(
        busQueueName('documents.drift'),
        Object.keys(DRIFT_SOURCES),
        (payload, routingKey) => this.handle(payload, routingKey),
      );
      this.logger.log(
        `documents drift-listener bound to ${Object.keys(DRIFT_SOURCES).length} routing-keys`,
      );
    } catch (err) {
      // Do not block startup if the broker is down — drift is best-effort and the
      // lazy CheckDrift gRPC path still works (degrade gracefully).
      this.logger.error(`drift-listener failed to bind: ${String(err)}`);
      this.rabbit.scheduleReconnectAfterBindFailure();
    }
  }

  private async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const map = DRIFT_SOURCES[routingKey];
    if (!map) return; // not in our matrix — ack & drop
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn(`drift event ${routingKey} without projectId — skipped`);
      return;
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    // Prefer the subject `<entityType>/<entityId>` then payload id fields.
    const subject = str(env.subject);
    const subjectId = subject.includes('/') ? subject.split('/', 2)[1] : '';
    let recordId = subjectId;
    for (const f of map.idFields) {
      if (recordId) break;
      recordId = str(body[f]);
    }
    if (!recordId) {
      this.logger.debug(`drift event ${routingKey} without record id — skipped`);
      return;
    }
    const flagged = await this.documents.markDriftForRecord(projectId, map.contextType, recordId);
    if (flagged > 0) {
      this.logger.debug(
        `drift: ${routingKey} ${map.contextType}/${recordId} → ${flagged} group(s) stale`,
      );
    }
  }
}
