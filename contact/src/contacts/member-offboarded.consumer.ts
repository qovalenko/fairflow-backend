import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ContactsService } from './contacts.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by control (per revoked project) when a member is offboarded (BX-OFFB-2). */
export const MEMBER_OFFBOARDED_KEY = 'control.member.offboarded';

/** Terminal outcome of one offboard-reassign delivery (exposed for unit tests). */
export type OffboardReassignOutcome = 'reassigned' | 'skipped' | 'dead_letter';

/**
 * Consumer of `control.member.offboarded` (BX-OFFB-2): reassigns every contact
 * the departed member owned (in the event's project) to the chosen active
 * responsible. The heavy lifting (per-record `crm.contact.updated` events, so
 * search/denorm never drift) lives in `ContactsService.reassignOwnedRecords`.
 *
 * Isolation: the reassign filter is `{ projectId, ownerId: from }` from the
 * envelope — a foreign event can never touch another project's data. Idempotency
 * is natural (a redelivery finds nothing still owned by `from` → 0 reassigned).
 * A poison message (missing projectId / from / to) is terminal (`dead_letter`) —
 * logged and acked, never retried forever; a Mongo error throws → retry ladder.
 */
@Injectable()
export class MemberOffboardedConsumer implements OnModuleInit {
  private readonly logger = new Logger(MemberOffboardedConsumer.name);
  private readonly enabled = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly contacts: ContactsService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'member-offboarded consumer disabled (MEMBER_OFFBOARD_CONSUMERS_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('contact.member-offboarded');
    try {
      await this.rabbit.consume(
        queue,
        [MEMBER_OFFBOARDED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.MEMBER_OFFBOARD_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(
        `member-offboarded consumer bound queue=${queue} to ${MEMBER_OFFBOARDED_KEY}`,
      );
    } catch (err) {
      this.logger.error(
        `member-offboarded consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Reassign the leaver's contacts in this project. Throws on a Mongo error
   * (→ retry ladder / DLQ); returns `dead_letter` for a poison message.
   */
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
    const offboardTs = Number(meta.offboardTs);
    if (!projectId || !from || !to) {
      this.logger.error(
        'control.member.offboarded missing projectId/departingUserId/reassignToUserId — dead-lettering poison message',
      );
      return 'dead_letter';
    }
    if (from === to) return 'skipped';
    // A missing/invalid offboardTs must NOT default to 0: the per-record event
    // idempotency key is `contact.reassigned:<id>:<offboardTs>`, so a stable `:0`
    // would dedupe DISTINCT offboards of the same record (A→B, later B→C) in the
    // outbox and leave a stale owner in search/denorm. Control always stamps a
    // positive `offboardTs = Date.now()`, so its absence marks a poison message.
    if (!Number.isFinite(offboardTs) || offboardTs <= 0) {
      this.logger.error(
        'control.member.offboarded missing/invalid offboardTs — dead-lettering poison message',
      );
      return 'dead_letter';
    }
    const { reassigned } = await this.contacts.reassignOwnedRecords(
      projectId,
      from,
      to,
      offboardTs,
    );
    this.logger.log(`offboard reassign project=${projectId} ${from}→${to}: contacts=${reassigned}`);
    return reassigned > 0 ? 'reassigned' : 'skipped';
  }
}
