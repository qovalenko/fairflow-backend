import type { Channel, ConsumeMessage } from 'amqplib';
import { consumerDlqTopology } from '@fairflow/shared';
import { RabbitMqConsumer } from './rabbitmq.consumer';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const mockedConnect = connect as jest.Mock;
const topology = consumerDlqTopology('orders.test');

type HandleMessage = (
  channel: Channel,
  topologyArg: typeof topology,
  message: ConsumeMessage | null,
  handler: (payload: Record<string, unknown>, routingKey: string) => Promise<void>,
) => Promise<void>;

function invokeHandleMessage(
  consumer: RabbitMqConsumer,
  channel: Channel,
  message: ConsumeMessage | null,
  handler: (payload: Record<string, unknown>, routingKey: string) => Promise<void>,
): Promise<void> {
  return (consumer as unknown as { handleMessage: HandleMessage }).handleMessage(
    channel,
    topology,
    message,
    handler,
  );
}

function makeMessage(
  payload: unknown,
  headers: Record<string, unknown> = {},
  routingKey = 'crm.contact.updated',
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { routingKey },
    properties: { headers },
  } as ConsumeMessage;
}

function makeChannel() {
  return {
    ack: jest.fn(),
    sendToQueue: jest.fn(),
    publish: jest.fn(),
  } as unknown as Channel;
}

describe('RabbitMqConsumer', () => {
  beforeEach(() => {
    mockedConnect.mockReset();
  });

  it('dlqDepth returns 0 when the DLQ queue is not declared yet', async () => {
    const channel = {
      assertExchange: jest.fn(),
      checkQueue: jest.fn().mockRejectedValue(new Error('NOT_FOUND')),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const consumer = new RabbitMqConsumer();
    await expect(consumer.dlqDepth('orders.final-action')).resolves.toBe(0);
    await consumer.onModuleDestroy();
  });

  it('throws when initial bind fails and maxInitialAttempts is exhausted', async () => {
    mockedConnect.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(
      consumer.consume('orders.test', ['crm.test'], async () => undefined, 2),
    ).rejects.toThrow('broker down');
    await consumer.onModuleDestroy();
  });

  it('onModuleDestroy closes without throwing after a failed connect', async () => {
    mockedConnect.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('handleMessage acks successful handler invocations', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = makeMessage({ projectId: 'p1' });

    await invokeHandleMessage(consumer, channel, message, handler);

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1' }, 'crm.contact.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('handleMessage routes transient failures through the retry ladder', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error('mongo blip'));
    const message = makeMessage({ projectId: 'p1' }, { 'x-retry-count': 0 });

    await invokeHandleMessage(consumer, channel, message, handler);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      topology.retryQueue(0),
      message.content,
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('handleMessage dead-letters after the retry ladder is exhausted', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const message = makeMessage({ projectId: 'p1' }, { 'x-retry-count': topology.maxAttempts });

    await invokeHandleMessage(consumer, channel, message, handler);

    expect(channel.publish).toHaveBeenCalledWith(
      topology.dlqExchange,
      '',
      message.content,
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('handleMessage ignores null deliveries', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn();

    await invokeHandleMessage(consumer, channel, null, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('dlqDepth returns messageCount when DLQ exists', async () => {
    const channel = {
      assertExchange: jest.fn(),
      checkQueue: jest.fn().mockResolvedValue({ messageCount: 5 }),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const consumer = new RabbitMqConsumer();
    await expect(consumer.dlqDepth('orders.final-action')).resolves.toBe(5);
    await consumer.onModuleDestroy();
  });

  it('consume binds subscription on first successful attempt', async () => {
    const consume = jest.fn();
    const channel = {
      assertExchange: jest.fn(),
      assertQueue: jest.fn(),
      bindQueue: jest.fn(),
      consume,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockedConnect.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const consumer = new RabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    await consumer.consume('orders.test', ['crm.test'], handler, 1);
    expect(consume).toHaveBeenCalledWith('orders.test', expect.any(Function));
    await consumer.onModuleDestroy();
  });

  it('handleDrop запускает reconnectLoop после обрыва канала', async () => {
    jest.useFakeTimers();
    const consumer = new RabbitMqConsumer();
    const reconnectLoop = jest
      .spyOn(consumer as unknown as { reconnectLoop(): Promise<void> }, 'reconnectLoop')
      .mockResolvedValue(undefined);
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions.push({
      queueName: 'orders.test',
      routingKeys: ['crm.test'],
      handler: jest.fn(),
    });
    (consumer as unknown as { handleDrop(): void }).handleDrop();
    await Promise.resolve();
    expect(reconnectLoop).toHaveBeenCalled();
    jest.useRealTimers();
    await consumer.onModuleDestroy();
  });

  it('reconnectLoop переподписывает consumer после успешного reconnect', async () => {
    jest.useFakeTimers();
    const bindSubscription = jest
      .spyOn(
        RabbitMqConsumer.prototype as unknown as { bindSubscription(s: unknown): Promise<void> },
        'bindSubscription',
      )
      .mockResolvedValue(undefined);
    const consumer = new RabbitMqConsumer();
    const sub = {
      queueName: 'orders.test',
      routingKeys: ['crm.test'],
      handler: jest.fn(),
    };
    (consumer as unknown as { subscriptions: unknown[] }).subscriptions.push(sub);
    await (consumer as unknown as { reconnectLoop(): Promise<void> }).reconnectLoop();
    expect(bindSubscription).toHaveBeenCalledWith(sub);
    jest.useRealTimers();
    await consumer.onModuleDestroy();
  });

  it('handleDrop не запускает reconnect после destroy', async () => {
    const consumer = new RabbitMqConsumer();
    const reconnectLoop = jest.spyOn(
      consumer as unknown as { reconnectLoop(): Promise<void> },
      'reconnectLoop',
    );
    (consumer as unknown as { destroyed: boolean }).destroyed = true;
    (consumer as unknown as { handleDrop(): void }).handleDrop();
    expect(reconnectLoop).not.toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });
});
