jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    assertConsumerTopology: jest.fn((...args: unknown[]) => actual.assertConsumerTopology(...args)),
  };
});

jest.mock('amqplib', () => ({ connect: jest.fn() }));

import type { ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { assertConsumerTopology, consumerDlqTopology, readRetryCount } from '@fairflow/shared';
import { RabbitMqService } from './rabbitmq.service';

const assertConsumerTopologyMock = assertConsumerTopology as jest.MockedFunction<typeof assertConsumerTopology>;

function makeMessage(
  payload: Record<string, unknown>,
  opts: { headers?: Record<string, unknown>; redelivered?: boolean; routingKey?: string } = {},
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { redelivered: opts.redelivered ?? false, routingKey: opts.routingKey ?? 'crm.deal.updated' },
    properties: { headers: opts.headers ?? {} },
  } as ConsumeMessage;
}

describe('RabbitMqService consumer', () => {
  let handler: jest.Mock;
  let observer: { onConsumed?: jest.Mock; onDeadLettered?: jest.Mock; onBound?: jest.Mock };
  let deliver: (msg: ConsumeMessage | null) => Promise<void>;
  const channel = {
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn(),
    assertQueue: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    checkQueue: jest.fn().mockResolvedValue({ messageCount: 7 }),
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
    publish: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    assertConsumerTopologyMock.mockImplementation(
      jest.requireActual('@fairflow/shared').assertConsumerTopology,
    );
    handler = jest.fn().mockResolvedValue(undefined);
    observer = {
      onConsumed: jest.fn(),
      onDeadLettered: jest.fn(),
      onBound: jest.fn(),
    };
    (connect as jest.Mock).mockResolvedValue(connection);
    channel.consume.mockImplementation(async (_queue: string, cb: (msg: ConsumeMessage | null) => void) => {
      deliver = (msg) => cb(msg) as unknown as Promise<void>;
    });
  });

  it('acks successful deliveries and records ok consumption', async () => {
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);
    await deliver!(makeMessage({ type: 'crm.deal.updated', projectId: 'p1' }));

    expect(handler).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalled();
    expect(observer.onConsumed).toHaveBeenCalledWith('ok');
    expect(observer.onBound).toHaveBeenCalled();
  });

  it('routes failed messages to retry queues while attempts remain', async () => {
    handler.mockRejectedValueOnce(new Error('append failed'));
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);
    const topology = consumerDlqTopology('audit.events');

    await deliver!(makeMessage({ type: 'crm.deal.updated' }, { headers: { 'x-retry-count': 0 } }));

    expect(observer.onConsumed).toHaveBeenCalledWith('error');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      topology.retryQueue(0),
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalled();
    expect(observer.onDeadLettered).not.toHaveBeenCalled();
  });

  it('dead-letters after retry budget is exhausted', async () => {
    handler.mockRejectedValueOnce(new Error('still failing'));
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);
    const topology = consumerDlqTopology('audit.events');
    const attempt = readRetryCount({ 'x-retry-count': topology.maxAttempts });

    await deliver!(makeMessage({ type: 'crm.deal.updated' }, { headers: { 'x-retry-count': attempt } }));

    expect(channel.publish).toHaveBeenCalledWith(
      topology.dlqExchange,
      '',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(observer.onDeadLettered).toHaveBeenCalled();
  });

  it('falls back to legacy requeue-once behaviour when DLQ topology cannot be asserted', async () => {
    assertConsumerTopologyMock.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
    handler.mockRejectedValueOnce(new Error('legacy fail'));
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);

    await deliver!(makeMessage({ type: 'crm.deal.updated' }, { redelivered: false }));

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(observer.onDeadLettered).not.toHaveBeenCalled();
  });

  it('legacy path dead-letters on the second failure (no infinite requeue)', async () => {
    assertConsumerTopologyMock.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
    handler.mockRejectedValueOnce(new Error('legacy fail'));
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);

    await deliver!(makeMessage({ type: 'crm.deal.updated' }, { redelivered: true }));

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(observer.onDeadLettered).toHaveBeenCalled();
  });

  it('ignores null deliveries without invoking the handler', async () => {
    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);

    await deliver!(null);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });
});

describe('RabbitMqService resilience', () => {
  let handler: jest.Mock;
  let observer: { onConsumed?: jest.Mock; onDeadLettered?: jest.Mock; onBound?: jest.Mock };

  function makeChannel() {
    return {
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue({}),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      assertExchange: jest.fn().mockResolvedValue(undefined),
      checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn(),
      publish: jest.fn(),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  function makeConnection(channel: ReturnType<typeof makeChannel>, onClose?: (cb: () => void) => void) {
    return {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'close' && onClose) onClose(cb);
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    assertConsumerTopologyMock.mockImplementation(
      jest.requireActual('@fairflow/shared').assertConsumerTopology,
    );
    handler = jest.fn().mockResolvedValue(undefined);
    observer = { onConsumed: jest.fn(), onDeadLettered: jest.fn(), onBound: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries initial bind with backoff until the broker is reachable', async () => {
    jest.useFakeTimers();
    const channel = makeChannel();
    const connection = makeConnection(channel);
    (connect as jest.Mock)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(connection);

    const svc = new RabbitMqService();
    const bind = svc.consume('audit.events', ['crm.#'], handler, observer);
    await jest.advanceTimersByTimeAsync(1_000);
    await bind;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(observer.onBound).toHaveBeenCalled();
  });

  it('re-binds subscriptions after the channel closes', async () => {
    jest.useFakeTimers();
    let closeHandler: () => void;
    const channel1 = makeChannel();
    const channel2 = makeChannel();
    let channelNo = 0;
    const connection = {
      createChannel: jest.fn().mockImplementation(async () => (channelNo++ === 0 ? channel1 : channel2)),
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'close') closeHandler = cb;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);
    expect(observer.onBound).toHaveBeenCalledTimes(1);

    closeHandler!();
    await jest.runAllTimersAsync();

    expect(observer.onBound).toHaveBeenCalledTimes(2);
    expect(connection.createChannel).toHaveBeenCalledTimes(2);
  });

  it('stops the initial bind retry loop after onModuleDestroy', async () => {
    jest.useFakeTimers();
    (connect as jest.Mock).mockRejectedValue(new Error('broker down'));

    const svc = new RabbitMqService();
    const bind = svc.consume('audit.events', ['crm.#'], handler, observer);
    await svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(1_000);
    await bind;

    expect(observer.onBound).not.toHaveBeenCalled();
  });

  it('onModuleDestroy closes an established broker connection', async () => {
    const channel = makeChannel();
    const connection = makeConnection(channel);
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new RabbitMqService();
    await svc.consume('audit.events', ['crm.#'], handler, observer);
    await svc.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });
});

describe('RabbitMqService observability helpers', () => {
  it('dlqDepth returns the broker queue depth', async () => {
    const channel = {
      prefetch: jest.fn(),
      consume: jest.fn(),
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue({}),
      bindQueue: jest.fn(),
      checkQueue: jest.fn().mockResolvedValue({ messageCount: 3 }),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (connect as jest.Mock).mockResolvedValue(connection);

    const svc = new RabbitMqService();
    await expect(svc.dlqDepth('audit.events')).resolves.toBe(3);
  });

  it('dlqDepth returns 0 when the broker check fails', async () => {
    (connect as jest.Mock).mockRejectedValueOnce(new Error('broker down'));
    const svc = new RabbitMqService();
    await expect(svc.dlqDepth('audit.events')).resolves.toBe(0);
  });
});
