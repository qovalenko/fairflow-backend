/**
 * Minimal ambient typings for `amqplib` (E3-01 outbox publisher + BX-INTEG-4
 * webhook-delivery consumer).
 *
 * `amqplib@0.10` ships no `.d.ts` and `@types/amqplib` is not installed in this
 * workspace (contact builds with `noImplicitAny: true`). This declares only the
 * surface control uses (publisher + consumer), so the build stays strict without
 * pulling a new dependency. Replace with `@types/amqplib` if/when it is added.
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

  /** A delivered message (subset used by the webhook consumer). */
  export interface ConsumeMessage {
    content: Buffer;
    fields: { routingKey: string; redelivered: boolean };
    properties: { headers?: Record<string, unknown>; messageId?: string };
  }

  export interface Channel {
    assertExchange(
      exchange: string,
      type: string,
      options?: { durable?: boolean },
    ): Promise<unknown>;
    assertQueue(
      queue: string,
      options?: { durable?: boolean; arguments?: Record<string, unknown> },
    ): Promise<unknown>;
    bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
    prefetch(count: number, global?: boolean): Promise<unknown>;
    consume(
      queue: string,
      onMessage: (msg: ConsumeMessage | null) => void,
      options?: { noAck?: boolean },
    ): Promise<unknown>;
    ack(message: ConsumeMessage, allUpTo?: boolean): void;
    nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: PublishOptions,
      callback?: (err: unknown, ok?: unknown) => void,
    ): boolean;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
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
