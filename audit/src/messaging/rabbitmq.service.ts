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
} from '@fairflow/shared';

/** Outcome callbacks for the consumer (observability — FR-NFR-14/32). */
export interface ConsumeObserver {
  onConsumed?: (result: 'ok' | 'error') => void;
  onDeadLettered?: () => void;
  /** Fired once the consumer is (re)bound to the broker — readiness gate. */
  onBound?: () => void;
}

/** Captured `consume` call so we can re-bind after a broker reconnect. */
interface Subscription {
  queueName: string;
  routingKeys: string[];
  handler: (payload: Record<string, unknown>) => Promise<void>;
  observer: ConsumeObserver;
}

@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly url =
    process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? BUS_MAIN_EXCHANGE;

  /** Live subscriptions, replayed on every reconnect. */
  private readonly subscriptions: Subscription[] = [];
  /** Guards against overlapping reconnect loops. */
  private reconnecting = false;
  private destroyed = false;

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createChannel();
    await assertMainExchange(channel, this.exchange);
    // On any error/close drop the cached connection+channel and kick off a
    // reconnect that re-binds every subscription. Without this an unhandled
    // 'error' crashes the process and a 'close' (broker restart) silently stops
    // consumption forever (FR-NFR-3, error-handling remediation).
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

  /** Drop the cached connection/channel and schedule a re-bind of subscriptions. */
  private handleDrop(): void {
    // Close the old connection before dropping the reference. On a channel-only
    // error (406/412) the TCP connection stays OPEN; nulling without close()
    // leaks a socket per reconnect (each rebind dials a fresh connection).
    this.closeQuietly(this.connection, this.channel);
    this.channel = null;
    this.connection = null;
    if (this.destroyed || this.subscriptions.length === 0) return;
    void this.reconnectLoop();
  }

  /** Best-effort close of a channel+connection, ignoring already-closed errors. */
  private closeQuietly(
    connection: Connection | null,
    channel: Channel | null,
  ): void {
    void channel?.close().catch(() => undefined);
    void connection?.close().catch(() => undefined);
  }

  /** Re-establish the channel and re-bind every subscription with backoff. */
  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;
    let delay = 1_000;
    // Snapshot then clear — bindSubscription pushes fresh entries back.
    const pending = this.subscriptions.splice(0, this.subscriptions.length);
    try {
      // eslint-disable-next-line no-constant-condition
      while (!this.destroyed) {
        try {
          for (const sub of pending) {
            await this.bindSubscription(sub);
          }
          this.logger.log(`re-bound ${pending.length} consumer(s) after reconnect`);
          return;
        } catch (error) {
          this.logger.warn(
            `reconnect failed, retrying in ${delay}ms: ${String(error)}`,
          );
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
   * Assert the bounded-retry + DLQ topology for a consumer queue (FR-NFR-32,
   * FR-EVT-7). Replaces the AS-IS silent `nack(requeue=false)` (a gap in the
   * audit chain, blocker FR-NFR-3):
   *  - the work queue dead-letters into a per-level retry queue on `nack`;
   *  - each retry queue holds the message `x-message-ttl` then re-routes it back
   *    to the work exchange for another attempt (delayed redelivery);
   *  - once {@link ConsumerDlqTopology.maxAttempts} is reached the message goes
   *    to the terminal DLQ — never dropped (preserves chain completeness).
   *
   * Best-effort on legacy queues: if the existing `audit.events` queue was
   * declared without `x-dead-letter-*` args, re-assert throws (412). We fall
   * back to a no-DLQ consume but still retry in-process, so the silent-drop is
   * gone regardless.
   */
  async consume(
    queueName: string,
    routingKeys: string[],
    handler: (payload: Record<string, unknown>) => Promise<void>,
    observer: ConsumeObserver = {},
  ): Promise<void> {
    const sub: Subscription = { queueName, routingKeys, handler, observer };
    // Broker may be down at startup: retry the initial bind with backoff so the
    // pod becomes a live consumer as soon as the broker is reachable, instead of
    // starting up healthy-but-not-consuming (error-handling remediation §2).
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

  /** (Re)assert topology and start consuming for one subscription. */
  private async bindSubscription(sub: Subscription): Promise<void> {
    const { queueName, routingKeys, handler, observer } = sub;
    const channel = await this.getChannel();
    // Serialize delivery (TODO-034 second line of defense): without prefetch
    // amqplib pushes messages in batches, so concurrent ingestEvent() calls race
    // on the same chain head. Throughput loss is acceptable — the audit journal
    // is not latency-critical.
    await channel.prefetch(1);
    const topology = consumerDlqTopology(queueName, this.exchange);

    let dlqReady = false;
    try {
      await this.assertDlqTopology(channel, topology, routingKeys);
      dlqReady = true;
    } catch (error) {
      this.logger.warn(
        `DLQ topology not asserted for ${queueName} (legacy queue?): ${String(error)}. ` +
          `Falling back to in-process retry without broker DLQ.`,
      );
    }

    if (!dlqReady) {
      // Legacy path: queue already exists without DLX args. Bind + consume,
      // requeue once on failure instead of silent-dropping (no silent loss).
      await channel.assertQueue(queueName, { durable: true });
      for (const key of routingKeys) {
        await channel.bindQueue(queueName, this.exchange, key);
      }
      await channel.consume(queueName, (message) =>
        this.handleLegacy(channel, message, handler, observer),
      );
    } else {
      await channel.consume(queueName, (message) =>
        this.handleWithDlq(channel, topology, message, handler, observer),
      );
    }
    // Remember (idempotently) so a reconnect replays this binding.
    if (!this.subscriptions.includes(sub)) this.subscriptions.push(sub);
    observer.onBound?.();
  }

  /**
   * Declare retry queues, the terminal DLQ, and bind the work queue — via the
   * single shared bus-topology helper so the exchange/queue types + args match
   * EVERY other service byte-for-byte (no 406 PRECONDITION_FAILED).
   */
  private async assertDlqTopology(
    channel: Channel,
    _topology: ConsumerDlqTopology,
    routingKeys: string[],
  ): Promise<void> {
    await assertConsumerTopology(
      channel,
      _topology.queue,
      { routingKeys, withRetryQueues: true },
      this.exchange,
    );
  }

  private async handleWithDlq(
    channel: Channel,
    topology: ConsumerDlqTopology,
    message: ConsumeMessage | null,
    handler: (payload: Record<string, unknown>) => Promise<void>,
    observer: ConsumeObserver,
  ): Promise<void> {
    if (!message) return;
    try {
      const payload = JSON.parse(message.content.toString()) as Record<string, unknown>;
      await handler(payload);
      channel.ack(message);
      observer.onConsumed?.('ok');
    } catch (error) {
      observer.onConsumed?.('error');
      const attempt = readRetryCount(message.properties.headers as Record<string, unknown>);
      const decision = dlqDecision(attempt, topology);
      if (decision.kind === 'retry') {
        this.logger.warn(
          `audit event failed (attempt ${attempt + 1}/${topology.maxAttempts}), ` +
            `retry in ${decision.delayMs}ms: ${String(error)}`,
        );
        // Route to the level's retry queue (delayed redelivery), then ack the
        // original so it leaves the work queue. Increment the explicit retry
        // counter and preserve the original routing key across the hop.
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
        // Retries exhausted → terminal DLQ. Never a silent drop (FR-NFR-32).
        this.logger.error(
          `audit event dead-lettered after ${topology.maxAttempts} attempts: ${String(error)}`,
        );
        channel.publish(topology.dlqExchange, '', message.content, {
          persistent: true,
          headers: message.properties.headers,
        });
        channel.ack(message);
        observer.onDeadLettered?.();
      }
    }
  }

  /** Fallback for legacy queues without DLX args: requeue once, then drop-log. */
  private async handleLegacy(
    channel: Channel,
    message: ConsumeMessage | null,
    handler: (payload: Record<string, unknown>) => Promise<void>,
    observer: ConsumeObserver,
  ): Promise<void> {
    if (!message) return;
    try {
      const payload = JSON.parse(message.content.toString()) as Record<string, unknown>;
      await handler(payload);
      channel.ack(message);
      observer.onConsumed?.('ok');
    } catch (error) {
      observer.onConsumed?.('error');
      const requeued = !message.fields.redelivered;
      this.logger.error(
        `audit event failed (legacy queue, requeue=${requeued}): ${String(error)}`,
      );
      channel.nack(message, false, requeued);
      if (!requeued) observer.onDeadLettered?.();
    }
  }

  /** Current DLQ depth for the metrics gauge (FR-NFR-32 — alert on growth). */
  async dlqDepth(queueName: string): Promise<number> {
    try {
      const channel = await this.getChannel();
      const topology = consumerDlqTopology(queueName, this.exchange);
      const info = await channel.checkQueue(topology.dlq);
      return info.messageCount;
    } catch {
      return 0;
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
