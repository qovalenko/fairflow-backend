import { consumerDlqTopology } from '@fairflow/shared';
import type { Channel, ConsumeMessage } from 'amqplib';
import { UsageRabbitMqConsumer } from './usage-rabbitmq-consumer.service';

function makeMessage(
  payload: Record<string, unknown>,
  routingKey = 'crm.order.created',
  headers: Record<string, unknown> = {},
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { routingKey },
    properties: { headers },
  } as ConsumeMessage;
}

describe('UsageRabbitMqConsumer.handleMessage', () => {
  const topology = consumerDlqTopology('product.usage', 'fairflow.events');

  function makeConsumer() {
    const consumer = new UsageRabbitMqConsumer();
    const channel = {
      ack: jest.fn(),
      sendToQueue: jest.fn(),
      publish: jest.fn(),
    } as unknown as Channel;
    const handle = (
      consumer as unknown as {
        handleMessage: (
          ch: Channel,
          top: typeof topology,
          msg: ConsumeMessage | null,
          handler: (p: Record<string, unknown>, rk: string) => Promise<void>,
        ) => Promise<void>;
      }
    ).handleMessage.bind(consumer);
    return { handle, channel };
  }

  it('acks successful handler invocations', async () => {
    const { handle, channel } = makeConsumer();
    const handler = jest.fn(async () => undefined);
    await handle(channel, topology, makeMessage({ orderId: 'o1' }), handler);
    expect(handler).toHaveBeenCalledWith({ orderId: 'o1' }, 'crm.order.created');
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('routes transient failures through the retry queue', async () => {
    const { handle, channel } = makeConsumer();
    const handler = jest.fn(async () => {
      throw new Error('mongo blip');
    });
    await handle(channel, topology, makeMessage({ orderId: 'o1' }), handler);
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      topology.retryQueue(0),
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('dead-letters after retry budget is exhausted', async () => {
    const { handle, channel } = makeConsumer();
    const handler = jest.fn(async () => {
      throw new Error('poison');
    });
    const headers = { 'x-retry-count': topology.maxAttempts };
    await handle(
      channel,
      topology,
      makeMessage({ orderId: 'o1' }, 'crm.order.created', headers),
      handler,
    );
    expect(channel.publish).toHaveBeenCalledWith(
      topology.dlqExchange,
      '',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('ignores null deliveries', async () => {
    const { handle, channel } = makeConsumer();
    const handler = jest.fn();
    await handle(channel, topology, null, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });
});

describe('UsageRabbitMqConsumer lifecycle', () => {
  it('starts unbound and clears handles on destroy', async () => {
    const consumer = new UsageRabbitMqConsumer();
    expect(consumer.bound).toBe(false);
    await consumer.onModuleDestroy();
    expect((consumer as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
