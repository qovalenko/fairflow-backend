import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { status as grpcStatus } from '@grpc/grpc-js';
import { busQueueName, type EventEnvelope, type VisibilityScope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { OrdersService, type OrdersActor } from './orders.service';
import { OrderSourceReaderService } from './order-source-reader.service';

/** Routing-key emitted by pipe when a deal is closed as won (BOX-SALES-FLOW §2.1). */
export const DEAL_WON_KEY = 'crm.deal.won';

/**
 * s2s admin visibility scope: `mode:'all'` short-circuits the product donor's
 * `scopedFilter`/gate to "visible" (rbac.ts) so this trusted consumer can read
 * the deal's product to resolve its sale-type. Its x-service-api-key is validated
 * by the donor's inbound guard; the read is still scoped by `projectId`.
 */
const SERVICE_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
};

/** Payload of `crm.deal.won` (pipe.service.ts closeDeal). */
interface DealWonPayload {
  dealId?: string;
  productId?: string;
  contactId?: string;
  companyId?: string;
  assigneeId?: string;
  wonVersion?: number;
}

/** Terminal outcome of one delivery (exposed for unit tests). */
export type DealWonOutcome = 'created' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.deal.won` (BOX-SALES-FLOW §3): when a deal is won, auto-create
 * exactly one sale (order) of the product's configured sale-type. The rule is
 * deterministic and quiet — a sale is born only when the sale-type is *known*:
 *
 *  - the deal carries a `productId`,
 *  - that product points at a **non-dangling** `orderTypeId` (sale-type),
 *  - that order type exists, is live, and does not opt out (`autoCreateOnWon`).
 *
 * Otherwise nothing is created (no surprise): the manual «Создать продажу» button
 * on the deal card stays the deliberate step. Idempotent on the event's business
 * key `<dealId>:<wonVersion>` (→ one sale per win; a re-open-and-re-win yields a
 * new version → a new sale). Fields are pre-filled from the payload.
 *
 * Error policy: a *business* rejection (required custom fields, deleted type,
 * assignee out of scope) is ACKed and skipped — the manual path remains, no
 * retry-loop. Only *infra* faults (Mongo/broker/product-donor down) re-throw to
 * the shared retry ladder / DLQ (`RabbitMqConsumer`).
 */
@Injectable()
export class DealWonConsumer implements OnModuleInit {
  private readonly logger = new Logger(DealWonConsumer.name);
  private readonly enabled = process.env.DEAL_WON_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqConsumer,
    private readonly idempotency: IdempotencyService,
    private readonly orders: OrdersService,
    private readonly sourceReader: OrderSourceReaderService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('deal-won consumer disabled (DEAL_WON_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('orders.deal-won');
    try {
      await this.rabbit.consume(
        queue,
        [DEAL_WON_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.DEAL_WON_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`deal-won consumer bound queue=${queue} to ${DEAL_WON_KEY}`);
    } catch (err) {
      this.logger.error(
        `deal-won consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Handle one `crm.deal.won` delivery. Returns the outcome (tests). Throws only
   * on transient/infra faults so the message is retried; every business decision
   * (no product / no sale-type / opted out / rejected) ACKs and returns `skipped`.
   */
  async handle(payload: Record<string, unknown>): Promise<DealWonOutcome> {
    const env = payload as unknown as EventEnvelope<DealWonPayload>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const p = (env.payload ?? {}) as DealWonPayload;
    const dealId = typeof p.dealId === 'string' ? p.dealId.trim() : '';
    if (!projectId || !dealId) {
      this.logger.error('crm.deal.won without projectId/dealId — dead-lettering poison message');
      return 'dead_letter';
    }
    // Business dedup = the event's `<dealId>:<wonVersion>` (pipe emit). Fall back
    // to reconstructing it from the payload if the envelope key is missing.
    const idemKey =
      (typeof env.idempotencyKey === 'string' && env.idempotencyKey.trim()) ||
      (p.wonVersion != null ? `${dealId}:${p.wonVersion}` : '');

    const productId = typeof p.productId === 'string' ? p.productId.trim() : '';
    if (!productId) {
      this.logger.debug(`deal ${dealId} won without a product — no auto-sale (manual path)`);
      return 'skipped';
    }
    // Resolve the product's sale-type. A missing/dangling type ⇒ manual path.
    const product = await this.sourceReader.readProductSaleType(projectId, productId, {
      failSoft: false,
    });
    const orderTypeId = product?.orderTypeId ?? '';
    if (!orderTypeId || product?.dangling) {
      this.logger.log(
        `deal ${dealId}: product ${productId} has no configured sale-type — no auto-sale`,
      );
      return 'skipped';
    }
    // The sale-type must exist, be live, and not opt out (default ON).
    const type = await this.mongo
      .orderTypes()
      .findOne({ projectId, id: orderTypeId, deletedAt: { $in: [null, 0] } });
    if (!type) {
      this.logger.log(`deal ${dealId}: sale-type ${orderTypeId} missing/deleted — no auto-sale`);
      return 'skipped';
    }
    if (type.autoCreateOnWon === false) {
      this.logger.log(`deal ${dealId}: sale-type ${orderTypeId} opted out of auto-create`);
      return 'skipped';
    }

    const actor: OrdersActor = { projectId, userId: '', scope: SERVICE_SCOPE };
    const data: Record<string, unknown> = {
      order_type_id: orderTypeId,
      deal_id: dealId,
      product_id: productId,
      contact_id: p.contactId ?? '',
      company_id: p.companyId ?? '',
      assignee_id: p.assigneeId ?? '',
    };
    try {
      const created = await this.idempotency.withIdempotency<{ id?: string; number?: string }>(
        projectId,
        idemKey || undefined,
        'won-auto-order',
        () => this.orders.createOrder(data, actor) as Promise<{ id?: string; number?: string }>,
        (r) => r?.id,
      );
      this.logger.log(
        `auto-created sale ${created?.number ?? '?'} for won deal ${dealId} (type ${orderTypeId})`,
      );
      return 'created';
    } catch (err) {
      if (this.isBusinessRejection(err)) {
        this.logger.warn(
          `auto-sale for deal ${dealId} rejected (manual path remains): ${this.errText(err)}`,
        );
        return 'skipped';
      }
      throw err;
    }
  }

  /** True for a domain/validation rejection (skip, don't retry). */
  private isBusinessRejection(err: unknown): boolean {
    const e = err as { getError?: () => unknown; code?: number } | null;
    const inner = e && typeof e.getError === 'function' ? (e.getError() as { code?: number }) : e;
    const code = inner?.code;
    return (
      code === grpcStatus.INVALID_ARGUMENT ||
      code === grpcStatus.FAILED_PRECONDITION ||
      code === grpcStatus.NOT_FOUND ||
      code === grpcStatus.ALREADY_EXISTS ||
      code === grpcStatus.PERMISSION_DENIED
    );
  }

  private errText(err: unknown): string {
    const e = err as { getError?: () => unknown } | null;
    if (e && typeof e.getError === 'function') return String(e.getError());
    return String(err);
  }
}
