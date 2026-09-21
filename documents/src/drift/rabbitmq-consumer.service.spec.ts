import type { Channel } from 'amqplib';
import { busConsumerTopology } from '@fairflow/shared';
import { DriftRabbitMqConsumer } from './rabbitmq-consumer.service';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;

function makeChannel() {
  return {
    publish: jest.fn(),
    ack: jest.fn(),
    sendToQueue: jest.fn(),
    consume: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'q' }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DriftRabbitMqConsumer bind failure', () => {
  it('scheduleReconnectAfterBindFailure schedules a reconnect when subscriptions exist', () => {
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'q', routingKeys: ['k'], handler: jest.fn() },
    ];
    const spy = jest.spyOn(
      consumer as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );
    consumer.scheduleReconnectAfterBindFailure();
    expect(spy).toHaveBeenCalled();
  });

  it('does not arm a reconnect timer when there are no subscriptions', () => {
    const consumer = new DriftRabbitMqConsumer();
    consumer.scheduleReconnectAfterBindFailure();
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  });
});

describe('DriftRabbitMqConsumer message handling', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('acks the delivery after a successful handler', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('documents.drift', 'fairflow.events');
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ projectId: 'p1', payload: {} })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.contact.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          h: typeof handler,
          m: typeof message,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, handler, message);
    expect(handler).toHaveBeenCalledWith(expect.any(Object), 'crm.contact.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('routes transient handler failures through the retry ladder', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('documents.drift', 'fairflow.events');
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('mongo blip'));
    const message = {
      content: Buffer.from(JSON.stringify({ projectId: 'p1' })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          h: typeof handler,
          m: typeof message,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, handler, message);
    expect(channel.sendToQueue).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('dead-letters after the retry budget is exhausted', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('documents.drift', 'fairflow.events');
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const message = {
      content: Buffer.from(JSON.stringify({ projectId: 'p1' })),
      properties: { headers: { 'x-retry-count': topology.maxAttempts } },
      fields: { routingKey: 'crm.order.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          h: typeof handler,
          m: typeof message,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, handler, message);
    expect(channel.publish).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('ignores null deliveries', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('documents.drift', 'fairflow.events');
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn();
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          h: typeof handler,
          m: null,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, handler, null);
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('onModuleDestroy closes channel and connection', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const consumer = new DriftRabbitMqConsumer();
    await (consumer as unknown as { getChannel(): Promise<Channel> }).getChannel();
    await consumer.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('wires connection close handlers that schedule reconnect', async () => {
    jest.useFakeTimers();
    const handlers: Record<string, () => void> = {};
    const channel = {
      ...makeChannel(),
      on: jest.fn((event: string, cb: () => void) => {
        handlers[`channel:${event}`] = cb;
      }),
    };
    const connection = {
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, cb: () => void) => {
        handlers[`connection:${event}`] = cb;
      }),
    };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: connection.on,
      close: connection.close,
    });
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'q', routingKeys: ['k'], handler: jest.fn() },
    ];
    await (consumer as unknown as { getChannel(): Promise<Channel> }).getChannel();
    handlers['connection:close']();
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();
    jest.useRealTimers();
  });

  it('onDisconnect is ignored while the consumer is shutting down', () => {
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { closing: boolean }).closing = true;
    (consumer as unknown as { channel: unknown }).channel = { close: jest.fn() };
    (consumer as unknown as { connection: unknown }).connection = { close: jest.fn() };
    (consumer as unknown as { onDisconnect(reason: string): void }).onDisconnect('connection closed');
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  });

  it('onModuleDestroy clears a pending reconnect timer', async () => {
    jest.useFakeTimers();
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'q', routingKeys: ['k'], handler: jest.fn() },
    ];
    consumer.scheduleReconnectAfterBindFailure();
    await consumer.onModuleDestroy();
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
    jest.useRealTimers();
  });
});

describe('DriftRabbitMqConsumer consume and reconnect', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('consume registers a durable subscription and starts consuming', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn();
    await consumer.consume('documents.drift', ['crm.deal.updated'], handler);
    expect(channel.consume).toHaveBeenCalledWith('documents.drift', expect.any(Function));
    expect((consumer as unknown as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
  });

  it('does not duplicate subscription entries for the same queue name', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new DriftRabbitMqConsumer();
    const handler = jest.fn();
    await consumer.consume('documents.drift', ['crm.deal.updated'], handler);
    await consumer.consume('documents.drift', ['crm.order.updated'], handler);
    expect((consumer as unknown as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
    expect(channel.consume).toHaveBeenCalled();
  });

  it('onDisconnect closes the old socket and schedules reconnect', () => {
    jest.useFakeTimers();
    const consumer = new DriftRabbitMqConsumer();
    const channel = { close: jest.fn().mockResolvedValue(undefined) };
    const connection = { close: jest.fn().mockResolvedValue(undefined) };
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'q', routingKeys: ['k'], handler: jest.fn() },
    ];
    (consumer as unknown as { channel: unknown }).channel = channel;
    (consumer as unknown as { connection: unknown }).connection = connection;
    (consumer as unknown as { onDisconnect(reason: string): void }).onDisconnect('connection closed');
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();
    jest.useRealTimers();
  });

  it('replays subscriptions after a successful reconnect', async () => {
    jest.useFakeTimers();
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'documents.drift', routingKeys: ['crm.deal.updated'], handler: jest.fn() },
    ];
    const reconnectPromise = (
      consumer as unknown as { reconnect(): Promise<void> }
    ).reconnect();
    await reconnectPromise;
    expect(channel.consume).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('schedules another reconnect when replay fails', async () => {
    jest.useFakeTimers();
    const consumer = new DriftRabbitMqConsumer();
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions = [
      { queueName: 'q', routingKeys: ['k'], handler: jest.fn() },
    ];
    jest
      .spyOn(consumer as unknown as { bind(): Promise<void> }, 'bind')
      .mockRejectedValueOnce(new Error('broker down'));
    await (consumer as unknown as { reconnect(): Promise<void> }).reconnect();
    expect((consumer as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();
    jest.useRealTimers();
  });
});
