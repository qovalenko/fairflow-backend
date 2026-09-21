const publish = jest.fn(
  (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) => cb(),
);
const assertExchange = jest.fn(async () => undefined);
const closeChannel = jest.fn(async () => undefined);
const closeConnection = jest.fn(async () => undefined);
const createConfirmChannel = jest.fn(async () => ({
  assertExchange,
  publish,
  close: closeChannel,
  on: jest.fn(),
}));
const connect = jest.fn(async () => ({
  createConfirmChannel,
  close: closeConnection,
  on: jest.fn(),
}));

jest.mock('amqplib', () => ({ connect }));

import type { EventEnvelope } from '@fairflow/shared';
import { RabbitMqPublisher } from './rabbitmq.publisher';

describe('RabbitMqPublisher', () => {
  let publisher: RabbitMqPublisher;

  beforeEach(() => {
    publish.mockClear();
    connect.mockClear();
    closeChannel.mockClear();
    closeConnection.mockClear();
    publisher = new RabbitMqPublisher();
  });

  it('publish сериализует envelope и шлёт в topic exchange', async () => {
    const envelope: EventEnvelope = {
      messageId: 'msg-1',
      type: 'crm.order.created',
      source: 'orders',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'p1',
      payload: { orderId: 'o1' },
    };
    await publisher.publish(envelope);
    expect(connect).toHaveBeenCalled();
    expect(assertExchange).toHaveBeenCalledWith(expect.any(String), 'topic', { durable: true });
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      'crm.order.created',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        messageId: 'msg-1',
        type: 'crm.order.created',
        headers: expect.objectContaining({ 'x-project-id': 'p1', 'x-source': 'orders' }),
      }),
      expect.any(Function),
    );
  });

  it('publish пробрасывает ошибку confirm callback', async () => {
    publish.mockImplementationOnce(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) =>
        cb(new Error('nack')),
    );
    await expect(
      publisher.publish({
        messageId: 'm2',
        type: 'crm.order.created',
        source: 'orders',
        version: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    ).rejects.toThrow('nack');
  });

  it('onModuleDestroy закрывает channel и connection', async () => {
    await publisher.publish({
      messageId: 'm3',
      type: 'crm.order.created',
      source: 'orders',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    await publisher.onModuleDestroy();
    expect(closeChannel).toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalled();
  });
});
