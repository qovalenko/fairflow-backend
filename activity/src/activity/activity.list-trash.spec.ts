import type { VisibilityScope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

/**
 * be-activities-trash-slice: listTrash must be a thin, DB-honest trash slice —
 * only soft-deleted rows, honest total (server-side countDocuments over the same
 * filter), projectId isolation and the same visibility/ABAC as list().
 */
describe('ActivityService.listTrash', () => {
  const rows = [{ _id: 'a1', projectId: 'p1', assigneeId: 'u1', deletedAt: 111, title: 'X' }];
  let capturedFilter: Record<string, unknown> = {};
  let countCalls = 0;

  function makeService() {
    const coll = {
      countDocuments: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        countCalls += 1;
        return Promise.resolve(42); // honest total from the DB, not list.length
      }),
      find: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        return {
          sort: () => ({
            skip: () => ({
              limit: () => ({ toArray: () => Promise.resolve(rows) }),
            }),
          }),
        };
      }),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      {} as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    return { svc, coll };
  }

  beforeEach(() => {
    capturedFilter = {};
    countCalls = 0;
  });

  function flatAnd(f: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(f.$and) ? (f.$and as Record<string, unknown>[]) : [f];
  }

  it('returns only soft-deleted rows (deletedAt: {$ne:null})', async () => {
    const { svc } = makeService();
    await svc.listTrash('p1', 0, 25);
    const clauses = flatAnd(capturedFilter);
    const del = clauses.find((c) => 'deletedAt' in c);
    expect(del).toEqual({ deletedAt: { $ne: null } });
  });

  it('reports an honest total from countDocuments over the same filter', async () => {
    const { svc } = makeService();
    const res = await svc.listTrash('p1', 0, 25);
    expect(res.total).toBe(42);
    expect(res.total).not.toBe(res.list.length);
    expect(countCalls).toBe(1);
  });

  it('isolates by projectId', async () => {
    const { svc } = makeService();
    await svc.listTrash('p1', 0, 25);
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({ projectId: 'p1' });
  });

  it('applies the same visibility scope as list (restricted → ownerIds filter)', async () => {
    const { svc } = makeService();
    const scope: VisibilityScope = {
      mode: 'restricted',
      level: 'custom',
      selfId: 'u1',
      ownerIds: ['u1'],
      sharedRecordIds: [],
    };
    await svc.listTrash('p1', 0, 25, undefined, scope);
    const clauses = flatAnd(capturedFilter);
    // buildVisibilityFilter injects a restricted predicate that mentions the owner field.
    expect(JSON.stringify(clauses)).toContain('assigneeId');
    expect(JSON.stringify(clauses)).toContain('u1');
  });
});
