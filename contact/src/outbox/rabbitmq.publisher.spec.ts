import { RabbitMqPublisher } from './rabbitmq.publisher';
import type { EventEnvelope } from '@fairflow/shared';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const mockedConnect = connect as jest.Mock;

function envelope(): EventEnvelope {
  return {
    messageId: 'msg-1',
    type: 'crm.contact.created',
    projectId: 'p1',
    source: 'contact',
    version: 1,
    timestamp: '2026-08-21T10:00:00.000Z',
    payload: { id: 'c1' },
  };
}

describe('RabbitMqPublisher', () => {
  beforeEach(() => {
    mockedConnect.mockReset();
  });

  it('публикует envelope в topic-exchange с persistent и dedup headers', async () => {
    const publish = jest.fn((_ex, _rk, _body, _opts, cb: (err: Error | null) => void) => cb(null));
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    mockedConnect.mockResolvedValue({
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });

    const publisher = new RabbitMqPublisher();
    await publisher.publish(envelope());

    expect(channel.assertExchange).toHaveBeenCalledWith('fairflow.events', 'topic', {
      durable: true,
    });
    expect(publish).toHaveBeenCalledWith(
      'fairflow.events',
      'crm.contact.created',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'msg-1',
        headers: expect.objectContaining({
          'x-project-id': 'p1',
          'x-source': 'contact',
        }),
      }),
      expect.any(Function),
    );
    await publisher.onModuleDestroy();
  });

  it('reject publish оставляет outbox pending (ошибка пробрасывается)', async () => {
    const publish = jest.fn((_ex, _rk, _body, _opts, cb: (err: Error | null) => void) =>
      cb(new Error('nack')),
    );
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    mockedConnect.mockResolvedValue({
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });

    const publisher = new RabbitMqPublisher();
    await expect(publisher.publish(envelope())).rejects.toThrow('nack');
    await publisher.onModuleDestroy();
  });

  it('onModuleDestroy закрывает канал без падения', async () => {
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn((_a, _b, _c, _d, cb: (err: Error | null) => void) => cb(null)),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    mockedConnect.mockResolvedValue({
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    });
    const publisher = new RabbitMqPublisher();
    await publisher.publish(envelope());
    await expect(publisher.onModuleDestroy()).resolves.toBeUndefined();
  });
});
