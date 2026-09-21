import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, dedupKey, type EventEnvelope } from '@fairflow/shared';
import { UsageRabbitMqConsumer } from './usage-rabbitmq-consumer.service';
import { ProductService } from '../product/product.service';

/**
 * product usage-counter listener (contract §5.2 / FR-MPRD-16, board C4).
 *
 * Keeps `dealsCount` / `activeDealsCount` / `ordersCount` on each product current
 * from the real link facts emitted by pipe/orders — instead of the hard-coded 0
 * that CONFORMANCE §1 flagged. Idempotent by the envelope dedup-key (a unique
 * `crm_product_usage_processed` row), so the at-least-once bus never double-counts.
 *
 * It also carries the order-type lifecycle onto the catalog: a deleted type raises
 * `orderTypeDangling` on the products bound to it and a restored type lowers it
 * again (FR-PRODUCTS-130/320) — the flag the catalog badge and the "reassign type"
 * banner render, which until now no code ever set to true.
 *
 * Queue: `<BUS_NAMESPACE>.product.usage` → DLQ `…product.usage.dlq`. projectId and
 * productId are read ONLY from the source-domain envelope (already projectId-scoped),
 * never from caller input — cross-project facts touch only their own documents.
 */

const LINK = 'crm.deal.product_linked';
const UNLINK = 'crm.deal.product_unlinked';
const ORDER_CREATED = 'crm.order.created';
/**
 * The decrement fact is the CANCEL, not a delete: orders never publishes
 * `crm.order.deleted` (no hard delete exists — grep `orders/src`), so the old
 * subscription was a phantom and `ordersCount` could only ever grow (TODO-446).
 * The authoritative number behind RecountProductUsage is `countOrdersByProduct`,
 * which counts `status != CANCELLED` — so cancel is exactly what makes the
 * incremental counter converge with reconciliation. If a hard delete ever lands,
 * it must decrement only for orders that were NOT already cancelled, otherwise
 * the two facts double-count the same order.
 */
const ORDER_CANCELLED = 'crm.order.cancelled';
/**
 * Order-type lifecycle → the `orderTypeDangling` flag (TODO-233). orders emits
 * `.deleted` (soft delete) and `.restored`; `crm.order_type.archived` is declared
 * in the registry but emitted by nobody, so it is NOT bound here — a subscription
 * to a phantom key is the very defect this pass removes above.
 */
const ORDER_TYPE_DELETED = 'crm.order_type.deleted';
const ORDER_TYPE_RESTORED = 'crm.order_type.restored';
/**
 * Deal lifecycle → `activeDealsCount` only (FR-PRODUCTS-210). Link/unlink events
 * already maintain both counters; close/reopen moves the deal between open and
 * terminal without changing the product link fact.
 */
const DEAL_WON = 'crm.deal.won';
const DEAL_LOST = 'crm.deal.lost';
const DEAL_REOPENED = 'crm.deal.reopened';

const ROUTING_KEYS = [
  LINK,
  UNLINK,
  ORDER_CREATED,
  ORDER_CANCELLED,
  ORDER_TYPE_DELETED,
  ORDER_TYPE_RESTORED,
  DEAL_WON,
  DEAL_LOST,
  DEAL_REOPENED,
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

@Injectable()
export class UsageListener implements OnModuleInit {
  private readonly logger = new Logger(UsageListener.name);
  private readonly enabled = process.env.PRODUCT_USAGE_LISTENER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: UsageRabbitMqConsumer,
    private readonly product: ProductService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('product usage-listener disabled (PRODUCT_USAGE_LISTENER_ENABLED=false)');
      return;
    }
    try {
      await this.rabbit.consume(busQueueName('product.usage'), ROUTING_KEYS, (payload, rk) =>
        this.handle(payload, rk),
      );
      this.logger.log(`product usage-listener bound to ${ROUTING_KEYS.length} routing-keys`);
    } catch (err) {
      // Do not block startup if the broker is down — counters are eventual and the
      // RecountProductUsage reconciliation RPC repairs drift (degrade gracefully).
      this.logger.error(`usage-listener failed to bind: ${String(err)}`);
    }
  }

  private async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn(`usage event ${routingKey} without projectId — skipped`);
      return;
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const key = dedupKey({ idempotencyKey: env.idempotencyKey, messageId: env.messageId });

    switch (routingKey) {
      case LINK: {
        const productId = str(body.productId);
        if (!productId) return;
        await this.product.applyDealLink(
          projectId,
          productId,
          1,
          body.active !== false,
          key,
          routingKey,
        );
        return;
      }
      case UNLINK: {
        const productId = str(body.productId);
        if (!productId) return;
        await this.product.applyDealLink(
          projectId,
          productId,
          -1,
          body.active !== false,
          key,
          routingKey,
        );
        return;
      }
      case ORDER_CREATED: {
        const productId = str(body.productId);
        if (!productId) return; // orders not bound to a product carry no counter fact
        await this.product.applyOrderLink(projectId, productId, 1, key, routingKey);
        return;
      }
      case ORDER_CANCELLED: {
        const productId = str(body.productId);
        if (!productId) return; // order not bound to a product — no counter fact
        await this.product.applyOrderLink(projectId, productId, -1, key, routingKey);
        return;
      }
      case ORDER_TYPE_DELETED:
      case ORDER_TYPE_RESTORED: {
        const orderTypeId = str(body.orderTypeId);
        if (!orderTypeId) {
          this.logger.warn(`${routingKey} without orderTypeId — skipped`);
          return;
        }
        const n = await this.product.applyOrderTypeDangling(
          projectId,
          orderTypeId,
          routingKey === ORDER_TYPE_DELETED,
        );
        if (n) this.logger.log(`${routingKey} ${orderTypeId}: ${n} product(s) re-flagged`);
        return;
      }
      case DEAL_WON:
      case DEAL_LOST: {
        const productId = str(body.productId);
        if (!productId) return;
        // `crm.deal.lost` carries a NON-versioned business key (`deal.lost:<dealId>`)
        // that repeats when the deal is lost again after a reopen — dedup by it would
        // drop every decrement after the first one (permanent +1 drift on
        // activeDealsCount). The transport `messageId` is minted once per outbox row
        // and stable across broker redeliveries, so it dedups redelivery without
        // conflating distinct lost facts. `crm.deal.won` is versioned
        // (`<dealId>:<wonVersion>`) — its business key stays authoritative.
        const dedup = routingKey === DEAL_LOST ? str(env.messageId) || key : key;
        await this.product.applyDealActiveChange(projectId, productId, -1, dedup, routingKey);
        return;
      }
      case DEAL_REOPENED: {
        const productId = str(body.productId);
        if (!productId) return;
        await this.product.applyDealActiveChange(
          projectId,
          productId,
          1,
          key,
          routingKey,
        );
        return;
      }
      default:
        return; // not in our matrix — ack & drop
    }
  }
}
