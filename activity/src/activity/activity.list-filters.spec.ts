import { status } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import type { AccessPredicate } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService list/calendar filters', () => {
  let capturedFilter: Record<string, unknown> = {};
  let capturedSort: Record<string, unknown> = {};
  let capturedLimit: number | undefined;

  function makeService() {
    capturedFilter = {};
    capturedSort = {};
    capturedLimit = undefined;
    const coll = {
      countDocuments: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        return Promise.resolve(1);
      }),
      find: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        return {
          sort: (s: Record<string, unknown>) => {
            capturedSort = s;
            return {
              skip: () => ({
                limit: (n: number) => {
                  capturedLimit = n;
                  return { toArray: () => Promise.resolve([]) };
                },
              }),
            };
          },
          limit: (n: number) => {
            capturedLimit = n;
            return { toArray: () => Promise.resolve([]) };
          },
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
    return svc;
  }

  function flatAnd(f: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(f.$and) ? (f.$and as Record<string, unknown>[]) : [f];
  }

  it('filters by status whitelist', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { status: 'in_progress' });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({ status: 'in_progress' });
  });

  it('rejects unknown status', async () => {
    const svc = makeService();
    await expect(svc.list('p1', 0, 25, { status: 'bogus' })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('filters by multiple types via $in', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { types: ['task', 'call'] });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({ type: { $in: ['task', 'call'] } });
  });

  it('combines overdueOnly with date window on dueDate', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { overdueOnly: true, dateFrom: 1000, dateTo: 2000 });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({
      status: { $nin: ['completed', 'cancelled'] },
      dueDate: { $lt: expect.any(Number) },
    });
    expect(clauses).toContainEqual({ dueDate: { $gte: 1000, $lte: 2000 } });
  });

  it('uses $elemMatch for link entity type + id', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { linkEntityType: 'contact', linkEntityId: 'c1' });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({
      links: { $elemMatch: { entityType: 'contact', entityId: 'c1' } },
    });
  });

  it('applies ABAC deny-all when predicate is malformed', async () => {
    const svc = makeService();
    const access: AccessPredicate = { present: true, malformed: true };
    await svc.list('p1', 0, 25, {}, undefined, access);
    expect(JSON.stringify(capturedFilter)).toContain('000000000000000000000000');
  });

  it('sort whitelist maps dueDate desc', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { sortField: 'dueDate', sortOrder: 'desc' });
    expect(capturedSort).toEqual({ dueDate: -1 });
  });

  it('withoutAssignee filters empty assigneeId (FR-SEARCH-410)', async () => {
    const svc = makeService();
    await svc.list('p1', 0, 25, { withoutAssignee: true });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({
      $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }],
    });
  });

  it('calendar requires dateFrom/dateTo and caps rows', async () => {
    const svc = makeService();
    await svc.calendar('p1', { dateFrom: 1, dateTo: 2 });
    expect(capturedLimit).toBe(5000);
    const clauses = flatAnd(capturedFilter);
    expect(clauses.some((c) => '$or' in c)).toBe(true);
  });

  it('calendar rejects missing date range', async () => {
    const svc = makeService();
    await expect(svc.calendar('p1', {})).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('update rejects status completed without complete()', async () => {
    const oid = new ObjectId();
    const id = oid.toString();
    const doc = {
      _id: oid,
      projectId: 'p1',
      assigneeId: 'u1',
      status: 'planned',
      type: 'task',
      links: [],
      dueDate: null,
      reminderOffset: 'none',
    };
    const coll = {
      countDocuments: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue(doc),
      updateOne: jest.fn(),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      { withOutbox: async (fn: () => Promise<unknown>) => fn() } as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    await expect(
      svc.update(
        'p1',
        id,
        { status: 'completed' },
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: [], sharedRecordIds: [] },
        true,
      ),
    ).rejects.toMatchObject({ error: { code: status.FAILED_PRECONDITION } });
  });

  it('update accepts completed echo when the activity is already completed (no-op)', async () => {
    const oid = new ObjectId();
    const id = oid.toString();
    const doc = {
      _id: oid,
      projectId: 'p1',
      assigneeId: 'u1',
      status: 'completed',
      type: 'task',
      links: [],
      dueDate: null,
      reminderOffset: 'none',
    };
    const coll = {
      countDocuments: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue(doc),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      { withOutbox: async (fn: () => Promise<unknown>) => fn() } as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    const row = await svc.update(
      'p1',
      id,
      { title: 'typo fixed', status: 'completed' },
      { mode: 'all', level: 'all', selfId: 'u1', ownerIds: [], sharedRecordIds: [] },
      true,
    );
    expect(row.status).toBe('completed');
  });
});
