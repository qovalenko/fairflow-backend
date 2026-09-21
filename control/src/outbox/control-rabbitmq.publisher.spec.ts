import { OUTBOX_EXCHANGE } from '@fairflow/shared';

const connect = jest.fn();
const createConfirmChannel = jest.fn();
const publish = jest.fn();

jest.mock('amqplib', () => ({
  connect: (...args: unknown[]) => connect(...args),
}));

import { ControlRabbitMqPublisher } from './control-rabbitmq.publisher';

describe('ControlRabbitMqPublisher', () => {
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
    connect.mockResolvedValue(connection);
    publish.mockImplementation(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: (err?: Error) => void) => cb(),
    );
  });

  it('publishes envelope to the durable topic exchange with broker metadata', async () => {
    const publisher = new ControlRabbitMqPublisher();
    const envelope = {
      type: 'control.role.changed',
      messageId: 'msg-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'control',
      version: '1',
      idempotencyKey: 'idem-1',
      payload: { action: 'role.updated' },
    };

    await publisher.publish(envelope as never);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      OUTBOX_EXCHANGE,
      'control.role.changed',
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'msg-1',
        correlationId: 'idem-1',
        headers: expect.objectContaining({
          'x-project-id': 'proj-1',
          'x-source': 'control',
          'x-version': '1',
        }),
      }),
      expect.any(Function),
    );
    expect(JSON.parse(publish.mock.calls[0][2].toString())).toEqual(envelope);
  });

  it('closes cached channel and connection on destroy', async () => {
    const publisher = new ControlRabbitMqPublisher();
    await publisher.publish({
      type: 'control.org.changed',
      messageId: 'msg-2',
      timestamp: '2026-01-01T00:00:00.000Z',
      projectId: 'proj-1',
      source: 'control',
      version: '1',
      idempotencyKey: 'idem-2',
      payload: {},
    } as never);

    const connection = await connect.mock.results[0].value;
    const channel = await createConfirmChannel.mock.results[0].value;

    await publisher.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });
});
