import { RabbitMqConsumer } from './rabbitmq.consumer';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const mockedConnect = connect as jest.Mock;

function channelStub(extra: Record<string, unknown> = {}) {
  return {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'q' }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn(),
    consume: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
    publish: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    ...extra,
  };
}

describe('RabbitMqConsumer', () => {
  beforeEach(() => {
    mockedConnect.mockReset();
  });

  it('throws when initial bind fails and maxInitialAttempts is exhausted', async () => {
    mockedConnect.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(
      consumer.consume('contact.test', ['crm.test'], async () => undefined, 2),
    ).rejects.toThrow('broker down');
    await consumer.onModuleDestroy();
  });

  it('onModuleDestroy closes without throwing after a failed connect', async () => {
    mockedConnect.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('acks the message after a successful handler', async () => {
    const ack = jest.fn();
    const channel = channelStub({
      consume: jest.fn((_queue: string, cb: (msg: unknown) => void) => {
        cb({
          content: Buffer.from(JSON.stringify({ type: 'crm.contact.created' })),
          fields: { routingKey: 'crm.contact.created' },
          properties: { headers: {} },
        });
      }),
      ack,
    });
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });

    const handler = jest.fn().mockResolvedValue(undefined);
    const consumer = new RabbitMqConsumer();
    await consumer.consume('contact.events', ['crm.contact.#'], handler, 1);

    expect(handler).toHaveBeenCalledWith({ type: 'crm.contact.created' }, 'crm.contact.created');
    expect(ack).toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });

  it('dead-letters after retry ladder is exhausted', async () => {
    const ack = jest.fn();
    const publish = jest.fn();
    const channel = channelStub({
      consume: jest.fn((_queue: string, cb: (msg: unknown) => void) => {
        cb({
          content: Buffer.from('not-json'),
          fields: { routingKey: 'crm.contact.updated' },
          properties: { headers: { 'x-retry-count': 99 } },
        });
      }),
      ack,
      publish,
    });
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });

    const consumer = new RabbitMqConsumer();
    await consumer.consume('contact.events', ['crm.contact.#'], async () => undefined, 1);

    expect(publish).toHaveBeenCalledWith(
      expect.stringMatching(/dlx/i),
      '',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(ack).toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });

  it('retries handler failure via retry queue before DLQ', async () => {
    const ack = jest.fn();
    const sendToQueue = jest.fn();
    const channel = channelStub({
      consume: jest.fn((_queue: string, cb: (msg: unknown) => void) => {
        cb({
          content: Buffer.from(JSON.stringify({ type: 'crm.contact.updated' })),
          fields: { routingKey: 'crm.contact.updated' },
          properties: { headers: {} },
        });
      }),
      ack,
      sendToQueue,
    });
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });

    const consumer = new RabbitMqConsumer();
    await consumer.consume(
      'contact.events',
      ['crm.contact.#'],
      async () => {
        throw new Error('handler boom');
      },
      1,
    );

    expect(sendToQueue).toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });
});
