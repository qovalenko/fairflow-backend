import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection } from 'amqplib';
import {
  OUTBOX_EXCHANGE,
  dedupKey,
  type EventEnvelope,
  type OutboxPublisher,
} from '@fairflow/shared';

/**
 * RabbitMQ publisher for the chat outbox relay. Publishes the canonical
 * `EventEnvelope` to the durable, BUS_NAMESPACE-isolated topic exchange
 * (`<BUS_NAMESPACE>.events`) with publisher-confirms (at-least-once).
 */
@Injectable()
export class RabbitMqPublisher implements OutboxPublisher, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqPublisher.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? OUTBOX_EXCHANGE;

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    const connection = await connect(this.url);
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    const reset = () => {
      if (this.channel === channel) this.channel = null;
      if (this.connection === connection) this.connection = null;
    };
    connection.on('error', reset);
    connection.on('close', reset);
    channel.on('error', reset);
    channel.on('close', reset);
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.getChannel();
    const body = Buffer.from(JSON.stringify(envelope));
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        this.exchange,
        envelope.type,
        body,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.messageId,
          correlationId: dedupKey(envelope),
          timestamp: Math.floor(new Date(envelope.timestamp).getTime() / 1000),
          type: envelope.type,
          headers: {
            'x-project-id': envelope.projectId,
            'x-source': envelope.source,
            'x-version': envelope.version,
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }
}
