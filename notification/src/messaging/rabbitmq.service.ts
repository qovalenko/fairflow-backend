import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import {
  BUS_MAIN_EXCHANGE,
  assertConsumerTopology,
  assertMainExchange,
  buildRetryHeaders,
  consumerDlqTopology,
  dedupKey,
  dlqDecision,
  readOriginalRoutingKey,
  readRetryCount,
  type ConsumerDlqTopology,
  type EventEnvelope,
} from '@fairflow/shared';

type Handler = (payload: Record<string, unknown>, routingKey: string) => Promise<void>;

/** Captured `consume` call so the binding can be replayed after a reconnect. */
interface Subscription {
  queueName: string;
  routingKeys: string[];
  handler: Handler;
}

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
  /** True once at least one subscription is live (readiness gate, NFR-MNOT-4). */
  private boundFlag = false;

  /** Whether the consumer is currently bound to the broker. */
  get bound(): boolean {
    return this.boundFlag;
  }

  /** Publish a canonical RFC-4 {@link EventEnvelope} (notification → audit/statistics). */
  async publishEnvelope(envelope: EventEnvelope): Promise<void> {
    const channel = await this.getChannel();
    channel.publish(
      this.exchange,
      envelope.type,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.messageId,
        correlationId: dedupKey(envelope),
        timestamp: Math.floor(new Date(envelope.timestamp).getTime() / 1000),
        type: envelope.type,
        headers: {
          'x-project-id': envelope.projectId ?? '',
          'x-source': envelope.source,
          'x-version': envelope.version,
        },
      },
    );
  }

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);
    // Handle broker error/close: an unhandled 'error' crashes the process and a
    // 'close' (broker restart) otherwise silently halts consumption forever.
    // Drop the cached channel/connection and reconnect + re-bind (remediation §1).
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
   * Bind `queueName` to the topic exchange for the given routing keys with the
   * bounded-retry + terminal-DLQ topology (NFR-MNOT-4) via the SINGLE shared
   * bus-topology source. Transient handler failures (Mongo blip, etc.) are
   * routed through the retry ladder instead of an instant `nack(requeue:false)`
   * that would dead-drop the message on the first exception (remediation §3).
   *
   * Initial bind retries in the background so a broker that is down at startup
   * does not block Nest `onModuleInit` (remediation §2 / TODO-201).
   */
  consume(queueName: string, routingKeys: string[], handler: Handler): void {
    const sub: Subscription = { queueName, routingKeys, handler };
    if (!this.subscriptions.some((s) => s.queueName === sub.queueName)) {
      this.subscriptions.push(sub);
    }
    void this.initialBindLoop(sub);
  }

  private async initialBindLoop(sub: Subscription): Promise<void> {
    let delay = 1_000;
    while (!this.destroyed) {
      try {
        await this.bindSubscription(sub);
        return;
      } catch (error) {
        this.logger.warn(
          `initial bind for ${sub.queueName} failed, retrying in ${delay}ms: ${String(error)}`,
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
    const headers = message.properties.headers as Record<string, unknown>;
    // After a retry hop the live routing-key is the work-queue name; recover the
    // original topic key from the preserved header for the handler.
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
          `notification event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
            `retry in ${decision.delayMs}ms: ${String(error)}`,
        );
        channel.sendToQueue(topology.retryQueue(decision.level), message.content, {
          persistent: true,
          headers: buildRetryHeaders(headers, routingKey, attempt + 1),
        });
        channel.ack(message);
      } else {
        this.logger.error(
          `notification event dead-lettered after ${topology.maxAttempts} attempts: ${String(error)}`,
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
