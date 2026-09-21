import type { Channel } from 'amqplib';
import { busConsumerTopology } from '@fairflow/shared';
import { ReportsRabbitMqConsumer } from './rabbitmq-consumer.service';

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

describe('ReportsRabbitMqConsumer', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('handleMessage ack при успешном handler', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('reports.rollup', 'fairflow.events');
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm1', payload: {} })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.created' },
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
    expect(handler).toHaveBeenCalledWith(expect.any(Object), 'crm.deal.created');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage retry ladder при transient failure', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('reports.rollup', 'fairflow.events');
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('mongo blip'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm2' })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.created' },
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

  it('handleMessage dead-letter после исчерпания retry budget', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('reports.rollup', 'fairflow.events');
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm3' })),
      properties: { headers: { 'x-retry-count': topology.maxAttempts } },
      fields: { routingKey: 'crm.deal.stage_changed' },
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

  it('handleMessage игнорирует null delivery', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('reports.rollup', 'fairflow.events');
    const consumer = new ReportsRabbitMqConsumer();
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

  it('onModuleDestroy закрывает channel и connection', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const consumer = new ReportsRabbitMqConsumer();
    await (consumer as unknown as { getChannel(): Promise<Channel> }).getChannel();
    await consumer.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('consume не дублирует подписку с тем же queueName', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    await consumer.consume('reports.rollup', ['crm.deal.created'], handler);
    await consumer.consume('reports.rollup', ['crm.deal.created'], handler);
    const subs = (consumer as unknown as { subscriptions: unknown[] }).subscriptions;
    expect(subs).toHaveLength(1);
    expect(channel.bindQueue).toHaveBeenCalled();
  });

  it('handleMessage восстанавливает original routing key из retry headers', async () => {
    const channel = makeChannel();
    const topology = busConsumerTopology('reports.rollup', 'fairflow.events');
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm4' })),
      properties: { headers: { 'x-original-routing-key': 'crm.deal.updated' } },
      fields: { routingKey: 'reports.rollup.retry.1' },
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
    expect(handler).toHaveBeenCalledWith(expect.any(Object), 'crm.deal.updated');
  });

  it('onDisconnect планирует reconnect и переигрывает подписки', async () => {
    jest.useFakeTimers();
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new ReportsRabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    await consumer.consume('reports.rollup', ['crm.deal.created'], handler);
    expect(channel.consume).toHaveBeenCalledTimes(1);
    (consumer as unknown as { onDisconnect(reason: string): void }).onDisconnect('test');
    await jest.runOnlyPendingTimersAsync();
    expect(connectMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(channel.consume.mock.calls.length).toBeGreaterThanOrEqual(2);
    jest.useRealTimers();
  });
});
