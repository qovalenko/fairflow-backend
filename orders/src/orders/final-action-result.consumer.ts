import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { OrdersService } from './orders.service';

/** Answer keys of the final-action saga (published by the automation domain). */
export const FINAL_ACTION_SUCCEEDED_KEY = 'crm.order.final_action_succeeded';
export const FINAL_ACTION_FAILED_KEY = 'crm.order.final_action_failed';

/** Payload of `crm.order.final_action_succeeded` / `_failed` (automation). */
interface FinalActionResultPayload {
  orderId?: string;
  idempotencyKey?: string;
  attemptNo?: number;
  error?: string;
  httpCode?: number;
  durationMs?: number;
}

/** Terminal outcome of one delivery (exposed for unit tests). */
export type FinalActionResultOutcome = 'applied' | 'skipped' | 'poison';

/**
 * Closes the final-action saga on the orders side (FR-ORDERS-280/290): consumes
 * the automation domain's `crm.order.final_action_succeeded` / `_failed`
 * answers and applies `SENDING → DONE | SEND_ERROR` with the attempt log and
 * `lastError` (via {@link OrdersService.applyFinalActionResult}).
 *
 * Idempotency lives in the conditional state transition, not here: a duplicate
 * delivery or a stale answer (older `payloadGen` key, order already moved)
 * matches nothing and ACKs as `skipped`. Only infra faults (Mongo/broker down)
 * re-throw into the shared bounded-retry ladder / DLQ ({@link RabbitMqConsumer}
 * — never an unbounded requeue-loop, never a silent drop).
 */
@Injectable()
export class FinalActionResultConsumer implements OnModuleInit {
  private readonly logger = new Logger(FinalActionResultConsumer.name);
  private readonly enabled = process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: RabbitMqConsumer,
    private readonly orders: OrdersService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'final-action result consumer disabled (FINAL_ACTION_RESULT_CONSUMER_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('orders.final-action');
    try {
      await this.rabbit.consume(
        queue,
        [FINAL_ACTION_SUCCEEDED_KEY, FINAL_ACTION_FAILED_KEY],
        async (payload, routingKey) => {
          await this.handle(payload, routingKey);
        },
        Number(process.env.FINAL_ACTION_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`final-action result consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(
        `final-action result consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Handle one answer delivery. Returns the outcome (tests). Poison (missing
   * project/order/key) is logged and ACKed — retrying cannot repair it, and the
   * conditional transition it would drive can never match anyway.
   */
  async handle(
    payload: Record<string, unknown>,
    routingKey: string,
  ): Promise<FinalActionResultOutcome> {
    const env = payload as unknown as EventEnvelope<FinalActionResultPayload>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const p = (env.payload ?? {}) as FinalActionResultPayload;
    const orderId = typeof p.orderId === 'string' ? p.orderId.trim() : '';
    const idemKey = typeof p.idempotencyKey === 'string' ? p.idempotencyKey.trim() : '';
    if (!projectId || !orderId || !idemKey) {
      this.logger.error(
        `${routingKey} without projectId/orderId/idempotencyKey (msg=${env.messageId ?? '?'}) — skipping poison message`,
      );
      return 'poison';
    }
    const ok = routingKey === FINAL_ACTION_SUCCEEDED_KEY;
    const result = await this.orders.applyFinalActionResult(projectId, orderId, idemKey, ok, {
      error: p.error,
      httpCode: p.httpCode,
      attemptNo: p.attemptNo,
      durationMs: p.durationMs,
    });
    if (result === 'applied') {
      this.logger.log(
        `order ${orderId}: SENDING → ${ok ? 'DONE' : 'SEND_ERROR'} (final action ${idemKey})`,
      );
    } else {
      this.logger.debug(
        `order ${orderId}: stale/duplicate final-action answer ${idemKey} — skipped`,
      );
    }
    return result;
  }
}
