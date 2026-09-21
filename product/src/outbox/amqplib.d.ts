/**
 * Minimal ambient typings for `amqplib` (E3-01 outbox publisher).
 *
 * `amqplib@0.10` ships no `.d.ts` and `@types/amqplib` is not installed in this
 * workspace (contact builds with `noImplicitAny: true`). This declares only the
 * surface the outbox publisher uses, so the build stays strict without pulling a
 * new dependency. Replace with `@types/amqplib` if/when it is added.
 */
declare module 'amqplib' {
  export interface PublishOptions {
    persistent?: boolean;
    contentType?: string;
    messageId?: string;
    correlationId?: string;
    timestamp?: number;
    type?: string;
    headers?: Record<string, unknown>;
  }

  export interface ConsumeMessage {
    content: Buffer;
    fields: { routingKey: string; deliveryTag: number; redelivered: boolean };
    properties: { headers?: Record<string, unknown> } & Record<string, unknown>;
  }

  export interface Channel {
    assertExchange(
      exchange: string,
      type: string,
      options?: { durable?: boolean },
    ): Promise<unknown>;
    assertQueue(queue: string, options?: Record<string, unknown>): Promise<{ queue: string }>;
    bindQueue(
      queue: string,
      source: string,
      pattern: string,
      args?: Record<string, unknown>,
    ): Promise<unknown>;
    consume(
      queue: string,
      onMessage: (msg: ConsumeMessage | null) => void,
      options?: Record<string, unknown>,
    ): Promise<{ consumerTag: string }>;
    ack(message: ConsumeMessage, allUpTo?: boolean): void;
    nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: PublishOptions,
      callback?: (err: unknown, ok?: unknown) => void,
    ): boolean;
    sendToQueue(queue: string, content: Buffer, options?: PublishOptions): boolean;
    checkQueue(queue: string): Promise<{ queue: string; messageCount: number }>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    close(): Promise<void>;
  }

  export interface Connection {
    createChannel(): Promise<Channel>;
    createConfirmChannel(): Promise<Channel>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    close(): Promise<void>;
  }

  export function connect(url: string): Promise<Connection>;
}
