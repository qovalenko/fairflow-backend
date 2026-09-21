import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ContactsService } from './contacts.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

export const COMPANY_DELETED_KEY = 'crm.company.deleted';

/** Terminal outcome of one delivery (exposed for unit tests). */
export type CompanyDeletedOutcome = 'updated' | 'skipped' | 'dead_letter';

/**
 * FR-MCON-17 / EVT-CONTACTS-company-deleted-listener: при удалении компании
 * помечает осиротевшие связи на контактах (companyIds → orphanedCompanyIds).
 */
@Injectable()
export class CompanyDeletedConsumer implements OnModuleInit {
  private readonly logger = new Logger(CompanyDeletedConsumer.name);
  private readonly enabled = process.env.COMPANY_DELETED_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly contacts: ContactsService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'company-deleted consumer disabled (COMPANY_DELETED_CONSUMERS_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('contact.company-deleted');
    try {
      await this.rabbit.consume(
        queue,
        [COMPANY_DELETED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.COMPANY_DELETED_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`company-deleted consumer bound queue=${queue} to ${COMPANY_DELETED_KEY}`);
    } catch (err) {
      this.logger.error(
        `company-deleted consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  async handle(payload: Record<string, unknown>): Promise<CompanyDeletedOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const fromSubject =
      typeof env.subject === 'string' && env.subject.includes('/')
        ? env.subject.slice(env.subject.indexOf('/') + 1)
        : '';
    const raw = body.companyId;
    const companyId = (typeof raw === 'string' && raw.trim() ? raw.trim() : fromSubject).trim();
    if (!projectId || !companyId) {
      this.logger.error(`${COMPANY_DELETED_KEY} missing projectId/companyId — dead-lettering`);
      return 'dead_letter';
    }
    const updated = await this.contacts.markCompanyLinkOrphaned(projectId, companyId);
    if (updated) {
      this.logger.log(
        `company-deleted project=${projectId} company=${companyId}: updated ${updated} contact(s)`,
      );
      return 'updated';
    }
    return 'skipped';
  }
}
