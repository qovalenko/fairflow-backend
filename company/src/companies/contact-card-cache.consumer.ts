import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { CompaniesService } from './companies.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Contact-domain events that invalidate the composed company card contacts block. */
export const CONTACT_CARD_CACHE_KEYS = [
  'crm.contact.updated',
  'crm.contact.deleted',
  'crm.contact.merged',
  'crm.company.contact_linked',
  'crm.company.contact_unlinked',
] as const;

export type ContactCardCacheOutcome = 'bumped' | 'skipped' | 'dead_letter';

/**
 * FR-COMPANIES-220 / FR-MCOM-25: listen to contact-link events and bump
 * `cardContactsRev` on affected companies so the gateway card cache misses.
 */
@Injectable()
export class ContactCardCacheConsumer implements OnModuleInit {
  private readonly logger = new Logger(ContactCardCacheConsumer.name);
  private readonly enabled = process.env.CONTACT_CARD_CACHE_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly companies: CompaniesService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('contact-card-cache consumer disabled');
      return;
    }
    const queue = busQueueName('company.contact-card-cache');
    try {
      await this.rabbit.consume(
        queue,
        [...CONTACT_CARD_CACHE_KEYS],
        async (payload, routingKey) => {
          await this.handle(payload, routingKey);
        },
        Number(process.env.CONTACT_CARD_CACHE_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`contact-card-cache consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(
        `contact-card-cache consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  async handle(
    payload: Record<string, unknown>,
    routingKey?: string,
  ): Promise<ContactCardCacheOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    if (!projectId) {
      this.logger.error('contact-card-cache event without projectId — dead-lettering');
      return 'dead_letter';
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const companyIds = this.extractCompanyIds(routingKey ?? env.type ?? '', body);
    if (!companyIds.length) return 'skipped';
    const bumped = await this.companies.bumpCardContactsRev(projectId, companyIds);
    if (bumped > 0) {
      this.logger.log(
        `cardContactsRev bumped for ${bumped} companies (project=${projectId}, key=${routingKey ?? env.type})`,
      );
      return 'bumped';
    }
    return 'skipped';
  }

  private extractCompanyIds(routingKey: string, body: Record<string, unknown>): string[] {
    if (
      routingKey === 'crm.company.contact_linked' ||
      routingKey === 'crm.company.contact_unlinked'
    ) {
      const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
      return companyId ? [companyId] : [];
    }
    if (routingKey === 'crm.contact.merged') {
      const target = typeof body.targetContactId === 'string' ? body.targetContactId : '';
      const sources = Array.isArray(body.sourceContactIds)
        ? body.sourceContactIds.filter((x): x is string => typeof x === 'string')
        : [];
      void target;
      void sources;
      const fromPayload = this.companyIdsFromBody(body);
      const fromChanges = this.companyIdsFromChanges(body.changes);
      return [...new Set([...fromPayload, ...fromChanges])];
    }
    if (routingKey === 'crm.contact.deleted') {
      return this.companyIdsFromBody(body);
    }
    if (routingKey === 'crm.contact.updated') {
      const fromChanges = this.companyIdsFromChanges(body.changes);
      const fromPayload = this.companyIdsFromBody(body);
      return [...new Set([...fromChanges, ...fromPayload])];
    }
    return [];
  }

  private companyIdsFromBody(body: Record<string, unknown>): string[] {
    const raw = body.companyIds ?? body.company_ids;
    if (!Array.isArray(raw)) {
      const single = typeof body.companyId === 'string' ? body.companyId : '';
      return single ? [single] : [];
    }
    return raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  }

  private companyIdsFromChanges(changes: unknown): string[] {
    if (!Array.isArray(changes)) return [];
    const out: string[] = [];
    for (const ch of changes) {
      if (!ch || typeof ch !== 'object') continue;
      const row = ch as { field?: string; oldValue?: unknown; newValue?: unknown };
      if (row.field !== 'companyIds') continue;
      for (const v of [row.oldValue, row.newValue]) {
        if (Array.isArray(v)) {
          out.push(...v.filter((x): x is string => typeof x === 'string'));
        }
      }
    }
    return out;
  }
}
