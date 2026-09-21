const publish = jest.fn((_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) =>
  cb(),
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
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { conversationId: 'c1' },
    };
    await publisher.publish(envelope);
    expect(connect).toHaveBeenCalled();
    expect(assertExchange).toHaveBeenCalledWith(expect.any(String), 'topic', { durable: true });
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      'chat.message.created',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        messageId: 'msg-1',
        type: 'chat.message.created',
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
        type: 'chat.message.created',
        source: 'chat',
        version: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    ).rejects.toThrow('nack');
  });

  it('onModuleDestroy закрывает channel и connection', async () => {
    await publisher.publish({
      messageId: 'm3',
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    await publisher.onModuleDestroy();
    expect(closeChannel).toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalled();
  });

  it('сбрасывает channel и connection при channel close', async () => {
    let channelHandlers: Record<string, () => void> = {};
    createConfirmChannel.mockImplementationOnce(async () => ({
      assertExchange,
      publish,
      close: closeChannel,
      on: jest.fn((event: string, cb: () => void) => {
        channelHandlers[event] = cb;
      }),
    }));
    await publisher.publish({
      messageId: 'm-close',
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    expect(connect).toHaveBeenCalledTimes(1);
    channelHandlers.close?.();
    await publisher.publish({
      messageId: 'm-reconnect',
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('сбрасывает channel при connection error и переподключается', async () => {
    let connHandlers: Record<string, () => void> = {};
    connect.mockImplementationOnce(async () => ({
      createConfirmChannel,
      close: closeConnection,
      on: jest.fn((event: string, cb: () => void) => {
        connHandlers[event] = cb;
      }),
    }));
    await publisher.publish({
      messageId: 'm4',
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    expect(connect).toHaveBeenCalledTimes(1);
    connHandlers.error?.();
    await publisher.publish({
      messageId: 'm5',
      type: 'chat.message.created',
      source: 'chat',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
