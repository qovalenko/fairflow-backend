import { OUTBOX_EXCHANGE } from '@fairflow/shared';
import { RabbitMqPublisher } from './rabbitmq.publisher';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;
const createConfirmChannel = jest.fn();
const publish = jest.fn();

describe('RabbitMqPublisher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createConfirmChannel: createConfirmChannel.mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    connectMock.mockResolvedValue(connection);
    publish.mockImplementation(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) =>
        cb(),
    );
  });

  it('publishes envelope to the durable topic exchange with broker metadata', async () => {
    const publisher = new RabbitMqPublisher();
    const envelope = {
      type: 'document.drift_detected',
      messageId: 'msg-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-1',
      payload: { groupId: 'g-1' },
    };

    await publisher.publish(envelope as never);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      OUTBOX_EXCHANGE,
      'document.drift_detected',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'msg-1',
        correlationId: 'idem-1',
        headers: expect.objectContaining({
          'x-project-id': 'proj-1',
          'x-source': 'documents',
          'x-version': '1',
        }),
      }),
      expect.any(Function),
    );
    expect(JSON.parse(publish.mock.calls[0][2].toString())).toEqual(envelope);
  });

  it('rejects when the broker nacks the publish', async () => {
    publish.mockImplementation(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) =>
        cb(new Error('nack')),
    );
    const publisher = new RabbitMqPublisher();
    await expect(
      publisher.publish({
        type: 'document.template_published',
        messageId: 'msg-2',
        timestamp: '2026-01-01T00:00:00.000Z',
        projectId: 'proj-1',
        source: 'documents',
        version: '1',
        idempotencyKey: 'idem-2',
        payload: {},
      } as never),
    ).rejects.toThrow('nack');
  });

  it('closes cached channel and connection on destroy', async () => {
    const publisher = new RabbitMqPublisher();
    await publisher.publish({
      type: 'document.drift_detected',
      messageId: 'msg-3',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-3',
      payload: {},
    } as never);

    const connection = await connectMock.mock.results[0].value;
    const channel = await createConfirmChannel.mock.results[0].value;

    await publisher.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('reuses the cached confirm channel across publishes', async () => {
    const publisher = new RabbitMqPublisher();
    await publisher.publish({
      type: 'document.drift_detected',
      messageId: 'msg-4',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-4',
      payload: {},
    } as never);
    await publisher.publish({
      type: 'document.drift_detected',
      messageId: 'msg-5',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-5',
      payload: {},
    } as never);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('drops the cached channel when the broker connection closes', async () => {
    const handlers: Record<string, () => void> = {};
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      on: jest.fn((event: string, cb: () => void) => {
        handlers[`channel:${event}`] = cb;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn((event: string, cb: () => void) => {
        handlers[`connection:${event}`] = cb;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    connectMock.mockResolvedValue(connection);
    const publisher = new RabbitMqPublisher();
    await publisher.publish({
      type: 'document.drift_detected',
      messageId: 'msg-6',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-6',
      payload: {},
    } as never);
    handlers['connection:close']();
    await publisher.publish({
      type: 'document.drift_detected',
      messageId: 'msg-7',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'documents',
      version: '1',
      idempotencyKey: 'idem-7',
      payload: {},
    } as never);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy is safe when no channel was opened', async () => {
    const publisher = new RabbitMqPublisher();
    await expect(publisher.onModuleDestroy()).resolves.toBeUndefined();
  });
});
