import type { Channel } from 'amqplib';
import { consumerDlqTopology } from '@fairflow/shared';
import { RabbitMqConsumer } from './rabbitmq.consumer';

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

describe('RabbitMqConsumer (pipe transport)', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('handleMessage acks on handler success', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('pipe.drift', 'fairflow.events');
    const consumer = new RabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm1', payload: {} })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.contact.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, handler);
    expect(handler).toHaveBeenCalledWith(expect.any(Object), 'crm.contact.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage routes transient failures through the retry ladder', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('pipe.drift', 'fairflow.events');
    const consumer = new RabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('mongo blip'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm2' })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.contact.updated' },
    };
    await (
      consumer as unknown as {
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

  it('handleMessage dead-letters after retry budget is exhausted', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('pipe.drift', 'fairflow.events');
    const consumer = new RabbitMqConsumer();
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm3' })),
      properties: { headers: { 'x-retry-count': topology.maxAttempts } },
      fields: { routingKey: 'crm.company.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, handler);
    expect(channel.publish).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage ignores null deliveries', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('pipe.drift', 'fairflow.events');
    const consumer = new RabbitMqConsumer();
    const handler = jest.fn();
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: null,
          h: typeof handler,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, null, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('onModuleDestroy closes channel and connection best-effort', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const consumer = new RabbitMqConsumer();
    await (consumer as unknown as { getChannel(): Promise<Channel> }).getChannel();
    await consumer.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('consume binds the queue on the first successful attempt', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new RabbitMqConsumer();
    const handler = jest.fn();
    await consumer.consume('pipe.test', ['crm.deal.updated'], handler, 3);
    expect(channel.consume).toHaveBeenCalledWith('pipe.test', expect.any(Function));
  });

  it('consume throws after maxInitialAttempts bind failures', async () => {
    connectMock.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(consumer.consume('pipe.test', ['crm.deal.updated'], jest.fn(), 2)).rejects.toThrow(
      'broker down',
    );
  });

  it('handleMessage retries invalid JSON payloads on the first failure', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('pipe.drift', 'fairflow.events');
    const consumer = new RabbitMqConsumer();
    const message = {
      content: Buffer.from('not-json'),
      properties: { headers: {} },
      fields: { routingKey: 'crm.contact.updated' },
    };
    await (
      consumer as unknown as {
        handleMessage: (
          c: Channel,
          t: typeof topology,
          m: typeof message,
          h: jest.Mock,
        ) => Promise<void>;
      }
    ).handleMessage(channel as unknown as Channel, topology, message, jest.fn());
    expect(channel.sendToQueue).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
  });
});
