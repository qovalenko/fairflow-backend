jest.mock('amqplib', () => ({ connect: jest.fn() }));

import { connect } from 'amqplib';
import { AuthBusPublisherService } from './auth-bus-publisher.service';

describe('AuthBusPublisherService', () => {
  const enabledFlag = process.env.AUTH_EVENTS_ENABLED;
  const urlFlag = process.env.RABBITMQ_URL;
  const exchangeFlag = process.env.RABBITMQ_EXCHANGE;

  afterEach(async () => {
    if (enabledFlag === undefined) delete process.env.AUTH_EVENTS_ENABLED;
    else process.env.AUTH_EVENTS_ENABLED = enabledFlag;
    if (urlFlag === undefined) delete process.env.RABBITMQ_URL;
    else process.env.RABBITMQ_URL = urlFlag;
    if (exchangeFlag === undefined) delete process.env.RABBITMQ_EXCHANGE;
    else process.env.RABBITMQ_EXCHANGE = exchangeFlag;
    jest.clearAllMocks();
  });

  const intent = {
    type: 'gateway.auth.password_changed',
    source: 'auth' as const,
    userId: 'u1',
    actorType: 'user' as const,
    subject: 'user/u1',
    idempotencyKey: 'k1',
    payload: { userId: 'u1' },
  };

  it('no-ops when AUTH_EVENTS_ENABLED=false (broker never contacted)', async () => {
    process.env.AUTH_EVENTS_ENABLED = 'false';
    const svc = new AuthBusPublisherService();
    await svc.publish(intent);
    expect(connect).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('publishes a durable topic message when the broker is reachable', async () => {
    process.env.AUTH_EVENTS_ENABLED = 'true';
    const publish = jest.fn().mockReturnValue(true);
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new AuthBusPublisherService();
    await svc.publish(intent);

    expect(connect).toHaveBeenCalled();
    expect(channel.assertExchange).toHaveBeenCalledWith(expect.any(String), 'topic', {
      durable: true,
    });
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      intent.type,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true, contentType: 'application/json' }),
    );
    await svc.onModuleDestroy();
  });

  it('swallows broker connection failures without throwing', async () => {
    process.env.AUTH_EVENTS_ENABLED = 'true';
    (connect as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new AuthBusPublisherService();
    await expect(svc.publish(intent)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('swallows publish failures after the channel is open', async () => {
    process.env.AUTH_EVENTS_ENABLED = 'true';
    const publish = jest.fn().mockImplementation(() => {
      throw new Error('channel closed');
    });
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new AuthBusPublisherService();
    await expect(svc.publish(intent)).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('onModuleDestroy closes channel and connection', async () => {
    process.env.AUTH_EVENTS_ENABLED = 'true';
    const channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn(),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new AuthBusPublisherService();
    await svc.publish(intent);
    await svc.onModuleDestroy();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });
});
