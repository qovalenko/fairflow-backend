declare module 'amqplib' {
  export interface Connection {
    createChannel(): Promise<Channel>;
    close(): Promise<void>;
    on(event: 'error' | 'close', listener: (...args: unknown[]) => void): void;
  }

  export interface Channel {
    assertExchange(
      exchange: string,
      type: string,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: Record<string, unknown>,
    ): boolean;
    close(): Promise<void>;
    on(event: 'error' | 'close', listener: (...args: unknown[]) => void): void;
  }

  export function connect(url: string): Promise<Connection>;
}
