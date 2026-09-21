import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import {
  OUTBOX_EXCHANGE,
  assertConsumerTopology,
  assertMainExchange,
  buildRetryHeaders,
  consumerDlqTopology,
  dedupKey,
  dlqDecision,
  readRetryCount,
  type ConsumerDlqTopology,
  type EventEnvelope,
} from '@fairflow/shared';

type EventPayload = Record<string, unknown>;

/**
 * Disposition returned by an {@link RabbitMqService.consumeEnvelope} handler.
 *  - `ack`     — processed (or intentionally skipped) → ack;
 *  - `dead`    — unprocessable/poison → straight to the terminal DLQ (no retry);
 *  - `requeue` — transient failure → climb the bounded-retry ladder (delayed
 *                redelivery), then dead-letter once the budget is exhausted.
 */
export type ConsumeDisposition = 'ack' | 'dead' | 'requeue';

@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private closing = false;
  /**
   * Re-registered on every (re)connect so the consumers survive broker blips.
   * Keyed by queue name: the domain runs SEVERAL envelope consumers (trigger +
   * final-action), and a repeated `consumeEnvelope` for the same queue (the
   * caller's bind-retry loop) must replace its entry, never duplicate it.
   */
  private readonly resubscribers = new Map<string, () => Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs = Number(
    process.env.RABBITMQ_RECONNECT_MS ?? 5000,
  );
  private readonly url =
    process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? OUTBOX_EXCHANGE;

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);

    // Drop the cached connection/channel on any error/close and schedule a
    // reconnect that rebuilds the trigger consumer — a broker restart / network
    // blip must not permanently stop automation triggers.
    const onDown = (reason: string) => {
      // Close the (possibly still-open) connection before dropping it. On a
      // channel-only error (406/412) the TCP connection stays OPEN; nulling
      // without close() leaks a socket per reconnect.
      this.closeQuietly(connection, channel);
      if (this.channel === channel) this.channel = null;
      if (this.connection === connection) this.connection = null;
      if (!this.closing && this.resubscribers.size > 0) {
        this.logger.warn(`broker connection down (${reason}); scheduling reconnect`);
        this.scheduleReconnect();
      }
    };
    connection.on('error', (e) => onDown(`conn error: ${String(e)}`));
    connection.on('close', () => onDown('conn close'));
    channel.on('error', (e) => onDown(`channel error: ${String(e)}`));
    channel.on('close', () => onDown('channel close'));

    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  /** Best-effort close of a channel+connection, ignoring already-closed errors. */
  private closeQuietly(
    connection: ChannelModel | null,
    channel: Channel | null,
  ): void {
    void channel?.close().catch(() => undefined);
    void connection?.close().catch(() => undefined);
  }

  /** Debounced reconnect loop — keeps retrying until the consumer is re-bound. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closing || this.resubscribers.size === 0) return;
    try {
      for (const resubscribe of this.resubscribers.values()) {
        await resubscribe();
      }
      this.logger.log(
        `automation consumers re-established after reconnect (${this.resubscribers.size} queue(s))`,
      );
    } catch (error) {
      this.logger.error(`reconnect failed, will retry: ${String(error)}`);
      this.scheduleReconnect();
    }
  }

  async publish(routingKey: string, payload: EventPayload): Promise<void> {
    const channel = await this.getChannel();
    channel.publish(
      this.exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' },
    );
  }

  /** Publish a canonical RFC-4 {@link EventEnvelope} (automation/audit/statistics emit). */
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

  /**
   * Bind a durable queue to `crm.*` trigger routing-keys and feed each message
   * to `handler` as a parsed {@link EventEnvelope} (the real automation trigger
   * path — contract §3.21 / §5 consumer). Reconnect-safe (rebinds after a broker
   * blip) with a bounded-retry ladder + terminal DLQ (shared
   * {@link consumerDlqTopology}) so:
   *  - a transient failure (`requeue` / thrown) climbs per-level retry queues with
   *    delayed redelivery instead of an instant DLX drop or an unbounded broker
   *    requeue-loop (NFR-MAUT-4);
   *  - a poison message (`dead`) or unparseable JSON goes straight to the terminal
   *    `<queue>.dlq` — never silently dropped, never looped forever.
   */
  async consumeEnvelope(
    queueName: string,
    routingKeys: string[],
    handler: (
      envelope: EventEnvelope,
      message: ConsumeMessage,
    ) => Promise<ConsumeDisposition>,
  ): Promise<void> {
    const resubscribe = () => this.bindConsumer(queueName, routingKeys, handler);
    this.resubscribers.set(queueName, resubscribe);
    await resubscribe();
  }

  private async bindConsumer(
    queueName: string,
    routingKeys: string[],
    handler: (
      envelope: EventEnvelope,
      message: ConsumeMessage,
    ) => Promise<ConsumeDisposition>,
  ): Promise<void> {
    const channel = await this.getChannel();
    // Dead-letter + per-level retry topology via the SINGLE shared source so the
    // exchange/queue types + args match every other service byte-for-byte.
    const topology = consumerDlqTopology(queueName, this.exchange);
    await assertConsumerTopology(
      channel,
      queueName,
      { routingKeys, withRetryQueues: true },
      this.exchange,
    );
    // Bounded prefetch — a single trigger event can fan out to many rule
    // executions; do not pull the whole queue into memory at once.
    await channel.prefetch(Number(process.env.AUTOMATION_PREFETCH ?? 16) || 16);
    await channel.consume(queueName, (message: ConsumeMessage | null) =>
      this.handleMessage(channel, topology, message, handler),
    );
    this.logger.log(
      `automation consumer bound queue=${queueName} to ${routingKeys.length} routing-keys (DLQ ${topology.dlq})`,
    );
  }

  private async handleMessage(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage | null,
    handler: (
      envelope: EventEnvelope,
      message: ConsumeMessage,
    ) => Promise<ConsumeDisposition>,
  ): Promise<void> {
    if (!message) return;
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(message.content.toString()) as EventEnvelope;
    } catch (error) {
      // Poison: not even valid JSON → terminal DLQ, never requeue.
      this.logger.warn(
        `Dead-lettering malformed trigger message on ${message.fields.routingKey}: ${String(error)}`,
      );
      this.deadLetter(channel, topology, message);
      return;
    }
    try {
      const disposition = await handler(envelope, message);
      if (disposition === 'ack') {
        channel.ack(message);
      } else if (disposition === 'requeue') {
        this.retryOrDeadLetter(channel, topology, message, 'handler requeue');
      } else {
        // `dead` — poison, straight to the terminal DLQ (no retry).
        this.deadLetter(channel, topology, message);
      }
    } catch (error) {
      // Unexpected handler crash → climb the retry ladder (transient), not a
      // silent drop and not an unbounded requeue-loop.
      this.retryOrDeadLetter(
        channel,
        topology,
        message,
        `handler error (${envelope.type ?? '?'}): ${String(error)}`,
      );
    }
  }

  /**
   * Advance a transiently-failed message one step down the bounded-retry ladder:
   * send to the current level's retry queue (delayed redelivery via
   * `x-message-ttl`) and ack the original; dead-letter once the budget is spent.
   */
  private retryOrDeadLetter(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage,
    reason: string,
  ): void {
    const attempt = readRetryCount(message.properties.headers as Record<string, unknown>);
    const decision = dlqDecision(attempt, topology);
    if (decision.kind === 'retry') {
      this.logger.warn(
        `trigger event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
          `retry in ${decision.delayMs}ms: ${reason}`,
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
        `trigger event dead-lettered after ${topology.maxAttempts} attempts: ${reason}`,
      );
      this.deadLetter(channel, topology, message);
    }
  }

  /** Publish to the terminal DLX and ack the original (never a silent drop). */
  private deadLetter(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage,
  ): void {
    channel.publish(topology.dlqExchange, '', message.content, {
      persistent: true,
      headers: message.properties.headers,
    });
    channel.ack(message);
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
