import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

const RESTRICTED_SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'custom',
  selfId: 'owner-a',
  ownerIds: ['owner-a'],
  sharedRecordIds: [],
};

function build(rows: Record<string, unknown>[]) {
  const coll = {
    find: () => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => rows,
        }),
      }),
    }),
  };
  const mongo = { contacts: async () => coll };
  const outbox = { withOutbox: async () => undefined };
  return new ContactsService(mongo as never, outbox as never);
}

describe('ContactsService.findDuplicates — непокрытые ветки', () => {
  it('отклоняет запрос без e-mail и телефона', async () => {
    const svc = build([]);
    await expect(svc.findDuplicates('p1', {}, ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'invalid',
      details: { field: 'email' },
    });
  });

  it('исключает excludeId из выборки', async () => {
    const captured: Record<string, unknown>[] = [];
    const coll = {
      find: (filter: Record<string, unknown>) => {
        captured.push(filter);
        return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) };
      },
    };
    const svc = new ContactsService(
      { contacts: async () => coll } as never,
      { withOutbox: async () => undefined } as never,
    );
    await svc.findDuplicates(
      'p1',
      { email: 'a@x.ru', excludeId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      ALL_SCOPE,
    );
    expect(captured[0]._id).toEqual({
      $ne: expect.objectContaining({ toString: expect.any(Function) }),
    });
  });

  it('ставит possibleExternalDuplicate, если совпадение вне видимости', async () => {
    const svc = build([
      {
        _id: { toString: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' },
        projectId: 'p1',
        firstName: 'Скрытый',
        lastName: 'Контакт',
        emailNormalized: 'hidden@x.ru',
        email: 'hidden@x.ru',
        ownerId: 'other-owner',
        deletedAt: null,
      },
    ]);
    const res = await svc.findDuplicates('p1', { email: 'hidden@x.ru' }, RESTRICTED_SCOPE);
    expect(res.candidates).toEqual([]);
    expect(res.possibleExternalDuplicate).toBe(true);
  });

  it('находит удалённый контакт по raw email в корзине', async () => {
    const svc = build([
      {
        _id: { toString: () => 'cccccccccccccccccccccccc' },
        projectId: 'p1',
        firstName: 'Del',
        lastName: 'One',
        email: 'trash@x.ru',
        deletedAt: new Date(),
        ownerId: 'owner-a',
      },
    ]);
    const res = await svc.findDuplicates('p1', { email: 'trash@x.ru' }, ALL_SCOPE);
    expect(res.candidates).toEqual([
      expect.objectContaining({ contactId: 'cccccccccccccccccccccccc', deleted: true }),
    ]);
  });
});
