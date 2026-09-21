import { ObjectId } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService reminder anchor + restore links', () => {
  const projectId = 'proj-1';
  const assigneeId = 'user-1';
  const meetingStart = Date.parse('2026-08-20T10:00:00.000Z');
  const meetingEnd = Date.parse('2026-08-20T11:00:00.000Z');

  function makeCreateHarness() {
    let inserted: Record<string, unknown> | null = null;
    const coll = {
      insertOne: jest.fn((doc: Record<string, unknown>) => {
        inserted = doc;
        return Promise.resolve({ insertedId: doc._id });
      }),
      findOne: jest.fn(() => Promise.resolve(inserted)),
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
    const nameResolver = {
      resolveLinks: jest.fn((_pid: string, links: unknown[]) => Promise.resolve(links)),
    } as unknown as NameResolverService;
    const projectMembers = {
      assertAssigneeMember: jest.fn().mockResolvedValue(undefined),
      resolveMemberName: jest.fn().mockResolvedValue(''),
    } as unknown as ProjectMembersService;
    const svc = new ActivityService(mongo, outbox, nameResolver, projectMembers);
    return { svc, getInserted: () => inserted, nameResolver };
  }

  function makeRestoreHarness(
    doc: Record<string, unknown>,
    resolveOverride?: (links: unknown[]) => unknown[],
  ) {
    let updatedSet: Record<string, unknown> | null = null;
    const coll = {
      findOne: jest.fn((filter: Record<string, unknown>) => {
        const idFilter =
          filter._id ?? (filter.$and as Record<string, unknown>[] | undefined)?.[0]?._id;
        if (idFilter && String(idFilter) === String(doc._id)) {
          return Promise.resolve(doc);
        }
        return Promise.resolve(null);
      }),
      updateOne: jest.fn((_q: unknown, { $set }: { $set: Record<string, unknown> }) => {
        updatedSet = $set;
        Object.assign(doc, $set);
        return Promise.resolve({ modifiedCount: 1 });
      }),
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
    const nameResolver = {
      resolveLinks: jest.fn((_pid: string, links: unknown[]) =>
        Promise.resolve(
          resolveOverride
            ? resolveOverride(links)
            : (links as Array<{ entityType: string; entityId: string }>).map((l) => ({
                ...l,
                nameSnapshot: 'Resolved',
                orphaned: false,
              })),
        ),
      ),
    } as unknown as NameResolverService;
    const projectMembers = {} as unknown as ProjectMembersService;
    const svc = new ActivityService(mongo, outbox, nameResolver, projectMembers);
    return { svc, getUpdatedSet: () => updatedSet, nameResolver };
  }

  it('schedules meeting reminder from startDate when dueDate is null (FR-ACTIVITIES-070)', async () => {
    const { svc, getInserted } = makeCreateHarness();
    await svc.create({
      project_id: projectId,
      type: 'meeting',
      title: 'Sync',
      assignee_id: assigneeId,
      start_date: meetingStart,
      end_date: meetingEnd,
      reminder_offset: '15m',
    });
    const doc = getInserted();
    expect(doc).not.toBeNull();
    expect(doc!.dueDate).toBeNull();
    expect(doc!.reminderFireAt).toBe(meetingStart - 15 * 60_000);
    expect(doc!.reminderState).toBe('scheduled');
  });

  it('rejects reminderOffset without anchor (BR-ACTIVITIES-160)', async () => {
    const { svc } = makeCreateHarness();
    await expect(
      svc.create({
        project_id: projectId,
        type: 'task',
        title: 'Explicit empty due',
        assignee_id: assigneeId,
        has_due_date: true,
        due_date: null,
        reminder_offset: '1h',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('reminderOffset'),
    });
  });

  it('restore re-resolves links via nameResolver (FR-ACTIVITIES-130)', async () => {
    const id = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: id,
      projectId,
      type: 'task',
      title: 'Trashed',
      assigneeId,
      status: 'planned',
      deletedAt: Date.now() - 1000,
      links: [{ entityType: 'deal', entityId: 'deal-1', nameSnapshot: '', orphaned: true }],
      reminderOffset: 'none',
      reminderState: 'none',
      reminderFireAt: null,
    };
    const scope: VisibilityScope = {
      mode: 'all',
      level: 'custom',
      selfId: assigneeId,
      ownerIds: [assigneeId],
      sharedRecordIds: [],
    };
    const { svc, getUpdatedSet, nameResolver } = makeRestoreHarness(doc);
    await svc.restore(projectId, id.toString(), scope, true);
    expect(nameResolver.resolveLinks).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([expect.objectContaining({ entityType: 'deal', entityId: 'deal-1' })]),
    );
    expect(getUpdatedSet()?.links).toEqual([
      { entityType: 'deal', entityId: 'deal-1', nameSnapshot: 'Resolved', orphaned: false },
    ]);
  });

  it('restore keeps stored snapshot on transient resolve failure (fail-soft)', async () => {
    const id = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: id,
      projectId,
      type: 'task',
      title: 'Trashed',
      assigneeId,
      status: 'planned',
      deletedAt: Date.now() - 1000,
      links: [
        { entityType: 'deal', entityId: 'deal-1', nameSnapshot: 'Old name', orphaned: false },
      ],
      reminderOffset: 'none',
      reminderState: 'none',
      reminderFireAt: null,
    };
    const scope: VisibilityScope = {
      mode: 'all',
      level: 'custom',
      selfId: assigneeId,
      ownerIds: [assigneeId],
      sharedRecordIds: [],
    };
    // Donor down: resolver returns empty snapshot without orphaned flag.
    const { svc, getUpdatedSet } = makeRestoreHarness(doc, (links) =>
      (links as Array<{ entityType: string; entityId: string }>).map((l) => ({
        ...l,
        nameSnapshot: '',
        orphaned: false,
      })),
    );
    await svc.restore(projectId, id.toString(), scope, true);
    expect(getUpdatedSet()?.links).toEqual([
      { entityType: 'deal', entityId: 'deal-1', nameSnapshot: 'Old name', orphaned: false },
    ]);
  });
});
