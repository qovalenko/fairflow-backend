import { CompanyMergedConsumer } from './company-merged.consumer';
import { PipeService } from './pipe.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

describe('pipe CompanyMergedConsumer.handle', () => {
  function make(rewritten = 1) {
    const rewriteCompanyOnMerge = jest.fn().mockResolvedValue({ rewritten });
    const pipe = { rewriteCompanyOnMerge } as unknown as PipeService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new CompanyMergedConsumer(pipe, rabbit), rewriteCompanyOnMerge };
  }

  it('rewrites deal companyId and reports the outcome', async () => {
    const { consumer, rewriteCompanyOnMerge } = make(2);
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        idempotencyKey: 'company.merged:co-loser',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('rewritten');
    expect(rewriteCompanyOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });

  it('dead-letters a poison message without rewriting', async () => {
    const { consumer, rewriteCompanyOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: '',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteCompanyOnMerge).not.toHaveBeenCalled();
  });

  it('reports skipped when no deals were rewritten', async () => {
    const { consumer } = make(0);
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('skipped');
  });
});
