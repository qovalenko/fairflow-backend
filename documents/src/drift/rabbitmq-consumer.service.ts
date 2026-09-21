import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import {
  BUS_MAIN_EXCHANGE,
  assertConsumerTopology,
  assertMainExchange,
  buildRetryHeaders,
  busConsumerTopology,
  dlqDecision,
  readOriginalRoutingKey,
  readRetryCount,
  type BusConsumerTopology,
} from '@fairflow/shared';

type DriftHandler = (
  payload: Record<string, unknown>,
  routingKey: string,
) => Promise<void>;

/** A registered subscription, replayed verbatim on reconnect. */
interface Subscription {
  queueName: string;
  routingKeys: string[];
  handler: DriftHandler;
}

/**
 * Inbound RabbitMQ consumer for the documents drift-listener (FR-MDOC-30).
 *
 * Binds a durable queue to the shared `<BUS_NAMESPACE>.events` topic exchange for
 * the given routing keys with the canonical bounded-retry + DLQ topology
 * (FR-NFR-32/34): a failed handler routes the message down the retry ladder
 * (delayed redelivery) and only dead-letters to the terminal DLQ once attempts
 * are exhausted — never a silent `nack(requeue=false)` drop.
 *
 * Resilience (FR-NFR-14): the connection/channel carry `error`/`close` handlers
 * that reset local state and schedule a bounded-backoff reconnect which replays
 * every registered subscription. `onModuleInit` binds behind a retry-loop so a
 * broker that is briefly unavailable at startup does not permanently detach the
 * listener.
 */
@Injectable()
export class DriftRabbitMqConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(DriftRabbitMqConsumer.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;

  private readonly subscriptions: Subscription[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closing = false;
  private static readonly RECONNECT_BASE_MS = 1_000;
  private static readonly RECONNECT_MAX_MS = 30_000;

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;

    const connection = await connect(this.url);
    connection.on('error', (err) =>
      this.logger.error(`drift consumer connection error: ${String(err)}`),
    );
    connection.on('close', () => this.onDisconnect('connection closed'));

    const channel = await connection.createChannel();
    channel.on('error', (err) =>
      this.logger.error(`drift consumer channel error: ${String(err)}`),
    );
    channel.on('close', () => this.onDisconnect('channel closed'));

    await assertMainExchange(channel, this.exchange);

    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  async consume(
    queueName: string,
    routingKeys: string[],
    handler: DriftHandler,
  ): Promise<void> {
    // Remember the subscription so it survives a reconnect, then bind it now.
    if (!this.subscriptions.some((s) => s.queueName === queueName)) {
      this.subscriptions.push({ queueName, routingKeys, handler });
    }
    await this.bind({ queueName, routingKeys, handler });
  }

  /** Assert topology + start consuming for a single subscription. */
  private async bind(sub: Subscription): Promise<void> {
    const channel = await this.getChannel();
    const topology = busConsumerTopology(sub.queueName, this.exchange);
    await assertConsumerTopology(
      channel,
      sub.queueName,
      { routingKeys: sub.routingKeys, withRetryQueues: true },
      this.exchange,
    );
    await channel.consume(sub.queueName, (message: ConsumeMessage | null) =>
      this.handleMessage(channel, topology, sub.handler, message),
    );
  }

  private async handleMessage(
    channel: Channel,
    topology: BusConsumerTopology,
    handler: DriftHandler,
    message: ConsumeMessage | null,
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
          `drift event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
            `retry in ${decision.delayMs}ms: ${String(error)}`,
        );
        // Delayed redelivery via the level's retry queue, then ack the original
        // so it leaves the work queue (no silent drop).
        channel.sendToQueue(topology.retryQueue(decision.level), message.content, {
          persistent: true,
          headers: buildRetryHeaders(headers, routingKey, attempt + 1),
        });
        channel.ack(message);
      } else {
        this.logger.error(
          `drift event dead-lettered after ${topology.maxAttempts} attempts: ${String(error)}`,
        );
        channel.publish(topology.dlxExchange, '', message.content, {
          persistent: true,
          headers: message.properties.headers,
        });
        channel.ack(message);
      }
    }
  }

  /** Reset local state and schedule a reconnect that replays subscriptions. */
  private onDisconnect(reason: string): void {
    if (this.closing) return;
    if (!this.channel && !this.connection) return; // already torn down
    this.logger.warn(`drift consumer disconnected (${reason}) — scheduling reconnect`);
    // Close the old connection before dropping it — a channel-only error
    // (406/412) leaves the TCP connection OPEN; nulling without close() leaks a
    // socket per reconnect.
    this.closeQuietly(this.connection, this.channel);
    this.channel = null;
    this.connection = null;
    this.scheduleReconnect();
  }

  /** Best-effort close of a channel+connection, ignoring already-closed errors. */
  private closeQuietly(
    connection: Connection | null,
    channel: Channel | null,
  ): void {
    void channel?.close().catch(() => undefined);
    void connection?.close().catch(() => undefined);
  }

  /** Called when an initial `consume()` bind fails after the subscription is registered. */
  scheduleReconnectAfterBindFailure(): void {
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer || this.subscriptions.length === 0) return;
    const delay = Math.min(
      DriftRabbitMqConsumer.RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      DriftRabbitMqConsumer.RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private async reconnect(): Promise<void> {
    if (this.closing) return;
    try {
      for (const sub of this.subscriptions) {
        await this.bind(sub);
      }
      this.reconnectAttempt = 0;
      this.logger.log(`drift consumer reconnected (${this.subscriptions.length} subscription(s))`);
    } catch (err) {
      this.closeQuietly(this.connection, this.channel);
      this.channel = null;
      this.connection = null;
      this.logger.error(`drift consumer reconnect failed: ${String(err)} — retrying`);
      this.scheduleReconnect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }
}
