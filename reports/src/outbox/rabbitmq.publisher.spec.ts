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
      type: 'report.generated',
      source: 'reports',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'p1',
      payload: { reportId: 'r1' },
    };
    await publisher.publish(envelope);
    expect(connect).toHaveBeenCalled();
    expect(assertExchange).toHaveBeenCalledWith(expect.any(String), 'topic', { durable: true });
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      'report.generated',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        messageId: 'msg-1',
        type: 'report.generated',
        headers: expect.objectContaining({
          'x-project-id': 'p1',
          'x-source': 'reports',
        }),
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
        type: 'report.generated',
        source: 'reports',
        version: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    ).rejects.toThrow('nack');
  });

  it('resetOnDisconnect сбрасывает channel — следующий publish переподключается', async () => {
    const envelope: EventEnvelope = {
      messageId: 'm-reconnect',
      type: 'statistics.exported',
      source: 'reports',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    };
    await publisher.publish(envelope);
    expect(connect).toHaveBeenCalledTimes(1);
    (publisher as unknown as { resetOnDisconnect(reason: string): void }).resetOnDisconnect('test');
    await publisher.publish(envelope);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy закрывает channel и connection', async () => {
    await publisher.publish({
      messageId: 'm3',
      type: 'report.generated',
      source: 'reports',
      version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    });
    await publisher.onModuleDestroy();
    expect(closeChannel).toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalled();
  });
});
