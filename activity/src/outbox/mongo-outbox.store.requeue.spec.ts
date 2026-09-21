import { MongoOutboxStore } from './mongo-outbox.store';
import { MongoService } from '../mongo/mongo.service';

describe('NFR-ACT-070 outbox failed redelivery', () => {
  it('requeueStaleFailed flips stale failed rows back to pending', async () => {
    const rows = [
      { messageId: 'm1', status: 'failed', updatedAt: new Date(0) },
      { messageId: 'm2', status: 'pending', updatedAt: new Date(0) },
    ];
    const coll = {
      find: jest.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => rows.filter((r) => r.status === 'failed'),
          }),
        }),
      })),
      updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
    };
    const mongo = { outbox: async () => coll } as unknown as MongoService;
    const store = new MongoOutboxStore(mongo);
    const at = new Date(120_000);
    const count = await store.requeueStaleFailed(at, 60_000, 10);
    expect(count).toBe(1);
    expect(coll.updateMany).toHaveBeenCalledWith(
      { messageId: { $in: ['m1'] }, status: 'failed' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'pending', attempts: 0 }),
      }),
    );
  });
});
