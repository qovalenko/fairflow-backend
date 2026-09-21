import { consumerDlqTopology } from '@fairflow/shared';
import { DeadLetterCounter } from './dead-letter.counter';
import { RabbitMqService } from './rabbitmq.service';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

import { connect } from 'amqplib';

const connectMock = connect as jest.Mock;

const PID = 'proj-1';
const TOPOLOGY = consumerDlqTopology('search.projection');

function envelope(id = 'm1') {
  return JSON.stringify({
    messageId: id,
    type: 'crm.deal.updated',
    projectId: PID,
    timestamp: new Date().toISOString(),
    payload: { dealId: 'd1' },
  });
}

function message(content: string, headers: Record<string, unknown> = {}) {
  return {
    content: Buffer.from(content),
    properties: { headers },
    fields: { routingKey: 'crm.deal.updated' },
  };
}

describe('RabbitMqService.handleMessage', () => {
  let rabbit: RabbitMqService;
  let handleMessage: (
    c: unknown,
    t: unknown,
    m: unknown,
    h: (e: unknown) => Promise<unknown>,
  ) => Promise<void>;

  const counter = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    rabbit = new RabbitMqService(counter as unknown as DeadLetterCounter);
    handleMessage = (
      rabbit as unknown as {
        handleMessage: typeof handleMessage;
      }
    ).handleMessage.bind(rabbit);
  });

  it('dead-letters unparseable frames and records the drop', async () => {
    const channel = { publish: jest.fn(), ack: jest.fn() };

    await handleMessage(channel, TOPOLOGY, message('}{'), jest.fn());

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(counter.record).toHaveBeenCalledTimes(1);
  });

  it('acks when the handler returns ack', async () => {
    const channel = { ack: jest.fn(), nack: jest.fn(), publish: jest.fn(), sendToQueue: jest.fn() };
    const handler = jest.fn().mockResolvedValue('ack');

    await handleMessage(channel, TOPOLOGY, message(envelope()), handler);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        routingKey: 'crm.deal.updated',
        envelope: expect.objectContaining({ projectId: PID }),
      }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('nacks with requeue when the handler asks for an immediate retry', async () => {
    const channel = { ack: jest.fn(), nack: jest.fn(), publish: jest.fn(), sendToQueue: jest.fn() };
    const handler = jest.fn().mockResolvedValue({ nack: true, requeue: true });

    await handleMessage(channel, TOPOLOGY, message(envelope()), handler);

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  it('climbs the retry ladder when the handler rejects without requeue', async () => {
    const channel = {
      ack: jest.fn(),
      nack: jest.fn(),
      publish: jest.fn(),
      sendToQueue: jest.fn(),
    };
    const handler = jest.fn().mockResolvedValue({ nack: true, requeue: false });

    await handleMessage(channel, TOPOLOGY, message(envelope()), handler);

    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('climbs the retry ladder when the handler throws', async () => {
    const channel = {
      ack: jest.fn(),
      nack: jest.fn(),
      publish: jest.fn(),
      sendToQueue: jest.fn(),
    };
    const handler = jest.fn().mockRejectedValue(new Error('store blip'));

    await handleMessage(channel, TOPOLOGY, message(envelope()), handler);

    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('ignores a null delivery without touching the channel', async () => {
    const channel = { ack: jest.fn(), nack: jest.fn(), publish: jest.fn(), sendToQueue: jest.fn() };

    await handleMessage(channel, TOPOLOGY, null, jest.fn());

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('dead-letters after the retry budget is exhausted', async () => {
    const channel = {
      ack: jest.fn(),
      nack: jest.fn(),
      publish: jest.fn(),
      sendToQueue: jest.fn(),
    };
    const handler = jest.fn().mockResolvedValue({ nack: true, requeue: false });
    const exhausted = message(envelope(), { 'x-retry-count': TOPOLOGY.maxAttempts });

    await handleMessage(channel, TOPOLOGY, exhausted, handler);

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(counter.record).toHaveBeenCalledTimes(1);
  });

  it('recovers the original routing key from retry headers on a retry hop', async () => {
    const channel = { ack: jest.fn(), nack: jest.fn(), publish: jest.fn(), sendToQueue: jest.fn() };
    const handler = jest.fn().mockResolvedValue('ack');
    const retryHop = message(envelope(), {
      'x-original-routing-key': 'crm.contact.updated',
      'x-retry-count': 1,
    });
    retryHop.fields.routingKey = 'search.projection.retry.0';

    await handleMessage(channel, TOPOLOGY, retryHop, handler);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ routingKey: 'crm.contact.updated' }),
    );
  });
});

function makeChannel() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    publish: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_q: string, cb: (msg: unknown) => void) => {
      handlers.consume = cb;
    }),
    on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
    }),
    close: jest.fn().mockResolvedValue(undefined),
    handlers,
  };
}

describe('RabbitMqService.consumeEvents', () => {
  const counter = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    connectMock.mockReset();
    delete process.env.RABBITMQ_RECONNECT_MS;
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it('binds the consumer queue and remembers the subscription for reconnect', async () => {
    const channel = makeChannel();
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const rabbit = new RabbitMqService(counter as unknown as DeadLetterCounter);
    const handler = jest.fn().mockResolvedValue('ack');

    await rabbit.consumeEvents('search.projection', ['crm.deal.updated'], handler, 5);

    expect(channel.prefetch).toHaveBeenCalledWith(5);
    expect(channel.consume).toHaveBeenCalledWith('search.projection', expect.any(Function));
  });

  it('onModuleDestroy closes the channel and suppresses reconnect scheduling', async () => {
    const channel = makeChannel();
    const connection = { close: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connection.close,
    });
    const rabbit = new RabbitMqService(counter as unknown as DeadLetterCounter);
    await rabbit.consumeEvents('search.projection', ['crm.deal.updated'], jest.fn(), 1);
    await rabbit.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('schedules a reconnect when the broker connection drops', async () => {
    jest.useFakeTimers();
    process.env.RABBITMQ_RECONNECT_MS = '100';
    const channel = makeChannel();
    const connectionHandlers: Record<string, (arg?: unknown) => void> = {};
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
        connectionHandlers[event] = cb;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    connectMock
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({
        createChannel: jest.fn().mockResolvedValue(makeChannel()),
        on: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      });
    const rabbit = new RabbitMqService(counter as unknown as DeadLetterCounter);
    await rabbit.consumeEvents('search.projection', ['crm.deal.updated'], jest.fn(), 1);

    connectionHandlers.close?.();
    await jest.advanceTimersByTimeAsync(100);

    expect(connectMock).toHaveBeenCalledTimes(2);
    await rabbit.onModuleDestroy();
  });
});
