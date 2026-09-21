import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection, type ConsumeMessage } from 'amqplib';
import { DeadLetterCounter } from './dead-letter.counter';
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
  type EventEnvelope,
} from '@fairflow/shared';

/** A delivered domain event: the broker routing-key + the parsed RFC-4 envelope. */
export interface DeliveredEvent {
  /** Broker routing-key === `envelope.type` (RFC-4 §Р-3). */
  routingKey: string;
  /** Parsed canonical envelope (E3-01 outbox / RFC-4 §Р-1). */
  envelope: EventEnvelope<Record<string, unknown>>;
}

/** Handler outcome — `ack` removes the message, `requeue: false` sends to DLX. */
export type ConsumeResult = 'ack' | { nack: true; requeue: boolean };

@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private closing = false;
  /** Re-registered on every (re)connect so the consumer survives broker blips. */
  private resubscribe: (() => Promise<void>) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs = Number(
    process.env.RABBITMQ_RECONNECT_MS ?? 5000,
  );
  private readonly url =
    process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;

  constructor(private readonly deadLetters: DeadLetterCounter) {}

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);

    // Drop the cached connection/channel on any error or close and schedule a
    // reconnect that re-establishes the consumer — a broker restart / network
    // blip must not permanently stop projection (the whole point of durable
    // queues is lost if we never reconsume).
    const onDown = (reason: string) => {
      // Close the (possibly still-open) connection before dropping it — a
      // channel-only error (406/412) leaves the TCP connection OPEN, and nulling
      // without close() leaks a socket per reconnect.
      this.closeQuietly(connection, channel);
      if (this.channel === channel) this.channel = null;
      if (this.connection === connection) this.connection = null;
      if (!this.closing && this.resubscribe) {
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
    connection: Connection | null,
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
    if (this.closing || !this.resubscribe) return;
    try {
      await this.resubscribe();
      this.logger.log('search projection consumer re-established after reconnect');
    } catch (error) {
      this.logger.error(`reconnect failed, will retry: ${String(error)}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Durable topic-bound consumer for the search projection (contract §5.2,
   * RFC-4 §Р-4). Binds `queueName` to each routing-key, prefetches to bound
   * in-flight work, and routes the full {@link DeliveredEvent} (routing-key +
   * envelope) to the handler so it can dedup on `idempotencyKey ?? messageId`.
   *
   * A bounded-retry ladder + terminal DLQ (shared {@link consumerDlqTopology}) is
   * declared so a transient store failure is retried with backoff (delayed
   * redelivery via per-level retry queues) instead of an instant
   * `nack(requeue:false)` that would dead-letter on the first hiccup
   * (NFR-MSRCH-10). Only once the retry budget is exhausted does the message land
   * in `<queue>.dlq`. Unparseable frames are dead-lettered immediately (a poison
   * message must never loop).
   *
   * The subscription is remembered so {@link scheduleReconnect} can rebuild it
   * after a broker blip.
   */
  async consumeEvents(
    queueName: string,
    routingKeys: string[],
    handler: (event: DeliveredEvent) => Promise<ConsumeResult>,
    prefetch = 20,
  ): Promise<void> {
    this.resubscribe = () =>
      this.bindConsumer(queueName, routingKeys, handler, prefetch);
    await this.resubscribe();
  }

  private async bindConsumer(
    queueName: string,
    routingKeys: string[],
    handler: (event: DeliveredEvent) => Promise<ConsumeResult>,
    prefetch: number,
  ): Promise<void> {
    const channel = await this.getChannel();
    // Topology via the SINGLE shared bus-topology source (DLX fanout, durable,
    // per-level retry queues) — identical across services.
    const topology = consumerDlqTopology(queueName, this.exchange);
    await assertConsumerTopology(
      channel,
      queueName,
      { routingKeys, withRetryQueues: true },
      this.exchange,
    );
    await channel.prefetch(prefetch);
    await channel.consume(queueName, (message: ConsumeMessage | null) =>
      this.handleMessage(channel, topology, message, handler),
    );
    this.logger.log(
      `search projection consuming "${queueName}" bound to ${routingKeys.length} routing-keys (DLQ ${topology.dlq})`,
    );
  }

  private async handleMessage(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage | null,
    handler: (event: DeliveredEvent) => Promise<ConsumeResult>,
  ): Promise<void> {
    if (!message) return;
    let event: DeliveredEvent;
    try {
      const envelope = JSON.parse(message.content.toString()) as EventEnvelope<
        Record<string, unknown>
      >;
      // After a retry hop the live `fields.routingKey` is the work-queue name;
      // recover the ORIGINAL topic key from the preserved header (falls back to
      // the live key on first delivery, then to the envelope type).
      event = {
        routingKey:
          readOriginalRoutingKey(
            message.properties.headers as Record<string, unknown>,
            message.fields.routingKey,
          ) || envelope.type,
        envelope,
      };
    } catch (error) {
      // Unparseable frame — dead-letter immediately, do not requeue (would loop).
      this.logger.error(`Unparseable search event, dead-lettering: ${String(error)}`);
      this.deadLetter(channel, topology, message, `unparseable frame: ${String(error)}`);
      return;
    }
    try {
      const result = await handler(event);
      if (result === 'ack') {
        channel.ack(message);
      } else if (result.requeue) {
        // Handler asked for an immediate requeue.
        channel.nack(message, false, true);
      } else {
        // Handler declared the message undeliverable → climb the retry ladder.
        this.retryOrDeadLetter(channel, topology, message, 'handler nack');
      }
    } catch (error) {
      // Handler threw — transient failure; climb the bounded-retry ladder instead
      // of an instant DLX drop (a broker/store blip shouldn't lose the update).
      this.retryOrDeadLetter(channel, topology, message, String(error));
    }
  }

  /**
   * Advance a failed message one step down the bounded-retry ladder: send it to
   * the current level's retry queue (delayed redelivery via `x-message-ttl`) and
   * ack the original; once the retry budget is exhausted, dead-letter it.
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
        `search event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
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
        `search event dead-lettered after ${topology.maxAttempts} attempts: ${reason}`,
      );
      this.deadLetter(channel, topology, message, reason);
    }
  }

  /**
   * Publish to the terminal DLX and ack the original (never a silent drop), and
   * account for the drop so `GET /search/status` can report it (TODO-484): the
   * counter is per-project (from the envelope) and best-effort — a failed
   * accounting write must not block the DLQ publish.
   */
  private deadLetter(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage,
    reason: string,
  ): void {
    channel.publish(topology.dlqExchange, '', message.content, {
      persistent: true,
      headers: message.properties.headers,
    });
    channel.ack(message);
    void this.deadLetters.record(message.content, reason);
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
