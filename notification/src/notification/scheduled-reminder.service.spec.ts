import { ObjectId } from 'mongodb';
import { ScheduledReminderService } from './scheduled-reminder.service';
import { MongoService } from '../mongo/mongo.service';

describe('ScheduledReminderService (TODO-116)', () => {
  function make() {
    const store = new Map<string, Record<string, unknown>>();
    const coll = {
      updateOne: jest.fn(
        async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          opts?: { upsert?: boolean },
        ) => {
          const set = (update.$set ?? {}) as Record<string, unknown>;
          const setOnInsert = (update.$setOnInsert ?? {}) as Record<string, unknown>;
          const idFilter = filter._id as ObjectId | undefined;
          if (idFilter) {
            for (const [k, row] of store.entries()) {
              if (row._id?.toString() !== idFilter.toString()) continue;
              if (filter.status != null && row.status !== filter.status) continue;
              if (
                filter.fired_at &&
                typeof filter.fired_at === 'object' &&
                '$ne' in (filter.fired_at as Record<string, unknown>) &&
                row.fired_at == null
              ) {
                continue;
              }
              store.set(k, { ...row, ...set });
              return { upsertedCount: 0, modifiedCount: 1 };
            }
            return { upsertedCount: 0, modifiedCount: 0 };
          }
          const key = String(filter.dedup_key ?? '');
          const existing = store.get(key);
          if (!existing && opts?.upsert) {
            store.set(key, { _id: new ObjectId(), ...setOnInsert, ...set });
            return { upsertedCount: 1, modifiedCount: 0 };
          }
          if (existing) {
            store.set(key, { ...existing, ...set });
            return { upsertedCount: 0, modifiedCount: 1 };
          }
          return { upsertedCount: 0, modifiedCount: 0 };
        },
      ),
      updateMany: jest.fn(
        async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          let modified = 0;
          for (const [k, row] of store.entries()) {
            const matchKey = filter.reminder_key === row.reminder_key;
            const matchStatus = filter.status === row.status;
            if (matchKey && matchStatus) {
              store.set(k, { ...row, ...(update.$set as Record<string, unknown>) });
              modified++;
            }
          }
          return { modifiedCount: modified };
        },
      ),
      find: jest.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () =>
              [...store.values()].filter(
                (r) => r.status === 'pending' && Number(r.fire_at) <= Date.now(),
              ),
          }),
        }),
      })),
      findOneAndUpdate: jest.fn(
        async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          for (const row of store.values()) {
            if (
              row._id?.toString() === (filter._id as ObjectId)?.toString() &&
              row.status === filter.status
            ) {
              const before = { ...row };
              Object.assign(row, (update.$set ?? {}) as Record<string, unknown>);
              return before;
            }
          }
          return null;
        },
      ),
    };
    const mongo = { scheduledReminders: () => coll } as unknown as MongoService;
    return { svc: new ScheduledReminderService(mongo), coll, store };
  }

  it('upserts pending reminder from reminder_scheduled envelope', async () => {
    const { svc } = make();
    const ok = await svc.upsertFromEvent({
      projectId: 'p1',
      messageId: 'm1',
      subject: 'activity/a1',
      payload: {
        activityId: 'a1',
        recipientId: 'u1',
        fireAt: Date.now() + 60_000,
        title: 'Task',
      },
    } as never);
    expect(ok).toBe(true);
  });

  it('cancels pending rows by reminder key', async () => {
    const { svc } = make();
    await svc.upsertFromEvent({
      projectId: 'p1',
      messageId: 'm1',
      payload: {
        activityId: 'a1',
        recipientId: 'u1',
        fireAt: Date.now() + 60_000,
        reminderKey: 'activity.reminder:a1',
      },
    } as never);
    const n = await svc.cancelByReminderKey('activity.reminder:a1');
    expect(n).toBe(1);
  });

  it('does not resurrect a fired row on reminder_scheduled replay', async () => {
    const { svc, store } = make();
    const env = {
      projectId: 'p1',
      messageId: 'm-replay',
      payload: {
        activityId: 'a1',
        recipientId: 'u1',
        fireAt: Date.now() + 60_000,
        reminderKey: 'activity.reminder:a1',
      },
    } as never;
    await svc.upsertFromEvent(env);
    const key = [...store.keys()][0];
    const row = store.get(key)!;
    row.status = 'fired';
    row.fired_at = Date.now();
    await svc.upsertFromEvent(env);
    expect(store.get(key)?.status).toBe('fired');
  });

  it('returns false when reminder payload is incomplete', async () => {
    const { svc } = make();
    await expect(
      svc.upsertFromEvent({ projectId: '', messageId: 'm1', payload: {} } as never),
    ).resolves.toBe(false);
  });

  it('findDueCandidates returns pending rows at or before now', async () => {
    const { svc, store } = make();
    await svc.upsertFromEvent({
      projectId: 'p1',
      messageId: 'm1',
      payload: { activityId: 'a1', recipientId: 'u1', fireAt: Date.now() - 1_000 },
    } as never);
    const due = await svc.findDueCandidates(10);
    expect(due).toHaveLength(1);
    expect(store.size).toBe(1);
  });

  it('claimDue atomically marks a pending row as fired', async () => {
    const { svc } = make();
    await svc.upsertFromEvent({
      projectId: 'p1',
      messageId: 'm1',
      payload: { activityId: 'a1', recipientId: 'u1', fireAt: Date.now() - 1_000 },
    } as never);
    const [candidate] = await svc.findDueCandidates(1);
    const claimed = await svc.claimDue(candidate._id);
    expect(claimed?.status).toBe('pending');
    const second = await svc.claimDue(candidate._id);
    expect(second).toBeNull();
  });

  it('releaseClaim returns row to pending; markCancelled sets cancelled status', async () => {
    const { svc, store } = make();
    await svc.upsertFromEvent({
      projectId: 'p1',
      messageId: 'm1',
      payload: { activityId: 'a1', recipientId: 'u1', fireAt: Date.now() - 1_000 },
    } as never);
    const [candidate] = await svc.findDueCandidates(1);
    await svc.claimDue(candidate._id);
    const key = [...store.keys()][0];
    expect(store.get(key)?.status).toBe('fired');

    await svc.releaseClaim(candidate._id);
    expect(store.get(key)?.status).toBe('pending');
    expect(store.get(key)?.fired_at).toBeNull();

    await svc.markCancelled(candidate._id);
    expect(store.get(key)?.status).toBe('cancelled');
    expect(store.get(key)?.cancelled_at).toEqual(expect.any(Number));
  });
});
