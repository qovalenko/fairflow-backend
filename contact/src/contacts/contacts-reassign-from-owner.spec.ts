import { ObjectId } from 'mongodb';
import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';
import type { ReassignTargetValidator } from './reassign-target.validator';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

type Doc = Record<string, unknown> & { _id: ObjectId };

function matchDoc(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((part) => matchDoc(doc, part))) return false;
      continue;
    }
    if (key === '_id' && cond && typeof cond === 'object' && '$in' in (cond as object)) {
      const ids = (cond as { $in: ObjectId[] }).$in.map((id) => id.toString());
      if (!ids.includes(doc._id.toString())) return false;
      continue;
    }
    const value = doc[key] === undefined ? null : doc[key];
    if (cond === null) {
      if (value !== null) return false;
      continue;
    }
    if (String(value) !== String(cond)) return false;
  }
  return true;
}

function buildReassignFromOwner(docs: Doc[], reassignTargets: ReassignTargetValidator) {
  const coll = {
    find: (filter: Record<string, unknown>) => ({
      project: (projection?: Record<string, number>) => ({
        toArray: async () =>
          docs
            .filter((d) => matchDoc(d, filter))
            .map((d) =>
              projection?._id
                ? { _id: d._id, ...(projection.ownerId ? { ownerId: d.ownerId } : {}) }
                : d,
            ),
      }),
    }),
    updateMany: async (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown>; $unset?: Record<string, ''> },
    ) => {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (matchDoc(doc, filter)) {
          Object.assign(doc, update.$set);
          if (update.$unset) {
            for (const field of Object.keys(update.$unset)) delete doc[field];
          }
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
  const outbox = {
    withOutbox: async (
      fn: (s: unknown) => Promise<{ result: unknown; intents?: unknown[] }>,
    ) => {
      const r = await fn(undefined);
      return r.result;
    },
  };
  const svc = new ContactsService(
    { contacts: async () => coll } as never,
    outbox as never,
    reassignTargets,
  );
  return { svc, docs };
}

describe('ContactsService.reassignFromOwner (FR-CONTACTS-467)', () => {
  it('переназначает контакты с fromOwnerId на toOwnerId', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const reassignTargets = {
      assertOwnerAssignable: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReassignTargetValidator;
    const { svc, docs } = buildReassignFromOwner(
      [
        { _id: id1, projectId: 'p1', ownerId: 'from-u', deletedAt: null },
        { _id: id2, projectId: 'p1', ownerId: 'from-u', deletedAt: null },
      ],
      reassignTargets,
    );

    const res = await svc.reassignFromOwner('p1', 'from-u', 'to-u', ALL_SCOPE);

    expect(res).toEqual({ reassigned: 2 });
    expect(docs.every((d) => d.ownerId === 'to-u')).toBe(true);
    expect(reassignTargets.assertOwnerAssignable).toHaveBeenCalledWith(
      'p1',
      'to-u',
      undefined,
      'toOwnerId',
      ALL_SCOPE,
    );
    expect(reassignTargets.assertOwnerAssignable).toHaveBeenCalledWith(
      'p1',
      'to-u',
      undefined,
      'newOwnerId',
      ALL_SCOPE,
    );
  });

  it('отклоняет пустые from/to', async () => {
    const svc = new ContactsService(
      { contacts: async () => ({ find: jest.fn() }) } as never,
      { withOutbox: async () => undefined } as never,
    );
    await expect(svc.reassignFromOwner('p1', '', 'to-u', ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'invalid',
    });
  });

  it('no-op, когда from совпадает с to', async () => {
    const svc = new ContactsService(
      { contacts: async () => ({ find: jest.fn() }) } as never,
      { withOutbox: async () => undefined } as never,
    );
    await expect(svc.reassignFromOwner('p1', 'same', 'same', ALL_SCOPE)).resolves.toEqual({
      reassigned: 0,
    });
  });
});
