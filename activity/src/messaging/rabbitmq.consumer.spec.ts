import { consumerDlqTopology } from '@fairflow/shared';
import type { Channel, ConsumeMessage } from 'amqplib';
import { RabbitMqConsumer } from './rabbitmq.consumer';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;

function makeAmqpChannel() {
  return {
    ack: jest.fn(),
    sendToQueue: jest.fn(),
    publish: jest.fn(),
    consume: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'q' }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('RabbitMqConsumer transport lifecycle', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('consume биндит очередь и вызывает handler при доставке', async () => {
    const channel = makeAmqpChannel();
    let capturedHandler: ((msg: ConsumeMessage | null) => void) | undefined;
    channel.consume.mockImplementation(async (_q: string, cb: typeof capturedHandler) => {
      capturedHandler = cb;
    });
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const consumer = new RabbitMqConsumer();
    const handler = jest.fn().mockResolvedValue(undefined);
    await consumer.consume('activity.test', ['crm.activity.updated'], handler);

    expect(channel.consume).toHaveBeenCalledWith('activity.test', expect.any(Function));
    const message = {
      content: Buffer.from(JSON.stringify({ projectId: 'p1' })),
      fields: { routingKey: 'crm.activity.updated' },
      properties: { headers: {} },
    } as ConsumeMessage;
    await capturedHandler!(message);
    expect(handler).toHaveBeenCalledWith({ projectId: 'p1' }, 'crm.activity.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
    await consumer.onModuleDestroy();
  });

  it('consume бросает после исчерпания maxInitialAttempts', async () => {
    connectMock.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    await expect(
      consumer.consume('activity.test', ['crm.test'], async () => undefined, 2),
    ).rejects.toThrow('broker down');
    await consumer.onModuleDestroy();
  });

  it('getChannel переиспользует открытый channel', async () => {
    const channel = makeAmqpChannel();
    const createChannel = jest.fn().mockResolvedValue(channel);
    connectMock.mockResolvedValue({
      createChannel,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const consumer = new RabbitMqConsumer();
    const getChannel = (consumer as unknown as { getChannel(): Promise<Channel> }).getChannel.bind(
      consumer,
    );
    await getChannel();
    await getChannel();
    expect(createChannel).toHaveBeenCalledTimes(1);
    await consumer.onModuleDestroy();
  });

  it('handleDrop переподписывает consumer после обрыва соединения', async () => {
    jest.useFakeTimers();
    const channel = makeAmqpChannel();
    channel.consume.mockResolvedValue(undefined);
    const connectionHandlers: Record<string, () => void> = {};
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn((event: string, cb: () => void) => {
        connectionHandlers[event] = cb;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const consumer = new RabbitMqConsumer();
    await consumer.consume('activity.test', ['crm.activity.updated'], async () => undefined, 1);
    expect(channel.consume).toHaveBeenCalledTimes(1);

    connectionHandlers.close();
    await jest.runOnlyPendingTimersAsync();

    expect(channel.consume).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
    await consumer.onModuleDestroy();
  });

  it('handleDrop игнорирует обрыв без активных подписок', async () => {
    const consumer = new RabbitMqConsumer();
    const bindSubscription = jest.spyOn(
      consumer as unknown as { bindSubscription: () => Promise<void> },
      'bindSubscription',
    );
    (consumer as unknown as { handleDrop: () => void }).handleDrop();
    expect(bindSubscription).not.toHaveBeenCalled();
  });

  it('consume прекращает retry если consumer уничтожен', async () => {
    jest.useFakeTimers();
    connectMock.mockRejectedValue(new Error('broker down'));
    const consumer = new RabbitMqConsumer();
    const consumePromise = consumer.consume(
      'activity.test',
      ['crm.test'],
      async () => undefined,
      Infinity,
    );
    await jest.advanceTimersByTimeAsync(1);
    await consumer.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await expect(consumePromise).resolves.toBeUndefined();
    expect((consumer as unknown as { destroyed: boolean }).destroyed).toBe(true);
    jest.useRealTimers();
  });
});

describe('RabbitMqConsumer handleMessage', () => {
  const topology = consumerDlqTopology('activity.test');

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
    routingKey = 'crm.deal.updated',
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

  it('ignores null deliveries', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn();

    await invokeHandleMessage(consumer, channel, null, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('acks successful handler invocations', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn().mockResolvedValue(undefined);
    const message = makeMessage({ projectId: 'p1' });

    await invokeHandleMessage(consumer, channel, message, handler);

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1' }, 'crm.deal.updated');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it('routes failed messages to the retry queue while attempts remain', async () => {
    const consumer = new RabbitMqConsumer();
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
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

  it('dead-letters after the retry ladder is exhausted', async () => {
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

  it('onModuleDestroy closes open connections safely', async () => {
    const consumer = new RabbitMqConsumer();
    (consumer as unknown as { channel: { close: jest.Mock } }).channel = {
      close: jest.fn().mockResolvedValue(undefined),
    };
    (consumer as unknown as { connection: { close: jest.Mock } }).connection = {
      close: jest.fn().mockResolvedValue(undefined),
    };

    await consumer.onModuleDestroy();

    expect((consumer as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
