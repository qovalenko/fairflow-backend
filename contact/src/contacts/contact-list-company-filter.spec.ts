import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('ListContacts filter_company_id (API-GET-companies-contacts)', () => {
  it('сужает выборку по companyIds в Mongo-фильтре', async () => {
    let captured: Record<string, unknown> | undefined;
    const coll = {
      countDocuments: async (f: Record<string, unknown>) => {
        captured = f;
        return 1;
      },
      find: () => ({
        skip: () => ({
          limit: () => ({
            sort: () => ({ toArray: async () => [] }),
          }),
        }),
      }),
    };
    const mongo = { contacts: async () => coll };
    const outbox = { withOutbox: async () => undefined };
    const svc = new ContactsService(mongo as never, outbox as never);
    await svc.list('p1', 0, 25, '', ALL_SCOPE, undefined, false, {
      companyId: 'co-42',
    });
    expect(captured).toEqual({
      $and: [{ projectId: 'p1', deletedAt: null }, { companyIds: 'co-42' }],
    });
  });
});
