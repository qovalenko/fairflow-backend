import { CompanyMergedConsumer } from './company-merged.consumer';
import { ContactsService } from './contacts.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

describe('contact CompanyMergedConsumer.handle', () => {
  function make(rewritten = 1) {
    const rewriteCompanyOnMerge = jest.fn().mockResolvedValue({ rewritten });
    const contacts = { rewriteCompanyOnMerge } as unknown as ContactsService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new CompanyMergedConsumer(contacts, rabbit), rewriteCompanyOnMerge };
  }

  it('rewrites contact company links and reports the outcome', async () => {
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

  it('reports skipped when rewrite returns zero', async () => {
    const { consumer, rewriteCompanyOnMerge } = make(0);
    await expect(
      consumer.handle({
        projectId: 'p1',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('skipped');
    expect(rewriteCompanyOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });

  it('использует idempotencyKey из envelope, если он задан', async () => {
    const { consumer, rewriteCompanyOnMerge } = make();
    await consumer.handle({
      projectId: 'p1',
      idempotencyKey: 'custom-key',
      payload: { masterId: 'co-master', loserId: 'co-loser' },
    });
    expect(rewriteCompanyOnMerge).toHaveBeenCalledWith('p1', 'co-loser', 'co-master', 'custom-key');
  });
});

describe('contact CompanyMergedConsumer.onModuleInit', () => {
  const OLD = process.env.COMPANY_MERGED_CONSUMER_ENABLED;
  afterEach(() => {
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = OLD;
  });

  it('подписывается на crm.company.merged при включённом флаге', async () => {
    delete process.env.COMPANY_MERGED_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new CompanyMergedConsumer(
      { rewriteCompanyOnMerge: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('contact.company-merged'),
      ['crm.company.merged'],
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('не подписывается, когда COMPANY_MERGED_CONSUMER_ENABLED=false', async () => {
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const c = new CompanyMergedConsumer(
      { rewriteCompanyOnMerge: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
