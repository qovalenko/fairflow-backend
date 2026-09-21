import { CompaniesService } from './companies.service';
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
      sort: () => ({
        limit: () => ({
          toArray: async () =>
            docs.filter((d) => {
              if (filter.projectId && d.projectId !== filter.projectId) return false;
              const and = filter.$and as Record<string, unknown>[] | undefined;
              if (and) {
                for (const clause of and) {
                  if (
                    clause.deletedAt &&
                    typeof clause.deletedAt === 'object' &&
                    '$ne' in clause.deletedAt &&
                    clause.deletedAt.$ne === null &&
                    d.deletedAt == null
                  ) {
                    return false;
                  }
                }
              }
              return true;
            }),
        }),
      }),
    }),
    findOne: async (q: Record<string, unknown>) => {
      const id = (q as { _id?: { toString?: () => string } })._id?.toString?.();
      return docs.find((d) => d._id === id) ?? null;
    },
    insertOne: async (doc: Record<string, unknown>) => {
      const id = 'newidnewidnewidnewidnewid';
      docs.push({ ...doc, _id: id });
      return { insertedId: id };
    },
  };
  const mongo = { companies: async () => coll } as never;
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  const svc = new CompaniesService(mongo, outbox as never);
  return { svc };
}

describe('FR-COMPANIES-100 create trash collision', () => {
  it('без resolution кидает conflict TRASH_COLLISION', async () => {
    const { svc } = buildService([
      {
        _id: 'trash1trash1trash1trash1',
        projectId: 'p1',
        name: 'ООО Ромашка',
        inn: '7707083893',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergeState: null,
      },
    ]);
    await expect(
      svc.create('p1', { name: 'ООО Ромашка', inn: '7707083893' }, undefined, ALL_SCOPE),
    ).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { code: 'TRASH_COLLISION', trashedId: 'trash1trash1trash1trash1' },
    });
  });

  it('resolution=restore вызывает restore', async () => {
    const { svc } = buildService([
      {
        _id: 'trash1trash1trash1trash1',
        projectId: 'p1',
        name: 'ООО Ромашка',
        inn: '7707083893',
        ownerId: 'user-1',
        deletedAt: new Date(),
        mergeState: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const restoreSpy = jest
      .spyOn(svc, 'restore')
      .mockResolvedValue({ id: 'trash1trash1trash1trash1' } as never);
    await svc.create(
      'p1',
      { name: 'ООО Ромашка', inn: '7707083893' },
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
});
