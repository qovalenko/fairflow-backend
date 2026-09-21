import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('FR-CONTACTS-469 tags list filter', () => {
  it('list с filterTags сужает выборку по $all', async () => {
    const docs = [
      {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        projectId: 'p1',
        firstName: 'Vip',
        lastName: 'One',
        tags: ['vip', 'gold'],
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        projectId: 'p1',
        firstName: 'Plain',
        lastName: 'Two',
        tags: ['lead'],
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const captured: Record<string, unknown>[] = [];
    const coll = {
      countDocuments: async (f: Record<string, unknown>) => {
        captured.push(f);
        return 1;
      },
      find: (f: Record<string, unknown>) => {
        captured.push(f);
        return {
          skip: () => ({
            limit: () => ({
              sort: () => ({
                toArray: async () => docs.filter((d) => d.tags.includes('vip')),
              }),
            }),
          }),
        };
      },
    };
    const mongo = { contacts: () => coll } as never;
    const outbox = { withOutbox: async () => ({}) } as never;
    const svc = new ContactsService(mongo, outbox);
    const res = await svc.list('p1', 0, 25, undefined, ALL_SCOPE, undefined, false, {
      filterTags: ['vip'],
    });
    expect(res.list).toHaveLength(1);
    expect(JSON.stringify(captured)).toContain('vip');
  });
});
