import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('ContactsService.list — дополнительные фильтры', () => {
  function captureList() {
    const captured: Record<string, unknown>[] = [];
    const coll = {
      countDocuments: async (f: Record<string, unknown>) => {
        captured.push(f);
        return 0;
      },
      find: (f: Record<string, unknown>) => {
        captured.push(f);
        return {
          skip: () => ({
            limit: () => ({
              sort: () => ({ toArray: async () => [] }),
            }),
          }),
        };
      },
    };
    const svc = new ContactsService(
      { contacts: async () => coll } as never,
      { withOutbox: async () => undefined } as never,
    );
    return { svc, captured };
  }

  it('текстовый query добавляет $or по полям имени и контактов', async () => {
    const { svc, captured } = captureList();
    await svc.list('p1', 0, 25, '  Ivan  ', ALL_SCOPE);
    const filter = captured[0] as { $and: Record<string, unknown>[] };
    const textOr = filter.$and.find((part) => Array.isArray(part.$or)) as {
      $or: { firstName?: RegExp }[];
    };
    expect(textOr.$or.map((clause) => Object.keys(clause)[0])).toEqual([
      'firstName',
      'lastName',
      'email',
      'phone',
    ]);
    expect(textOr.$or[0].firstName?.test('Ivan Petrov')).toBe(true);
  });

  it('ownerScope=__unassigned__ фильтрует записи без owner и department', async () => {
    const { svc, captured } = captureList();
    await svc.list('p1', 0, 25, undefined, ALL_SCOPE, undefined, false, {
      ownerScope: '__unassigned__',
    });
    expect(JSON.stringify(captured[0])).toContain('ownerId');
    expect(JSON.stringify(captured[0])).toContain('departmentId');
  });

  it('inactiveDays добавляет cutoff по lastActivityAt', async () => {
    const { svc, captured } = captureList();
    await svc.list('p1', 0, 25, undefined, ALL_SCOPE, undefined, false, {
      inactiveDays: 30,
    });
    expect(JSON.stringify(captured[0])).toContain('lastActivityAt');
  });

  it('includeDeleted=true переключает фильтр на корзину', async () => {
    const { svc, captured } = captureList();
    await svc.list('p1', 0, 25, undefined, ALL_SCOPE, undefined, true);
    expect(JSON.stringify(captured[0])).toContain('deletedAt');
    expect(JSON.stringify(captured[0])).not.toContain('"deletedAt":null');
  });
});

describe('ContactsService.findOne — маскировка недоступной записи', () => {
  it('NOT_FOUND при невалидном id', async () => {
    const svc = new ContactsService(
      { contacts: async () => ({ findOne: async () => null }) } as never,
      { withOutbox: async () => undefined } as never,
    );
    await expect(svc.findOne('p1', 'not-an-object-id', ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });

  it('NOT_FOUND, если запись вне visibility scope', async () => {
    const oid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const coll = {
      findOne: async () => ({
        _id: oid,
        projectId: 'p1',
        ownerId: 'other',
        deletedAt: null,
      }),
    };
    const svc = new ContactsService(
      { contacts: async () => coll } as never,
      { withOutbox: async () => undefined } as never,
    );
    const ownScope: VisibilityScope = {
      mode: 'restricted',
      level: 'custom',
      selfId: 'me',
      ownerIds: ['me'],
      sharedRecordIds: [],
    };
    await expect(svc.findOne('p1', oid, ownScope)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });
});

describe('ContactsService.create — duplicate key 11000', () => {
  it('транслирует Mongo 11000 в доменную ошибку дубликата', async () => {
    const coll = {
      find: () => ({
        limit: () => ({ toArray: async () => [] }),
        sort: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
      findOne: async () => null,
      insertOne: async () => {
        throw Object.assign(new Error('dup'), { code: 11000 });
      },
    };
    const outbox = {
      withOutbox: async (fn: (s: unknown) => Promise<unknown>) => fn(undefined),
    };
    const svc = new ContactsService({ contacts: async () => coll } as never, outbox as never);
    await expect(svc.create('p1', { lastName: 'Dup', email: 'dup@x.ru' })).rejects.toMatchObject({
      errorCode: 'invalid',
      message: expect.stringContaining('уже существует'),
    });
  });
});
