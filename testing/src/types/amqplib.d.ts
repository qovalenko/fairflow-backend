/** Minimal surface for box integration bus helpers — avoids hoisting @types/amqplib. */
declare module 'amqplib' {
  import type { EventEmitter } from 'node:events';

  export interface Channel extends EventEmitter {
    sendToQueue(
      queue: string,
      content: Buffer,
      options?: Record<string, unknown>,
    ): boolean;
    checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }>;
    close(): Promise<void>;
  }

  export interface Connection extends EventEmitter {
    createChannel(): Promise<Channel>;
    close(): Promise<void>;
  }

  export function connect(url: string): Promise<Connection>;
}
