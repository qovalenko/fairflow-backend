import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import {
  BUS_MAIN_EXCHANGE,
  assertMainExchange,
  busQueueName,
  type EventEnvelope,
} from '@fairflow/shared';
import { WebhookDeliveryService } from './webhook-delivery.service';

/**
 * Routing-keys the webhook-delivery consumer binds to. AMQP topic `#` matches
 * zero-or-more words, so `crm.#` covers the 3-segment business keys (crm.deal.won,
 * crm.contact.created, …). Mirrors the delivery catalog (BOX-INTEGRATIONS §2.4).
 * NB: `partner.#` is deliberately NOT bound — control itself publishes
 * `partner.webhook.dead_lettered`, so binding it would create a delivery loop.
 */
const WEBHOOK_BINDINGS = ['crm.#', 'control.#', 'pipe.#', 'orders.#'] as const;

/** How many messages the broker may hand us before we ack (bounds in-flight work). */
const PREFETCH = Number(process.env.CONTROL_WEBHOOKS_PREFETCH ?? 16) || 16;

/**
 * BX-INTEG-4: RabbitMQ consumer that drives outbound project webhooks. Control
 * today only *publishes* (outbox relay); this adds the *consumer* half — it binds
 * a durable work queue to the shared events exchange and hands every envelope to
 * {@link WebhookDeliveryService}.
 *
 * Delivery failures are contained inside the delivery service (retries/breaker/
 * dead-letter), so we always ack: re-driving the bus message would double-deliver
 * to integrations that already succeeded. A broker restart is survived by the
 * reconnect loop; a message that fails to even parse is dropped (logged) rather
 * than poison-looping. Disabled by `CONTROL_WEBHOOKS_DISABLED=true` (tests / envs
 * without a broker).
 */
@Injectable()
export class WebhookConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookConsumerService.name);
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;
  private readonly queueName =
    process.env.CONTROL_WEBHOOKS_QUEUE ?? busQueueName('control.webhooks');
  private readonly disabled = process.env.CONTROL_WEBHOOKS_DISABLED === 'true';

  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private reconnecting = false;
  private destroyed = false;

  constructor(private readonly delivery: WebhookDeliveryService) {}

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.warn('control webhook consumer disabled (CONTROL_WEBHOOKS_DISABLED=true)');
      return;
    }
    // Broker may be down at boot — retry the initial bind with backoff so the pod
    // starts consuming as soon as the broker is reachable (never healthy-but-idle).
    void this.bindWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }

  private async bindWithRetry(): Promise<void> {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;
    let delay = 1_000;
    try {
      while (!this.destroyed) {
        try {
          await this.bind();
          this.logger.log(`webhook consumer bound to ${this.queueName}`);
          return;
        } catch (error) {
          this.logger.warn(`webhook consumer bind failed, retry in ${delay}ms: ${String(error)}`);
          this.closeQuietly();
          await this.sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async bind(): Promise<void> {
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);
    await channel.assertQueue(this.queueName, { durable: true });
    await channel.prefetch(PREFETCH);
    for (const key of WEBHOOK_BINDINGS) {
      await channel.bindQueue(this.queueName, this.exchange, key);
    }
    // On any error/close drop the cached handles and reconnect (broker blip /
    // restart) — otherwise a 'close' silently stops consumption forever.
    const onError = (err: unknown) =>
      this.logger.warn(`webhook consumer amqp error: ${String(err)}`);
    const onClose = () => this.handleDrop();
    connection.on('error', onError);
    connection.on('close', onClose);
    channel.on('error', onError);
    channel.on('close', onClose);
    this.connection = connection;
    this.channel = channel;
    await channel.consume(this.queueName, (message) => this.handle(channel, message));
  }

  private async handle(channel: Channel, message: ConsumeMessage | null): Promise<void> {
    if (!message) return;
    try {
      const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
      await this.delivery.deliver(envelope);
    } catch (error) {
      // Delivery is self-contained (dead-letters internally); reaching here means
      // a malformed/undeliverable message — log and drop, never poison-loop.
      this.logger.warn(`webhook consume failed (dropped): ${String(error)}`);
    } finally {
      // Always ack: re-driving would double-deliver to succeeded integrations.
      try {
        channel.ack(message);
      } catch {
        // Channel already gone (reconnect in flight) — the unacked message is
        // redelivered after reconnect, which is acceptable (at-least-once).
      }
    }
  }

  private handleDrop(): void {
    this.closeQuietly();
    if (this.destroyed) return;
    void this.bindWithRetry();
  }

  private closeQuietly(): void {
    void this.channel?.close().catch(() => undefined);
    void this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}
