import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, type Channel, type Connection } from 'amqplib';
import { OUTBOX_EXCHANGE, buildOutboxRow, dedupKey, type EmitIntent } from '@fairflow/shared';

/**
 * Best-effort publisher for `gateway.*` security facts (RFC-4 §Р-3).
 * Login/logout are not tied to a DB mutation in gateway — fire-and-forget after
 * the auth gRPC call succeeds; broker outages must not block the HTTP response.
 */
@Injectable()
export class GatewayEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(GatewayEventsService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private readonly enabled = process.env.GATEWAY_EVENTS_ENABLED !== 'false';
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
      this.logger.warn(`gateway events broker unavailable: ${String(error)}`);
      return null;
    }
  }

  private async publish(intent: EmitIntent): Promise<void> {
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
      this.logger.warn(`gateway event publish failed (${intent.type}): ${String(error)}`);
    }
  }

  async authLogin(userId: string, meta?: { method?: string; ip?: string }): Promise<void> {
    await this.publish({
      type: 'gateway.auth.login',
      source: 'gateway',
      userId,
      actorType: 'user',
      subject: `user/${userId}`,
      idempotencyKey: `gateway.auth.login:${userId}:${Date.now()}`,
      payload: { userId, method: meta?.method ?? 'password', ip: meta?.ip },
    });
  }

  async authLogout(userId: string, sessionId?: string): Promise<void> {
    await this.publish({
      type: 'gateway.auth.logout',
      source: 'gateway',
      userId,
      actorType: 'user',
      subject: `user/${userId}`,
      idempotencyKey: `gateway.auth.logout:${userId}:${sessionId ?? 'unknown'}:${Date.now()}`,
      payload: { userId, sessionId },
    });
  }

  async authLoginFailed(meta?: {
    method?: string;
    ip?: string;
    identifier?: string;
  }): Promise<void> {
    await this.publish({
      type: 'gateway.auth.login_failed',
      source: 'gateway',
      actorType: 'user',
      subject: meta?.identifier ? `user/${meta.identifier}` : 'auth/login',
      idempotencyKey: `gateway.auth.login_failed:${meta?.ip ?? 'unknown'}:${Date.now()}`,
      payload: {
        method: meta?.method ?? 'password',
        ip: meta?.ip,
        identifier: meta?.identifier,
      },
    });
  }

  /**
   * PEP 403 at the gateway edge (FR-ACCESS-630): best-effort bus fact for the
   * immutable audit chain. Published under `control.access.denied` (RFC-4 §Р-3);
   * audit binds `control.#`. Must not block the HTTP 403 response.
   */
  async accessDenied(meta: {
    userId?: string;
    projectId?: string;
    requestId?: string;
    method?: string;
    path?: string;
    code: string;
    message: string;
  }): Promise<void> {
    const rid = meta.requestId ?? 'unknown';
    await this.publish({
      type: 'control.access.denied',
      source: 'control',
      projectId: meta.projectId,
      userId: meta.userId,
      actorType: meta.userId ? 'user' : 'service',
      subject: meta.projectId ? `project/${meta.projectId}` : 'access/denied',
      idempotencyKey: `control.access.denied:${rid}:${Date.now()}`,
      payload: {
        code: meta.code,
        message: meta.message,
        method: meta.method,
        path: meta.path,
        requestId: rid,
        projectId: meta.projectId,
        userId: meta.userId,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }
}
