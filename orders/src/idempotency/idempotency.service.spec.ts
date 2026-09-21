import { IdempotencyService } from './idempotency.service';
import type { IdempotencyCollection, IdempotencyRecord } from '@fairflow/shared';

class FakeCollection implements IdempotencyCollection {
  private rows: IdempotencyRecord[] = [];

  private index(projectId: string, key: string): number {
    return this.rows.findIndex((r) => r.projectId === projectId && r.key === key);
  }

  async insertOne(doc: IdempotencyRecord): Promise<unknown> {
    if (this.index(doc.projectId, doc.key) >= 0) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    this.rows.push({ ...doc });
    return { insertedId: '1' };
  }

  async findOne(filter: { projectId: string; key: string }): Promise<IdempotencyRecord | null> {
    const i = this.index(filter.projectId, filter.key);
    return i >= 0 ? { ...this.rows[i] } : null;
  }

  async updateOne(
    filter: { projectId: string; key: string },
    update: { $set: Partial<IdempotencyRecord> },
  ): Promise<unknown> {
    const i = this.index(filter.projectId, filter.key);
    if (i >= 0) this.rows[i] = { ...this.rows[i], ...update.$set };
    return { matchedCount: i >= 0 ? 1 : 0 };
  }

  async deleteOne(filter: { projectId: string; key: string }): Promise<unknown> {
    const i = this.index(filter.projectId, filter.key);
    if (i >= 0) this.rows.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
}

describe('IdempotencyService', () => {
  const coll = new FakeCollection();
  const mongo = { idempotencyKeys: () => coll };
  const service = new IdempotencyService(mongo as never);

  it('replays the first response when the same idempotency key is retried', async () => {
    let n = 0;
    const exec = jest.fn(async () => ({ id: `o-${++n}` }));

    const first = await service.withIdempotency('p1', 'hdr-1', 'create', exec);
    const replay = await service.withIdempotency('p1', 'hdr-1', 'create', exec);

    expect(first).toEqual({ id: 'o-1' });
    expect(replay).toEqual({ id: 'o-1' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('runs twice when no idempotency key is supplied', async () => {
    let n = 0;
    const exec = jest.fn(async () => ({ id: `o-${++n}` }));

    await service.withIdempotency('p1', undefined, 'create', exec);
    await service.withIdempotency('p1', '', 'create', exec);

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('scopes keys by operation so one header cannot collapse two ops', async () => {
    const createExec = jest.fn().mockResolvedValue({ id: 'created' });
    const mergeExec = jest.fn().mockResolvedValue({ id: 'merged' });

    await service.withIdempotency('p1', 'same', 'create', createExec);
    await service.withIdempotency('p1', 'same', 'merge', mergeExec);

    expect(createExec).toHaveBeenCalledTimes(1);
    expect(mergeExec).toHaveBeenCalledTimes(1);
  });
});
