import { ObjectId } from 'mongodb';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('ActivityService.syncLinksForEntity (FR-ACTIVITIES-250)', () => {
  it('marks matching links orphaned on delete events', async () => {
    const oid = new ObjectId();
    let savedLinks: unknown;
    const coll = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            {
              _id: oid,
              links: [
                { entityType: 'deal', entityId: 'd1', nameSnapshot: 'Deal', orphaned: false },
              ],
            },
          ]),
        }),
      }),
      updateOne: jest.fn((_f, u: { $set: { links: unknown } }) => {
        savedLinks = u.$set.links;
        return Promise.resolve({ modifiedCount: 1 });
      }),
    };
    const mongo = { activities: () => coll } as unknown as MongoService;
    const svc = new ActivityService(
      mongo,
      {} as MongoOutboxStore,
      {} as NameResolverService,
      {} as ProjectMembersService,
    );
    const { updated } = await svc.syncLinksForEntity('p1', 'deal', 'd1', 'orphan');
    expect(updated).toBe(1);
    expect(savedLinks).toEqual([
      { entityType: 'deal', entityId: 'd1', nameSnapshot: '', orphaned: true },
    ]);
  });
});
