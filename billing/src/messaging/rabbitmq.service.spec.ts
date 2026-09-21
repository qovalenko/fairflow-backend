import type { Channel } from 'amqplib';
import { consumerDlqTopology } from '@fairflow/shared';
import { RabbitMqService } from './rabbitmq.service';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;

function makeChannel() {
  const handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {};
  return {
    publish: jest.fn().mockReturnValue(true),
    ack: jest.fn(),
    sendToQueue: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_q: string, cb: (msg: unknown) => void) => {
      handlers.consume = cb;
    }),
    once: jest.fn((event: string, cb: () => void) => {
      if (event === 'drain') cb();
    }),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
    }),
    close: jest.fn().mockResolvedValue(undefined),
    handlers,
  };
}

describe('RabbitMqService (billing transport)', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('bound is false until a subscription is live', () => {
    const rabbit = new RabbitMqService();
    expect(rabbit.bound).toBe(false);
  });

  it('publish writes a persistent JSON frame keyed by envelope.type', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    await rabbit.publish({
      messageId: 'm1',
      type: 'billing.module.state_changed',
      projectId: 'p1',
      timestamp: '2026-08-20T10:00:00.000Z',
      source: 'billing',
      version: 1,
      payload: { moduleId: 'documents' },
    });
    expect(channel.publish).toHaveBeenCalledWith(
      expect.any(String),
      'billing.module.state_changed',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'm1',
      }),
    );
  });

  it('publish waits for channel drain when the broker buffer is full', async () => {
    const channel = makeChannel();
    channel.publish.mockReturnValueOnce(false);
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    await rabbit.publish({
      messageId: 'm2',
      type: 'billing.module.state_changed',
      timestamp: '2026-08-20T10:00:00.000Z',
      source: 'billing',
      version: 1,
      payload: {},
    });
    expect(channel.once).toHaveBeenCalledWith('drain', expect.any(Function));
  });

  it('handleMessage ignores null deliveries', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('billing.usage', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn();
    await (
      rabbit as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: null,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, null, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handleMessage acks when the handler succeeds', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('billing.usage', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm1', type: 'document.generated' })),
      properties: { headers: {} },
      fields: { routingKey: 'document.generated' },
    };
    await (
      rabbit as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, handler);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', type: 'document.generated' }),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage routes transient failures through the retry ladder', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('billing.usage', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockRejectedValue(new Error('postgres blip'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm2' })),
      properties: { headers: {} },
      fields: { routingKey: 'document.generated' },
    };
    await (
      rabbit as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, handler);
    expect(channel.sendToQueue).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('handleMessage dead-letters after the retry ladder is exhausted', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('billing.usage', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm3' })),
      properties: { headers: { 'x-retry-count': topology.maxAttempts } },
      fields: { routingKey: 'document.generated' },
    };
    await (
      rabbit as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, handler);
    expect(channel.publish).toHaveBeenCalledWith(
      topology.dlqExchange,
      '',
      message.content,
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('onModuleDestroy closes channel and connection best-effort', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const rabbit = new RabbitMqService();
    await rabbit.publish({
      messageId: 'm1',
      type: 'billing.module.state_changed',
      timestamp: new Date().toISOString(),
      source: 'billing',
      version: 1,
      payload: {},
    });
    await rabbit.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('consume binds a durable queue and marks bound=true', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    await rabbit.consume('billing.usage', ['document.generated'], jest.fn());
    expect(rabbit.bound).toBe(true);
    expect(channel.consume).toHaveBeenCalledWith('billing.usage', expect.any(Function));
  });

  it('retries initial bind with backoff when the broker is down at startup', async () => {
    jest.useFakeTimers();
    const channel = makeChannel();
    connectMock.mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    const bound = rabbit.consume('billing.usage', ['document.generated'], jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    await bound;
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(rabbit.bound).toBe(true);
    jest.useRealTimers();
  });

  it('re-binds subscriptions after the channel drops', async () => {
    jest.useFakeTimers();
    let onChannelClose: (() => void) | undefined;
    const channel = makeChannel();
    channel.on.mockImplementation((event: string, cb: () => void) => {
      if (event === 'close') onChannelClose = cb;
    });
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    await rabbit.consume('billing.usage', ['document.generated'], jest.fn());
    expect(rabbit.bound).toBe(true);
    expect(channel.consume).toHaveBeenCalledTimes(1);

    onChannelClose?.();
    expect(rabbit.bound).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(channel.consume).toHaveBeenCalledTimes(2);
    expect(rabbit.bound).toBe(true);
    jest.useRealTimers();
  });

  it('consume returns immediately when the service is destroyed mid-bind', async () => {
    jest.useFakeTimers();
    connectMock.mockRejectedValue(new Error('broker down'));
    const rabbit = new RabbitMqService();
    const bound = rabbit.consume('billing.usage', ['document.generated'], jest.fn());
    await rabbit.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    await bound;
    expect(rabbit.bound).toBe(false);
    jest.useRealTimers();
  });
});
