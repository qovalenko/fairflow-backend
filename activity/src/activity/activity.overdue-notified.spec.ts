import { ObjectId } from 'mongodb';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService overdueNotifiedAt', () => {
  it('initializes overdueNotifiedAt to null on create', async () => {
    let inserted: Record<string, unknown> | undefined;
    const coll = {
      insertOne: jest.fn((doc: Record<string, unknown>) => {
        inserted = doc;
        return Promise.resolve({ insertedId: doc._id });
      }),
      findOne: jest.fn(() => Promise.resolve(inserted ?? null)),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const outbox = {
      withOutbox: jest.fn(
        async (fn: (session?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
          const captured = await fn(undefined);
          return captured.result;
        },
      ),
    } as unknown as MongoOutboxStore;
    const svc = new ActivityService(
      mongo,
      outbox,
      {
        resolveLinks: jest.fn(async (links: unknown[]) => links),
      } as unknown as NameResolverService,
      {
        assertAssigneeMember: jest.fn(),
        resolveMemberName: jest.fn().mockResolvedValue(''),
      } as unknown as ProjectMembersService,
    );
    await svc.create(
      { project_id: 'p1', type: 'task', title: 'T', assignee_id: 'u1', has_due_date: false },
      { mode: 'all', level: 'all', selfId: 'u1', ownerIds: [], sharedRecordIds: [] },
    );
    expect(inserted?.overdueNotifiedAt).toBeNull();
  });

  it('claimOverdueNotification is idempotent (first true, second false)', async () => {
    const oid = new ObjectId();
    const id = oid.toString();
    let notifiedAt: number | null = null;
    const coll = {
      findOneAndUpdate: jest.fn(
        async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
          if (filter.overdueNotifiedAt != null && filter.overdueNotifiedAt !== null) return null;
          if (notifiedAt != null) return null;
          notifiedAt = Number(update.$set.overdueNotifiedAt);
          return { _id: oid, projectId: 'p1', overdueNotifiedAt: notifiedAt };
        },
      ),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      {} as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    expect(await svc.claimOverdueNotification('p1', id)).toBe(true);
    expect(await svc.claimOverdueNotification('p1', id)).toBe(false);
    expect(coll.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(notifiedAt).toEqual(expect.any(Number));
  });

  it('claimOverdueNotification rejects invalid activity id', async () => {
    const coll = { findOneAndUpdate: jest.fn() };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      {} as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    expect(await svc.claimOverdueNotification('p1', 'not-an-object-id')).toBe(false);
    expect(coll.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
