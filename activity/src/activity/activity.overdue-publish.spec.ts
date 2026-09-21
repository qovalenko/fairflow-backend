import { ObjectId } from 'mongodb';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService.publishOverdueEvent (FR-ACTIVITIES-310)', () => {
  function make(overrides?: { claim?: boolean; doc?: Record<string, unknown> }) {
    const oid = new ObjectId();
    const doc = overrides?.doc ?? {
      _id: oid,
      projectId: 'p1',
      type: 'task',
      title: 'Follow up',
      assigneeId: 'u1',
      dueDate: Date.now() - 60_000,
      links: [{ entityType: 'deal', entityId: 'd1', nameSnapshot: 'Big deal' }],
    };
    const find = jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([doc]) }),
    });
    const findOneAndUpdate = jest.fn().mockResolvedValue(overrides?.claim === false ? null : doc);
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const coll = {
      find,
      findOneAndUpdate,
      updateOne,
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    let capturedIntents: unknown[] = [];
    const outbox = {
      withOutbox: jest.fn(async (fn: (session?: unknown) => Promise<unknown>) => {
        const res = await fn(undefined);
        capturedIntents = (res as { intents?: unknown[] })?.intents ?? [];
        return (res as { result?: unknown })?.result;
      }),
    } as unknown as MongoOutboxStore;
    const svc = new ActivityService(
      mongo,
      outbox,
      { resolveLinks: jest.fn(async (l: unknown[]) => l) } as unknown as NameResolverService,
      {} as ProjectMembersService,
    );
    return {
      svc,
      doc,
      capturedIntents: () => capturedIntents,
      findOneAndUpdate,
      updateOne,
      outbox,
    };
  }

  it('findOverdueCandidates queries non-terminal overdue rows', async () => {
    const { svc } = make();
    const rows = await svc.findOverdueCandidates(50);
    expect(rows).toHaveLength(1);
  });

  it('publishOverdueEvent emits crm.activity.overdue on first claim', async () => {
    const { svc, doc, capturedIntents } = make();
    await expect(svc.publishOverdueEvent(doc)).resolves.toBe(true);
    expect(capturedIntents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'crm.activity.overdue',
          projectId: 'p1',
          idempotencyKey: `activity.overdue:${(doc._id as ObjectId).toString()}`,
          payload: expect.objectContaining({
            title: 'Follow up',
            dueDate: doc.dueDate,
            assigneeId: 'u1',
            activityId: (doc._id as ObjectId).toString(),
            links: [
              expect.objectContaining({
                entityType: 'deal',
                entityId: 'd1',
                nameSnapshot: 'Big deal',
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it('publishOverdueEvent is a no-op when claim fails', async () => {
    const { svc, doc, capturedIntents } = make({ claim: false });
    await expect(svc.publishOverdueEvent(doc)).resolves.toBe(false);
    expect(capturedIntents()).toEqual([]);
  });

  it('releases the claim when outbox enqueue fails so the next sweep can retry', async () => {
    const { svc, doc, updateOne, outbox } = make();
    (outbox.withOutbox as jest.Mock).mockRejectedValueOnce(new Error('broker down'));
    await expect(svc.publishOverdueEvent(doc)).rejects.toThrow('broker down');
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: doc._id,
        projectId: 'p1',
        overdueNotifiedAt: { $ne: null },
      }),
      expect.objectContaining({ $set: expect.objectContaining({ overdueNotifiedAt: null }) }),
    );
  });
});
