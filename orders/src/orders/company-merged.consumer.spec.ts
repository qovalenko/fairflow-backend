import { CompanyMergedConsumer } from './company-merged.consumer';
import { OrdersService } from './orders.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

describe('orders CompanyMergedConsumer.handle', () => {
  const rewriteCompanyOnMerge = jest.fn();
  const markSourceDrift = jest.fn();

  function make(rewritten = 1, marked = 0) {
    rewriteCompanyOnMerge.mockResolvedValue({ rewritten });
    markSourceDrift.mockResolvedValue({ marked });
    const orders = { rewriteCompanyOnMerge, markSourceDrift } as unknown as OrdersService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return {
      consumer: new CompanyMergedConsumer(orders, rabbit),
      rewriteCompanyOnMerge,
      markSourceDrift,
    };
  }

  beforeEach(() => {
    rewriteCompanyOnMerge.mockReset();
    markSourceDrift.mockReset();
  });

  it('rewrites order companyId and drift-marks the master', async () => {
    const { consumer, rewriteCompanyOnMerge, markSourceDrift } = make(2, 1);
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
    expect(markSourceDrift).toHaveBeenCalledWith('p1', 'company', 'co-master');
  });

  it('dead-letters a poison message without rewriting', async () => {
    const { consumer, rewriteCompanyOnMerge, markSourceDrift } = make();
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: '',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteCompanyOnMerge).not.toHaveBeenCalled();
    expect(markSourceDrift).not.toHaveBeenCalled();
  });

  it('dead-letters при отсутствии masterId', async () => {
    const { consumer, rewriteCompanyOnMerge } = make();
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        payload: { masterId: '', loserId: 'co-loser' },
      }),
    ).resolves.toBe('dead_letter');
    expect(rewriteCompanyOnMerge).not.toHaveBeenCalled();
  });

  it('возвращает skipped, если rewrite ничего не переписал', async () => {
    const { consumer } = make(0, 0);
    await expect(
      consumer.handle({
        type: 'crm.company.merged',
        projectId: 'p1',
        payload: { masterId: 'co-master', loserId: 'co-loser' },
      }),
    ).resolves.toBe('skipped');
  });

  it('генерирует mergeKey по loserId без idempotencyKey', async () => {
    const { consumer, rewriteCompanyOnMerge } = make(1, 0);
    await consumer.handle({
      type: 'crm.company.merged',
      projectId: 'p1',
      payload: { masterId: 'co-master', loserId: 'co-loser' },
    });
    expect(rewriteCompanyOnMerge).toHaveBeenCalledWith(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
  });

  it('onModuleInit не подписывается при COMPANY_MERGED_CONSUMER_ENABLED=false', async () => {
    const prev = process.env.COMPANY_MERGED_CONSUMER_ENABLED;
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const consumer = new CompanyMergedConsumer(
      {} as OrdersService,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = prev;
  });

  it('onModuleInit подписывает очередь при включённом consumer', async () => {
    const prev = process.env.COMPANY_MERGED_CONSUMER_ENABLED;
    delete process.env.COMPANY_MERGED_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const consumer = new CompanyMergedConsumer(
      { handle: jest.fn() } as never,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('orders.company-merged'),
      ['crm.company.merged'],
      expect.any(Function),
      expect.any(Number),
    );
    process.env.COMPANY_MERGED_CONSUMER_ENABLED = prev;
  });
});
