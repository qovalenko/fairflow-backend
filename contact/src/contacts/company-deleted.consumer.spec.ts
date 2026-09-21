import { CompanyDeletedConsumer } from './company-deleted.consumer';

describe('CompanyDeletedConsumer (EVT-CONTACTS-company-deleted-listener)', () => {
  it('помечает осиротевшие связи и возвращает updated', async () => {
    const markCompanyLinkOrphaned = jest.fn(async () => 2);
    const consumer = new CompanyDeletedConsumer({ markCompanyLinkOrphaned } as never, {} as never);
    await expect(
      consumer.handle({
        projectId: 'p1',
        subject: 'company/co-1',
        payload: { companyId: 'co-1' },
      }),
    ).resolves.toBe('updated');
    expect(markCompanyLinkOrphaned).toHaveBeenCalledWith('p1', 'co-1');
  });

  it('poison message без projectId → dead_letter', async () => {
    const consumer = new CompanyDeletedConsumer(
      { markCompanyLinkOrphaned: jest.fn() } as never,
      {} as never,
    );
    await expect(consumer.handle({ payload: { companyId: 'co-1' } })).resolves.toBe('dead_letter');
  });

  it('companyId берётся из subject, если payload пуст', async () => {
    const markCompanyLinkOrphaned = jest.fn(async () => 1);
    const consumer = new CompanyDeletedConsumer({ markCompanyLinkOrphaned } as never, {} as never);
    await expect(
      consumer.handle({
        projectId: 'p1',
        subject: 'company/co-from-subject',
        payload: {},
      }),
    ).resolves.toBe('updated');
    expect(markCompanyLinkOrphaned).toHaveBeenCalledWith('p1', 'co-from-subject');
  });

  it('skipped, когда осиротевших связей не найдено', async () => {
    const markCompanyLinkOrphaned = jest.fn(async () => 0);
    const consumer = new CompanyDeletedConsumer({ markCompanyLinkOrphaned } as never, {} as never);
    await expect(
      consumer.handle({ projectId: 'p1', payload: { companyId: 'co-1' } }),
    ).resolves.toBe('skipped');
  });
});

describe('CompanyDeletedConsumer.onModuleInit', () => {
  const OLD = process.env.COMPANY_DELETED_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.COMPANY_DELETED_CONSUMERS_ENABLED = OLD;
  });

  it('подписывается на crm.company.deleted', async () => {
    delete process.env.COMPANY_DELETED_CONSUMERS_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new CompanyDeletedConsumer(
      { markCompanyLinkOrphaned: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('contact.company-deleted'),
      ['crm.company.deleted'],
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('не подписывается при COMPANY_DELETED_CONSUMERS_ENABLED=false', async () => {
    process.env.COMPANY_DELETED_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const c = new CompanyDeletedConsumer(
      { markCompanyLinkOrphaned: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
