import { ContactMergedConsumer } from './contact-merged.consumer';
import { PipeService } from './pipe.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** TODO-170 — pipe `crm.contact.merged` consumer: delegation + poison guard. */
describe('pipe ContactMergedConsumer.handle', () => {
  function make(rewritten = 1) {
    const rewriteContactOnMerge = jest.fn().mockResolvedValue({ rewritten });
    const pipe = { rewriteContactOnMerge } as unknown as PipeService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new ContactMergedConsumer(pipe, rabbit), rewriteContactOnMerge };
  }

  it('rewrites deals and reports the outcome', async () => {
    const { consumer, rewriteContactOnMerge } = make(2);
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: 'p1',
        idempotencyKey: 'contact.merged:src:tgt',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('rewritten');
    expect(rewriteContactOnMerge).toHaveBeenCalledWith(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
  });

  it('dead-letters a poison message without rewriting', async () => {
    const { consumer, rewriteContactOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: '',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteContactOnMerge).not.toHaveBeenCalled();
  });

  it('reports skipped when no deals were rewritten', async () => {
    const { consumer } = make(0);
    await expect(
      consumer.handle({
        type: 'crm.contact.merged',
        projectId: 'p1',
        payload: { sourceContactIds: ['src'], targetContactId: 'tgt' },
      }),
    ).resolves.toBe('skipped');
  });
});
