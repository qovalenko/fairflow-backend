import { ObjectId } from 'mongodb';
import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('ContactsService.resolveDocumentVariables (documents §4)', () => {
  it('возвращает contact.* переменные через findOne', async () => {
    const oid = new ObjectId();
    const row = {
      _id: oid,
      projectId: 'p1',
      firstName: 'Anna',
      lastName: 'Smith',
      email: 'a@x.ru',
      phone: '+79001112233',
      deletedAt: null,
      ownerId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    };
    const coll = {
      findOne: jest.fn().mockResolvedValue(row),
      find: () => ({
        sort: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    };
    const svc = new ContactsService(
      { contacts: async () => coll } as never,
      { withOutbox: async () => undefined } as never,
    );
    const res = await svc.resolveDocumentVariables('p1', oid.toString(), ALL_SCOPE);
    expect(res.values['contact.firstName']).toBe('Anna');
    expect(res.values['contact.email']).toBe('a@x.ru');
    expect(res.source_hash).toMatch(/^sha256:/);
  });
});

describe('ContactsService.touchLastActivity (FR-CONTACTS-468)', () => {
  it('обновляет lastActivityAt, если активность новее текущей', async () => {
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const oid = new ObjectId();
    const svc = new ContactsService(
      { contacts: async () => ({ updateOne }) } as never,
      { withOutbox: async () => undefined } as never,
    );
    const at = Date.now();
    await svc.touchLastActivity('p1', oid.toString(), at);
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', _id: oid }),
      expect.objectContaining({
        $set: expect.objectContaining({ lastActivityAt: new Date(at) }),
      }),
    );
  });

  it('no-op при невалидном contactId или нулевом timestamp', async () => {
    const updateOne = jest.fn();
    const svc = new ContactsService(
      { contacts: async () => ({ updateOne }) } as never,
      { withOutbox: async () => undefined } as never,
    );
    await svc.touchLastActivity('p1', 'bad-id', Date.now());
    await svc.touchLastActivity('p1', new ObjectId().toString(), 0);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
