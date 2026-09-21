import { CompanyMergedConsumer } from './company-merged.consumer';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

describe('activity CompanyMergedConsumer.handle', () => {
  function make(rewritten = 1) {
    const rewriteCompanyLinksOnMerge = jest.fn().mockResolvedValue({ rewritten });
    const activity = { rewriteCompanyLinksOnMerge } as unknown as ActivityService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new CompanyMergedConsumer(activity, rabbit), rewriteCompanyLinksOnMerge };
  }

  it('rewrites activity company links and reports the outcome', async () => {
    const { consumer, rewriteCompanyLinksOnMerge } = make(2);
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        idempotencyKey: 'company.merged:co-loser',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('rewritten');
    expect(rewriteCompanyLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });

  it('dead-letters a poison message without rewriting', async () => {
    const { consumer, rewriteCompanyLinksOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: '',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteCompanyLinksOnMerge).not.toHaveBeenCalled();
  });

  it('reports skipped when no activity links matched the merge', async () => {
    const { consumer, rewriteCompanyLinksOnMerge } = make(0);
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('skipped');
    expect(rewriteCompanyLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });

  it('derives idempotency key from loserId when envelope key is absent', async () => {
    const { consumer, rewriteCompanyLinksOnMerge } = make(1);
    await consumer.handle({
      type: 'crm.company.merged',
      projectId: 'p1',
      payload: { masterId: 'co-master', loserId: 'co-loser' },
    });
    expect(rewriteCompanyLinksOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });
});

describe('activity CompanyMergedConsumer.onModuleInit', () => {
  const OLD = process.env.COMPANY_MERGED_CONSUMER_ENABLED;
  afterEach(() => {
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.COMPANY_MERGED_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new CompanyMergedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][1]).toEqual(['crm.company.merged']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const c = new CompanyMergedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
