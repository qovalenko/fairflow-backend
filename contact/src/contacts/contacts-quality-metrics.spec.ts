import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('ContactsService.getQualityMetrics (FR-CONTACTS-440)', () => {
  it('возвращает агрегаты качества базы', async () => {
    const countDocuments = jest
      .fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(2);
    const coll = {
      countDocuments,
      aggregate: () => ({
        toArray: async () => [{ rows: [], total: [{ n: 3 }] }],
      }),
      find: () => ({ toArray: async () => [] }),
    };
    const mongo = { contacts: async () => coll };
    const outbox = { withOutbox: async () => undefined };
    const svc = new ContactsService(mongo as never, outbox as never);

    const res = await svc.getQualityMetrics('p1', ALL_SCOPE);

    expect(res.totalContacts).toBe(10);
    expect(res.filledBothPct).toBe(60);
    expect(res.duplicateCandidatePairs).toBe(3);
    expect(res.openDriftLinks).toBe(2);
  });

  it('filledBothPct = 0 при пустой базе', async () => {
    const coll = {
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: () => ({ toArray: async () => [{ rows: [], total: [] }] }),
      find: () => ({ toArray: async () => [] }),
    };
    const svc = new ContactsService(
      { contacts: async () => coll } as never,
      { withOutbox: async () => undefined } as never,
    );
    const res = await svc.getQualityMetrics('p1', ALL_SCOPE);
    expect(res.filledBothPct).toBe(0);
    expect(res.totalContacts).toBe(0);
  });
});
