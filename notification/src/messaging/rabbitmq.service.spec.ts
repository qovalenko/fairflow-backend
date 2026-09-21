import type { Channel } from 'amqplib';
import { consumerDlqTopology } from '@fairflow/shared';
import { RabbitMqService } from './rabbitmq.service';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;

function makeChannel() {
  const handlers: Record<string, (msg: unknown) => void> = {};
  return {
    publish: jest.fn(),
    ack: jest.fn(),
    sendToQueue: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_q: string, cb: (msg: unknown) => void) => {
      handlers.consume = cb;
    }),
    on: jest.fn((event: string, cb: (msg: unknown) => void) => {
      handlers[event] = cb;
    }),
    close: jest.fn().mockResolvedValue(undefined),
    handlers,
  };
}

describe('RabbitMqService (notification consumer transport)', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('bound is false until a subscription is live', () => {
    const rabbit = new RabbitMqService();
    expect(rabbit.bound).toBe(false);
  });

  it('publishEnvelope writes a persistent JSON frame with envelope headers', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    await rabbit.publishEnvelope({
      messageId: 'm1',
      type: 'crm.deal.updated',
      projectId: 'p1',
      timestamp: '2026-08-20T10:00:00.000Z',
      source: 'notification',
      version: 1,
      payload: { dealId: 'd1' },
    });
    expect(channel.publish).toHaveBeenCalledWith(
      expect.any(String),
      'crm.deal.updated',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'm1',
        headers: expect.objectContaining({
          'x-project-id': 'p1',
          'x-source': 'notification',
        }),
      }),
    );
  });

  it('handleMessage acks on handler success', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('notification.events', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm1', payload: {} })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.updated' },
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
    expect(handler).toHaveBeenCalledWith(expect.any(Object), 'crm.deal.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage ignores null deliveries', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('notification.events', 'fairflow.events');
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
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('handleMessage routes transient failures through the retry ladder instead of dead-lettering immediately', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('notification.events', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockRejectedValue(new Error('mongo blip'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm2' })),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.updated' },
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

  it('handleMessage dead-letters after retry budget is exhausted', async () => {
    const channel = makeChannel();
    const topology = consumerDlqTopology('notification.events', 'fairflow.events');
    const rabbit = new RabbitMqService();
    const handler = jest.fn().mockRejectedValue(new Error('poison'));
    const message = {
      content: Buffer.from(JSON.stringify({ messageId: 'm3' })),
      properties: { headers: { 'x-retry-count': topology.maxAttempts } },
      fields: { routingKey: 'crm.deal.updated' },
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
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('consume marks bound after initial bind succeeds', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService();
    rabbit.consume('notification.events', ['crm.deal.updated'], jest.fn());
    await new Promise((resolve) => setImmediate(resolve));
    expect(rabbit.bound).toBe(true);
    expect(channel.consume).toHaveBeenCalled();
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
    await rabbit.publishEnvelope({
      messageId: 'm1',
      type: 't',
      timestamp: new Date().toISOString(),
      source: 'notification',
      version: 1,
      payload: {},
    });
    await rabbit.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });
});
