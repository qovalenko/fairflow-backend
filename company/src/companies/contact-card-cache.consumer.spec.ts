import { ContactCardCacheConsumer } from './contact-card-cache.consumer';

describe('ContactCardCacheConsumer (FR-COMPANIES-220)', () => {
  const companies = { bumpCardContactsRev: jest.fn(async () => 1) };
  const consumer = new ContactCardCacheConsumer(companies as never, {} as never);

  beforeEach(() => jest.clearAllMocks());

  it('bumps revision for crm.company.contact_linked', async () => {
    const outcome = await consumer.handle(
      {
        type: 'crm.company.contact_linked',
        projectId: 'p1',
        payload: { companyId: 'co1', contactId: 'ct1' },
      },
      'crm.company.contact_linked',
    );
    expect(outcome).toBe('bumped');
    expect(companies.bumpCardContactsRev).toHaveBeenCalledWith('p1', ['co1']);
  });

  it('extracts companyIds from contact.updated changes[]', async () => {
    await consumer.handle(
      {
        type: 'crm.contact.updated',
        projectId: 'p1',
        payload: {
          contactId: 'ct1',
          changes: [{ field: 'companyIds', oldValue: ['co1'], newValue: ['co1', 'co2'] }],
        },
      },
      'crm.contact.updated',
    );
    expect(companies.bumpCardContactsRev).toHaveBeenCalledWith('p1', ['co1', 'co2']);
  });

  it('extracts companyIds from crm.contact.merged payload', async () => {
    await consumer.handle(
      {
        type: 'crm.contact.merged',
        projectId: 'p1',
        payload: {
          sourceContactIds: ['ct-src'],
          targetContactId: 'ct-tgt',
          companyIds: ['co1', 'co2'],
        },
      },
      'crm.contact.merged',
    );
    expect(companies.bumpCardContactsRev).toHaveBeenCalledWith('p1', ['co1', 'co2']);
  });

  it('dead-letters poison messages without projectId', async () => {
    const outcome = await consumer.handle({ type: 'crm.contact.deleted', payload: {} });
    expect(outcome).toBe('dead_letter');
    expect(companies.bumpCardContactsRev).not.toHaveBeenCalled();
  });

  it('bumps revision for crm.company.contact_unlinked', async () => {
    const outcome = await consumer.handle(
      {
        type: 'crm.company.contact_unlinked',
        projectId: 'p1',
        payload: { companyId: 'co9' },
      },
      'crm.company.contact_unlinked',
    );
    expect(outcome).toBe('bumped');
    expect(companies.bumpCardContactsRev).toHaveBeenCalledWith('p1', ['co9']);
  });

  it('extracts companyIds from crm.contact.deleted payload', async () => {
    await consumer.handle(
      {
        type: 'crm.contact.deleted',
        projectId: 'p1',
        payload: { companyIds: ['co1', 'co2'] },
      },
      'crm.contact.deleted',
    );
    expect(companies.bumpCardContactsRev).toHaveBeenCalledWith('p1', ['co1', 'co2']);
  });

  it('skips when no companyIds can be derived', async () => {
    const outcome = await consumer.handle(
      { type: 'crm.contact.updated', projectId: 'p1', payload: { changes: [] } },
      'crm.contact.updated',
    );
    expect(outcome).toBe('skipped');
    expect(companies.bumpCardContactsRev).not.toHaveBeenCalled();
  });
});
