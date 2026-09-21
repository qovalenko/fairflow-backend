import { ContactMergedConsumer } from './contact-merged.consumer';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** TODO-170 — activity `crm.contact.merged` consumer: delegation + poison guard. */
describe('activity ContactMergedConsumer.handle', () => {
  function make(rewritten = 1) {
    const rewriteContactLinksOnMerge = jest.fn().mockResolvedValue({ rewritten });
    const activity = { rewriteContactLinksOnMerge } as unknown as ActivityService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new ContactMergedConsumer(activity, rabbit), rewriteContactLinksOnMerge };
  }

  it('rewrites activity links and reports the outcome', async () => {
    const { consumer, rewriteContactLinksOnMerge } = make(2);
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: 'p1',
        idempotencyKey: 'contact.merged:src:tgt',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('rewritten');
    expect(rewriteContactLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
  });

  it('dead-letters a poison message without rewriting', async () => {
    const { consumer, rewriteContactLinksOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: '',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteContactLinksOnMerge).not.toHaveBeenCalled();
  });

  it('reports skipped when no activity links matched the merge', async () => {
    const { consumer, rewriteContactLinksOnMerge } = make(0);
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: 'p1',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('skipped');
    expect(rewriteContactLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
  });

  it('derives idempotency key from source ids when envelope key is absent', async () => {
    const { consumer, rewriteContactLinksOnMerge } = make(1);
    await consumer.handle({
      type: 'crm.contact.merged',
      projectId: 'p1',
      payload: { sourceContactIds: ['a', 'b'], targetContactId: 'tgt' },
    });
    expect(rewriteContactLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      ['a', 'b'],
      'tgt',
      'contact.merged:a,b:tgt',
    );
  });

  it('dead-letters when sourceContactIds is empty', async () => {
    const { consumer, rewriteContactLinksOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: 'p1',
        payload: { sourceContactIds: [], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteContactLinksOnMerge).not.toHaveBeenCalled();
  });
});

describe('activity ContactMergedConsumer.onModuleInit', () => {
  const OLD = process.env.CONTACT_MERGED_CONSUMER_ENABLED;
  afterEach(() => {
    process.env.CONTACT_MERGED_CONSUMER_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.CONTACT_MERGED_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new ContactMergedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][1]).toEqual(['crm.contact.merged']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.CONTACT_MERGED_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const c = new ContactMergedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
