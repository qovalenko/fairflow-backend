import type { Channel, Connection, ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from '@fairflow/shared';
import { WebhookConsumerService } from './webhook-consumer.service';
import type { WebhookDeliveryService } from './webhook-delivery.service';

const connectMock = jest.fn();

jest.mock('amqplib', () => ({
  connect: (...args: unknown[]) => connectMock(...args),
}));

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    assertMainExchange: jest.fn().mockResolvedValue(undefined),
  };
});

describe('WebhookConsumerService', () => {
  const prevDisabled = process.env.CONTROL_WEBHOOKS_DISABLED;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.CONTROL_WEBHOOKS_DISABLED;
    else process.env.CONTROL_WEBHOOKS_DISABLED = prevDisabled;
    connectMock.mockReset();
  });

  function envelope(): EventEnvelope {
    return {
      type: 'crm.deal.won',
      version: 1,
      messageId: 'msg-1',
      source: 'crm',
      timestamp: '2026-07-20T00:00:00.000Z',
      projectId: 'proj-1',
      payload: { dealId: 'd-1' },
    };
  }

  it('does not connect when CONTROL_WEBHOOKS_DISABLED=true', () => {
    process.env.CONTROL_WEBHOOKS_DISABLED = 'true';
    const delivery = { deliver: jest.fn() } as unknown as WebhookDeliveryService;
    const svc = new WebhookConsumerService(delivery);
    svc.onModuleInit();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('delivers parsed envelopes and always acks', async () => {
    delete process.env.CONTROL_WEBHOOKS_DISABLED;
    const deliver = jest.fn().mockResolvedValue(undefined);
    const ack = jest.fn();
    let consumer: ((msg: ConsumeMessage | null) => void) | undefined;

    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn(async (_q: string, cb: (msg: ConsumeMessage | null) => void) => {
        consumer = cb;
      }),
      ack,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Channel;

    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Connection;

    connectMock.mockResolvedValue(connection);

    const svc = new WebhookConsumerService({ deliver } as unknown as WebhookDeliveryService);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 0));

    const message = {
      content: Buffer.from(JSON.stringify(envelope())),
    } as ConsumeMessage;
    await consumer!(message);

    expect(deliver).toHaveBeenCalledWith(envelope());
    expect(ack).toHaveBeenCalledWith(message);
  });

  it('acks and drops malformed messages without rethrowing', async () => {
    delete process.env.CONTROL_WEBHOOKS_DISABLED;
    const deliver = jest.fn();
    const ack = jest.fn();
    let consumer: ((msg: ConsumeMessage | null) => void) | undefined;

    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn(async (_q: string, cb: (msg: ConsumeMessage | null) => void) => {
        consumer = cb;
      }),
      ack,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as Channel;

    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const svc = new WebhookConsumerService({ deliver } as unknown as WebhookDeliveryService);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 0));

    const bad = { content: Buffer.from('not-json') } as ConsumeMessage;
    await consumer!(bad);

    expect(deliver).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(bad);
  });

  it('closes AMQP handles on destroy', async () => {
    delete process.env.CONTROL_WEBHOOKS_DISABLED;
    const channelClose = jest.fn().mockResolvedValue(undefined);
    const connectionClose = jest.fn().mockResolvedValue(undefined);
    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      close: channelClose,
    };
    connectMock.mockResolvedValue({
      createChannel: jest.fn().mockResolvedValue(channel),
      on: jest.fn(),
      close: connectionClose,
    });

    const svc = new WebhookConsumerService({
      deliver: jest.fn(),
    } as unknown as WebhookDeliveryService);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 0));
    await svc.onModuleDestroy();

    expect(channelClose).toHaveBeenCalled();
    expect(connectionClose).toHaveBeenCalled();
  });
});
