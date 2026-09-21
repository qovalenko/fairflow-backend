import { ContactMergedConsumer } from './contact-merged.consumer';
import { OrdersService } from './orders.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

const env = (over: Record<string, unknown> = {}) => ({
  type: 'crm.contact.merged',
  projectId: 'projectId' in over ? over.projectId : 'p1',
  idempotencyKey: 'contact.merged:src:tgt',
  payload: {
    sourceContactIds: ['src'],
    targetContactId: 'tgt',
    mergedBy: 'u1',
    ...(over.payload as Record<string, unknown> | undefined),
  },
});

function make(rewritten = 1) {
  const rewriteContactOnMerge = jest.fn().mockResolvedValue({ rewritten });
  const markSourceDrift = jest.fn().mockResolvedValue({ scanned: 0, marked: 0 });
  const orders = { rewriteContactOnMerge, markSourceDrift } as unknown as OrdersService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return {
    consumer: new ContactMergedConsumer(orders, rabbit),
    rewriteContactOnMerge,
    markSourceDrift,
  };
}

describe('orders ContactMergedConsumer.handle (TODO-170)', () => {
  it('rewrites orders, drift-marks the target and reports the outcome', async () => {
    const { consumer, rewriteContactOnMerge, markSourceDrift } = make(2);
    await expect(consumer.handle(env())).resolves.toBe('rewritten');
    expect(rewriteContactOnMerge).toHaveBeenCalledWith(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
    expect(markSourceDrift).toHaveBeenCalledWith('p1', 'contact', 'tgt');
  });

  it('still drift-marks on a redelivery that finds nothing to rewrite', async () => {
    const { consumer, markSourceDrift } = make(0);
    await expect(consumer.handle(env())).resolves.toBe('skipped');
    expect(markSourceDrift).toHaveBeenCalledWith('p1', 'contact', 'tgt');
  });

  it('propagates an unreadable target (markSourceDrift throw) to the retry ladder', async () => {
    const { consumer, markSourceDrift } = make(1);
    markSourceDrift.mockRejectedValue(new Error('drift source contact/tgt unreadable — retrying'));
    await expect(consumer.handle(env())).rejects.toThrow('unreadable');
  });

  it('dead-letters a poison message (no projectId) without rewriting', async () => {
    const { consumer, rewriteContactOnMerge, markSourceDrift } = make();
    await expect(consumer.handle(env({ projectId: '' }))).resolves.toBe('dead_letter');
    expect(rewriteContactOnMerge).not.toHaveBeenCalled();
    expect(markSourceDrift).not.toHaveBeenCalled();
  });

  it('dead-letters when targetContactId is missing', async () => {
    const { consumer, rewriteContactOnMerge, markSourceDrift } = make();
    await expect(
      consumer.handle(env({ payload: { sourceContactIds: ['src'], targetContactId: '' } })),
    ).resolves.toBe('dead_letter');
    expect(rewriteContactOnMerge).not.toHaveBeenCalled();
    expect(markSourceDrift).not.toHaveBeenCalled();
  });

  it('dead-letters when sourceContactIds is empty', async () => {
    const { consumer, rewriteContactOnMerge, markSourceDrift } = make();
    await expect(
      consumer.handle(env({ payload: { sourceContactIds: [], targetContactId: 'tgt' } })),
    ).resolves.toBe('dead_letter');
    expect(rewriteContactOnMerge).not.toHaveBeenCalled();
    expect(markSourceDrift).not.toHaveBeenCalled();
  });

  it('генерирует mergeKey без idempotencyKey', async () => {
    const { consumer, rewriteContactOnMerge } = make(1);
    await consumer.handle({
      type: 'crm.contact.merged',
      projectId: 'p1',
      payload: { sourceContactIds: ['a', 'b'], targetContactId: 'tgt' },
    });
    expect(rewriteContactOnMerge).toHaveBeenCalledWith(
      'p1',
      ['a', 'b'],
      'tgt',
      'contact.merged:a,b:tgt',
    );
  });

  it('onModuleInit не подписывается при CONTACT_MERGED_CONSUMER_ENABLED=false', async () => {
    const prev = process.env.CONTACT_MERGED_CONSUMER_ENABLED;
    process.env.CONTACT_MERGED_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const consumer = new ContactMergedConsumer(
      {} as OrdersService,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
    process.env.CONTACT_MERGED_CONSUMER_ENABLED = prev;
  });

  it('onModuleInit подписывает очередь при включённом consumer', async () => {
    const prev = process.env.CONTACT_MERGED_CONSUMER_ENABLED;
    delete process.env.CONTACT_MERGED_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const consumer = new ContactMergedConsumer(
      { handle: jest.fn() } as never,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('orders.contact-merged'),
      ['crm.contact.merged'],
      expect.any(Function),
      expect.any(Number),
    );
    process.env.CONTACT_MERGED_CONSUMER_ENABLED = prev;
  });
});
