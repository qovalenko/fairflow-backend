import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import {
  BUS_MAIN_EXCHANGE,
  assertConsumerTopology,
  assertMainExchange,
  buildRetryHeaders,
  consumerDlqTopology,
  dlqDecision,
  readRetryCount,
  type ConsumerDlqTopology,
  type EventEnvelope,
} from '@fairflow/shared';

type Handler = (envelope: EventEnvelope) => Promise<void>;

/** Captured `consume` call so the binding can be replayed after a reconnect. */
interface Subscription {
  queueName: string;
  routingKeys: string[];
  handler: Handler;
}

/**
 * Thin RabbitMQ wrapper for the billing domain (I1a / E3-04). One durable topic
 * exchange (`fairflow.events`), a durable queue bound to the routing-keys billing
 * cares about, and a single channel reused for the outbox relay publisher.
 *
 * The connection/channel are recreated transparently on error/close (broker
 * restart / network blip): an unhandled 'error' would otherwise crash the process
 * and a 'close' would silently stop consumption forever (remediation §1/§2).
 */
@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;

  private readonly subscriptions: Subscription[] = [];
  private reconnecting = false;
  private destroyed = false;
  private boundFlag = false;

  /** Whether the consumer is currently bound to the broker (readiness). */
  get bound(): boolean {
    return this.boundFlag;
  }

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
    // Close the old connection before dropping it — a channel-only error
    // (406/412) leaves the TCP connection OPEN; nulling without close() leaks a
    // socket per reconnect.
    this.closeQuietly(this.connection, this.channel);
    this.channel = null;
    this.connection = null;
    this.boundFlag = false;
    if (this.destroyed || this.subscriptions.length === 0) return;
    void this.reconnectLoop();
  }

  /** Best-effort close of a channel+connection, ignoring already-closed errors. */
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
   * Bind a durable queue and consume the given routing-keys with the bounded-retry
   * + terminal-DLQ topology. Transient handler failures (Mongo/Postgres blip) are
   * routed through the retry ladder instead of an instant `nack(requeue:false)`
   * that dead-drops on the first exception (remediation §3). The initial bind is
   * retried with backoff so a broker down at startup doesn't leave the pod
   * healthy-but-not-consuming (remediation §2).
   */
  async consume(queueName: string, routingKeys: string[], handler: Handler): Promise<void> {
    const sub: Subscription = { queueName, routingKeys, handler };
    let delay = 1_000;
    for (;;) {
      try {
        await this.bindSubscription(sub);
        return;
      } catch (error) {
        if (this.destroyed) return;
        this.logger.warn(
          `initial bind for ${queueName} failed, retrying in ${delay}ms: ${String(error)}`,
        );
        this.closeQuietly(this.connection, this.channel);
        this.channel = null;
        this.connection = null;
        await this.sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
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
    this.boundFlag = true;
  }

  private async handleMessage(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage | null,
    handler: Handler,
  ): Promise<void> {
    if (!message) return;
    try {
      const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
      await handler(envelope);
      channel.ack(message);
    } catch (error) {
      const attempt = readRetryCount(message.properties.headers as Record<string, unknown>);
      const decision = dlqDecision(attempt, topology);
      if (decision.kind === 'retry') {
        this.logger.warn(
          `billing event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
            `retry in ${decision.delayMs}ms: ${String(error)}`,
        );
        channel.sendToQueue(topology.retryQueue(decision.level), message.content, {
          persistent: true,
          headers: buildRetryHeaders(
            message.properties.headers as Record<string, unknown>,
            message.fields.routingKey,
            attempt + 1,
          ),
        });
        channel.ack(message);
      } else {
        this.logger.error(
          `billing event dead-lettered after ${topology.maxAttempts} attempts: ${String(error)}`,
        );
        channel.publish(topology.dlqExchange, '', message.content, {
          persistent: true,
          headers: message.properties.headers,
        });
        channel.ack(message);
      }
    }
  }

  /** Publish a fully-built envelope (used by the outbox relay). */
  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.getChannel();
    const ok = channel.publish(
      this.exchange,
      envelope.type,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        messageId: envelope.messageId,
        contentType: 'application/json',
      },
    );
    if (!ok) {
      await new Promise<void>((resolve) => channel.once('drain', resolve));
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
