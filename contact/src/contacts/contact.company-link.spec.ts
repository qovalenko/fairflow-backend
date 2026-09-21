import { ContactsService } from './contacts.service';

describe('ContactsService.companyLinkIntents (FR-COMPANIES-220)', () => {
  const svc = Object.create(ContactsService.prototype) as ContactsService;
  const call = (before: string[], after: string[]) =>
    (
      svc as unknown as {
        companyLinkIntents: (
          projectId: string,
          contactId: string,
          beforeIds: string[],
          afterIds: string[],
        ) => { type: string; payload: Record<string, unknown> }[];
      }
    ).companyLinkIntents('p1', 'ct1', before, after);

  it('emits contact_linked for new company ids', () => {
    const intents = call([], ['co1', 'co2']);
    expect(intents.map((i) => i.type)).toEqual([
      'crm.company.contact_linked',
      'crm.company.contact_linked',
    ]);
    expect(intents[0].payload).toEqual({ contactId: 'ct1', companyId: 'co1' });
  });

  it('emits contact_unlinked for removed company ids', () => {
    const intents = call(['co1'], []);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe('crm.company.contact_unlinked');
    expect(intents[0].payload).toEqual({ contactId: 'ct1', companyId: 'co1' });
  });

  it('returns empty when company set is unchanged', () => {
    expect(call(['co1'], ['co1'])).toEqual([]);
  });
});
