import { ObjectId } from 'mongodb';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService.claimReminderFire (TODO-116)', () => {
  function make(overrides?: { claim?: boolean }) {
    const oid = new ObjectId();
    const fireAt = Date.now() - 1_000;
    const doc = {
      _id: oid,
      projectId: 'p1',
      type: 'task',
      title: 'Call back',
      assigneeId: 'u1',
      dueDate: Date.now() + 3_600_000,
      reminderState: 'scheduled',
      reminderFireAt: fireAt,
      reminderOffset: '15m',
      links: [],
    };
    const findOneAndUpdate = jest.fn().mockResolvedValue(overrides?.claim === false ? null : doc);
    const coll = { findOneAndUpdate };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      {} as MongoOutboxStore,
      { resolveLinks: jest.fn(async (l: unknown[]) => l) } as unknown as NameResolverService,
      {} as ProjectMembersService,
    );
    return { svc, doc, fireAt, findOneAndUpdate };
  }

  it('claims scheduled reminder and returns row', async () => {
    const { svc, doc, fireAt } = make();
    const result = await svc.claimReminderFireWithRow(
      'p1',
      (doc._id as ObjectId).toString(),
      fireAt,
    );
    expect(result.claimed).toBe(true);
    expect(result.activity).toEqual(
      expect.objectContaining({ id: (doc._id as ObjectId).toString() }),
    );
  });

  it('is idempotent — second claim returns false', async () => {
    const { svc, doc, fireAt } = make({ claim: false });
    const id = (doc._id as ObjectId).toString();
    await expect(svc.claimReminderFire('p1', id, fireAt)).resolves.toBeNull();
  });

  it('rejects invalid activity id', async () => {
    const { svc } = make();
    await expect(svc.claimReminderFire('p1', 'bad-id', Date.now())).resolves.toBeNull();
  });
});
