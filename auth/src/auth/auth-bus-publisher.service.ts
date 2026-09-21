import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection } from 'amqplib';
import { OUTBOX_EXCHANGE, buildOutboxRow, dedupKey, type EmitIntent } from '@fairflow/shared';

/**
 * Best-effort publisher for auth-domain security facts mapped to registered
 * `gateway.auth.*` routing-keys (profile password/MFA changes).
 */
@Injectable()
export class AuthBusPublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthBusPublisherService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly enabled = process.env.AUTH_EVENTS_ENABLED !== 'false';
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://fairflow:fairflow@localhost:5672/';
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? OUTBOX_EXCHANGE;

  private async getChannel(): Promise<Channel | null> {
    if (!this.enabled) return null;
    if (this.channel) return this.channel;
    try {
      const connection = await connect(this.url);
      const channel = await connection.createChannel();
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
    } catch (error) {
      this.logger.warn(`auth events broker unavailable: ${String(error)}`);
      return null;
    }
  }

  async publish(intent: EmitIntent): Promise<void> {
    const channel = await this.getChannel();
    if (!channel) return;
    const envelope = buildOutboxRow(intent).envelope;
    try {
      channel.publish(this.exchange, envelope.type, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.messageId,
        correlationId: dedupKey(envelope),
        timestamp: Math.floor(new Date(envelope.timestamp).getTime() / 1000),
        type: envelope.type,
        headers: {
          'x-source': envelope.source,
          'x-version': envelope.version,
        },
      });
    } catch (error) {
      this.logger.warn(`auth event publish failed (${intent.type}): ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }
}
