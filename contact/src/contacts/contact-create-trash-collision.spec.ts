import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

function buildService(docs: Record<string, unknown>[]) {
  const coll = {
    docs,
    find: (filter: Record<string, unknown> = {}) => ({
      limit: () => ({
        toArray: async () =>
          docs.filter((d) => {
            if (filter.projectId && d.projectId !== filter.projectId) return false;
            if (
              filter.deletedAt &&
              typeof filter.deletedAt === 'object' &&
              '$ne' in filter.deletedAt &&
              filter.deletedAt.$ne === null &&
              d.deletedAt == null
            )
              return false;
            return true;
          }),
      }),
    }),
    insertOne: async (doc: Record<string, unknown>) => {
      const id = 'newidnewidnewidnewidnewid';
      docs.push({ ...doc, _id: id });
      return { insertedId: id };
    },
    findOne: async () => docs[docs.length - 1] ?? null,
  };
  const mongo = { contacts: () => coll } as never;
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  const companyRefs = { assertCompaniesExist: jest.fn(async () => undefined) };
  const svc = new ContactsService(mongo, outbox as never, undefined, companyRefs as never);
  return { svc, coll, companyRefs };
}

describe('FR-CONTACTS-140 create trash collision', () => {
  it('без resolution кидает conflict TRASH_COLLISION', async () => {
    const { svc } = buildService([
      {
        _id: 'trash1trash1trash1trash1',
        projectId: 'p1',
        firstName: 'Old',
        lastName: 'Trash',
        email: 'dup@test.com',
        phone: '+79990001122',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergedInto: null,
      },
    ]);
    await expect(
      svc.create(
        'p1',
        { firstName: 'New', lastName: 'One', email: 'dup@test.com', phone: '+79990001122' },
        undefined,
        ALL_SCOPE,
      ),
    ).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { code: 'TRASH_COLLISION', trashedId: 'trash1trash1trash1trash1' },
    });
  });

  it('resolution=restore восстанавливает запись из корзины', async () => {
    const { svc } = buildService([
      {
        _id: 'trash1trash1trash1trash1',
        projectId: 'p1',
        firstName: 'Old',
        lastName: 'Trash',
        email: 'dup@test.com',
        phone: '+79990001122',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergedInto: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const restoreSpy = jest
      .spyOn(svc, 'restore')
      .mockResolvedValue({ id: 'trash1trash1trash1trash1' } as never);
    await svc.create(
      'p1',
      { firstName: 'New', lastName: 'One', email: 'dup@test.com' },
      undefined,
      ALL_SCOPE,
      undefined,
      { trashCollisionResolution: 'restore' },
    );
    expect(restoreSpy).toHaveBeenCalledWith(
      'p1',
      'trash1trash1trash1trash1',
      undefined,
      ALL_SCOPE,
      undefined,
      undefined,
    );
  });

  it('коллизия по телефону не цепляет чужую запись в корзине', async () => {
    const { svc } = buildService([
      {
        _id: 'otherotherotherotherothe',
        projectId: 'p1',
        email: 'other@test.com',
        phone: '+79990000000',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergedInto: null,
      },
      {
        _id: 'phone1phone1phone1phone1',
        projectId: 'p1',
        email: 'keep@test.com',
        phone: '8 (999) 000-11-22',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergedInto: null,
      },
    ]);
    await expect(
      svc.create(
        'p1',
        { firstName: 'New', lastName: 'One', phone: '+7 999 000-11-22' },
        undefined,
        ALL_SCOPE,
      ),
    ).rejects.toMatchObject({
      errorCode: 'conflict',
      details: {
        code: 'TRASH_COLLISION',
        trashedId: 'phone1phone1phone1phone1',
        matchedOn: 'phone',
      },
    });
  });
});
