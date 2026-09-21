import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import {
  BUS_MAIN_EXCHANGE,
  assertConsumerTopology,
  assertMainExchange,
  buildRetryHeaders,
  consumerDlqTopology,
  dlqDecision,
  readOriginalRoutingKey,
  readRetryCount,
  type ConsumerDlqTopology,
} from '@fairflow/shared';

/** Consumer callback: parsed envelope payload + original topic routing-key. */
export type ConsumeHandler = (
  payload: Record<string, unknown>,
  routingKey: string,
) => Promise<void>;

/** Captured `consume` call so the binding can be replayed after a reconnect. */
interface Subscription {
  queueName: string;
  routingKeys: string[];
  handler: ConsumeHandler;
}

/**
 * Generic RabbitMQ consumer for the pipe domain (F1-bus). Mirrors the audited
 * notification-domain consumer 1:1 so the *topology* (queue args, DLX, retry
 * ladder) is byte-identical across the shared broker and can never 406-clash.
 *
 * Uses the SINGLE shared bus-topology source (`@fairflow/shared`): a durable
 * work queue bound to `crm.*` routing-keys on the `fairflow.events` topic
 * exchange, bounded-retry queues, and a terminal `<queue>.dlq` on the fanout
 * DLX. `nack(requeue=false)` without a DLQ is forbidden (FR-NFR-3).
 *
 * Separate connection/channel from the outbox publisher — publishing and
 * consuming are independent lifecycles.
 */
@Injectable()
export class RabbitMqConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;

  private readonly subscriptions: Subscription[] = [];
  private reconnecting = false;
  private destroyed = false;

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);
    const onError = (err: unknown) =>
      this.logger.warn(`amqp connection/channel error: ${String(err)}`);
    const onClose = () => this.handleDrop();
    connection.on('error', onError);
    connection.on('close', onClose);
    channel.on('error', onError);
    channel.on('close', onClose);
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  private handleDrop(): void {
    this.closeQuietly(this.connection, this.channel);
    this.channel = null;
    this.connection = null;
    if (this.destroyed || this.subscriptions.length === 0) return;
    void this.reconnectLoop();
  }

  private closeQuietly(connection: Connection | null, channel: Channel | null): void {
    void channel?.close().catch(() => undefined);
    void connection?.close().catch(() => undefined);
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;
    let delay = 1_000;
    const pending = this.subscriptions.splice(0, this.subscriptions.length);
    try {
      while (!this.destroyed) {
        try {
          for (const sub of pending) await this.bindSubscription(sub);
          this.logger.log(`re-bound ${pending.length} consumer(s) after reconnect`);
          return;
        } catch (error) {
          this.logger.warn(`reconnect failed, retrying in ${delay}ms: ${String(error)}`);
          this.closeQuietly(this.connection, this.channel);
          this.channel = null;
          this.connection = null;
          await this.sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /**
   * Bind `queueName` to the topic exchange for `routingKeys` with the bounded-
   * retry + terminal-DLQ topology. The initial bind is retried with backoff so a
   * broker that is down at startup doesn't leave the pod healthy-but-not-
   * consuming; the caller may still cap attempts via `maxInitialAttempts`.
   */
  async consume(
    queueName: string,
    routingKeys: string[],
    handler: ConsumeHandler,
    maxInitialAttempts = Infinity,
  ): Promise<void> {
    const sub: Subscription = { queueName, routingKeys, handler };
    let delay = 1_000;
    for (let attempt = 1; attempt <= maxInitialAttempts; attempt += 1) {
      try {
        await this.bindSubscription(sub);
        return;
      } catch (error) {
        if (this.destroyed) return;
        this.logger.warn(
          `initial bind for ${queueName} failed (attempt ${attempt}), retrying in ${delay}ms: ${String(error)}`,
        );
        this.closeQuietly(this.connection, this.channel);
        this.channel = null;
        this.connection = null;
        if (attempt >= maxInitialAttempts) throw error;
        await this.sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async dlqDepth(queueName: string): Promise<number> {
    const channel = await this.getChannel();
    const topology = consumerDlqTopology(queueName, this.exchange);
    try {
      const info = await channel.checkQueue(topology.dlq);
      return info.messageCount;
    } catch {
      return 0;
    }
  }

  private async bindSubscription(sub: Subscription): Promise<void> {
    const channel = await this.getChannel();
    const topology = consumerDlqTopology(sub.queueName, this.exchange);
    await assertConsumerTopology(
      channel,
      sub.queueName,
      { routingKeys: sub.routingKeys, withRetryQueues: true },
      this.exchange,
    );
    await channel.consume(sub.queueName, (message) =>
      this.handleMessage(channel, topology, message, sub.handler),
    );
    if (!this.subscriptions.includes(sub)) this.subscriptions.push(sub);
  }

  private async handleMessage(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage | null,
    handler: ConsumeHandler,
  ): Promise<void> {
    if (!message) return;
    const headers = message.properties.headers as Record<string, unknown>;
    const routingKey = readOriginalRoutingKey(headers, message.fields.routingKey);
    try {
      const payload = JSON.parse(message.content.toString()) as Record<string, unknown>;
      await handler(payload, routingKey);
      channel.ack(message);
    } catch (error) {
      const attempt = readRetryCount(headers);
      const decision = dlqDecision(attempt, topology);
      if (decision.kind === 'retry') {
        this.logger.warn(
          `drift event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
            `retry in ${decision.delayMs}ms: ${String(error)}`,
        );
        channel.sendToQueue(topology.retryQueue(decision.level), message.content, {
          persistent: true,
          headers: buildRetryHeaders(headers, routingKey, attempt + 1),
        });
        channel.ack(message);
      } else {
        this.logger.error(
          `drift event dead-lettered after ${topology.maxAttempts} attempts: ${String(error)}`,
        );
        channel.publish(topology.dlqExchange, '', message.content, {
          persistent: true,
          headers: message.properties.headers,
        });
        channel.ack(message);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }
}
