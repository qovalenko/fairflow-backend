import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  withIdempotency,
  isDuplicateKeyError,
  type IdempotencyCollection,
  type IdempotencyRecord,
} from './idempotency';

/**
 * In-memory {@link IdempotencyCollection} with a real unique `{projectId, key}`
 * constraint so `insertOne` throws a MongoDB-shaped duplicate-key error (code
 * 11000) — the exact race the algorithm must survive.
 */
class FakeCollection implements IdempotencyCollection {
  private rows: IdempotencyRecord[] = [];

  private index(projectId: string, key: string): number {
    return this.rows.findIndex((r) => r.projectId === projectId && r.key === key);
  }

  async insertOne(doc: IdempotencyRecord): Promise<unknown> {
    if (this.index(doc.projectId, doc.key) >= 0) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    // Store a copy so later mutation of the input can't leak in.
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

  size(): number {
    return this.rows.length;
  }
}

describe('withIdempotency', () => {
  const projectId = 'proj-1';

  it('runs the executor when no key is provided (no dedup)', async () => {
    const coll = new FakeCollection();
    const exec = jest.fn().mockResolvedValue({ id: 'a' });

    const r1 = await withIdempotency(coll, { projectId, key: undefined, operation: 'create' }, exec);
    const r2 = await withIdempotency(coll, { projectId, key: '   ', operation: 'create' }, exec);

    expect(r1).toEqual({ id: 'a' });
    expect(r2).toEqual({ id: 'a' });
    expect(exec).toHaveBeenCalledTimes(2);
    // Nothing persisted when there is no key.
    expect(coll.size()).toBe(0);
  });

  it('first call executes; a duplicate returns the same result without re-running', async () => {
    const coll = new FakeCollection();
    let n = 0;
    const exec = jest.fn().mockImplementation(async () => ({ id: `id-${++n}` }));

    const first = await withIdempotency(coll, { projectId, key: 'k1', operation: 'create' }, exec);
    const replay = await withIdempotency(coll, { projectId, key: 'k1', operation: 'create' }, exec);

    expect(first).toEqual({ id: 'id-1' });
    expect(replay).toEqual({ id: 'id-1' }); // identical to the first response
    expect(exec).toHaveBeenCalledTimes(1); // executor NOT run again
  });

  it('scopes the key by operation so one header cannot collapse two operations', async () => {
    const coll = new FakeCollection();
    const createExec = jest.fn().mockResolvedValue({ id: 'created' });
    const mergeExec = jest.fn().mockResolvedValue({ id: 'merged' });

    const created = await withIdempotency(
      coll,
      { projectId, key: 'same-header', operation: 'create' },
      createExec,
    );
    const merged = await withIdempotency(
      coll,
      { projectId, key: 'same-header', operation: 'merge' },
      mergeExec,
    );

    expect(created).toEqual({ id: 'created' });
    expect(merged).toEqual({ id: 'merged' });
    expect(createExec).toHaveBeenCalledTimes(1);
    expect(mergeExec).toHaveBeenCalledTimes(1);
  });

  it('isolates the same key across projects', async () => {
    const coll = new FakeCollection();
    const exec = jest
      .fn()
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce({ id: 'p2' });

    const a = await withIdempotency(coll, { projectId: 'A', key: 'k', operation: 'create' }, exec);
    const b = await withIdempotency(coll, { projectId: 'B', key: 'k', operation: 'create' }, exec);

    expect(a).toEqual({ id: 'p1' });
    expect(b).toEqual({ id: 'p2' });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('replays non-create shapes (merge/import) verbatim', async () => {
    const coll = new FakeCollection();
    const summary = { created: 3, skipped: 1, errors: ['Row 2: missing name'] };
    const exec = jest.fn().mockResolvedValue(summary);

    const first = await withIdempotency(coll, { projectId, key: 'imp', operation: 'import' }, exec);
    const replay = await withIdempotency(coll, { projectId, key: 'imp', operation: 'import' }, exec);

    expect(first).toEqual(summary);
    expect(replay).toEqual(summary);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('concurrent duplicate waits and receives the first run result (race)', async () => {
    const coll = new FakeCollection();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = jest.fn().mockImplementation(async () => {
      await gate; // hold the claim in `pending` while the duplicate races in
      return { id: 'winner' };
    });

    const firstP = withIdempotency(coll, { projectId, key: 'race', operation: 'create' }, exec);
    // Let the first insert its `pending` claim before the duplicate arrives.
    await new Promise((r) => setTimeout(r, 5));
    const secondP = withIdempotency(
      coll,
      { projectId, key: 'race', operation: 'create', waitDelayMs: 20 },
      exec,
    );
    // Complete the first mutation; the second should observe `done` and replay it.
    setTimeout(() => release(), 10);

    const [first, second] = await Promise.all([firstP, secondP]);
    expect(first).toEqual({ id: 'winner' });
    expect(second).toEqual({ id: 'winner' });
    expect(exec).toHaveBeenCalledTimes(1); // executor ran exactly once
  });

  it('fails FAILED_PRECONDITION when a concurrent claim never completes in the wait window', async () => {
    const coll = new FakeCollection();
    const exec = jest.fn().mockImplementation(() => new Promise(() => undefined)); // never resolves

    // Own the claim (stays pending forever).
    void withIdempotency(coll, { projectId, key: 'stuck', operation: 'create' }, exec);
    await new Promise((r) => setTimeout(r, 5));

    await expect(
      withIdempotency(
        coll,
        { projectId, key: 'stuck', operation: 'create', waitAttempts: 2, waitDelayMs: 5 },
        exec,
      ),
    ).rejects.toBeInstanceOf(RpcException);

    // Confirm the gRPC status code carried by the exception.
    try {
      await withIdempotency(
        coll,
        { projectId, key: 'stuck', operation: 'create', waitAttempts: 1, waitDelayMs: 5 },
        exec,
      );
      fail('expected rejection');
    } catch (err) {
      expect((err as RpcException).getError()).toMatchObject({ code: status.FAILED_PRECONDITION });
    }
  });

  it('releases the claim when the executor throws so a retry can re-attempt', async () => {
    const coll = new FakeCollection();
    const exec = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'ok' });

    await expect(
      withIdempotency(coll, { projectId, key: 'retry', operation: 'create' }, exec),
    ).rejects.toThrow('boom');
    // Claim rolled back — nothing lingers.
    expect(coll.size()).toBe(0);

    const retried = await withIdempotency(coll, { projectId, key: 'retry', operation: 'create' }, exec);
    expect(retried).toEqual({ id: 'ok' });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('persists the extracted recordId (default `.id`) on the ledger row', async () => {
    const coll = new FakeCollection();
    await withIdempotency(coll, { projectId, key: 'rec', operation: 'create' }, async () => ({
      id: 'the-id',
    }));
    const row = await coll.findOne({ projectId, key: 'create:rec' });
    expect(row?.recordId).toBe('the-id');
    expect(row?.status).toBe('done');
  });
});

describe('isDuplicateKeyError', () => {
  it('detects MongoDB duplicate-key (11000) and nothing else', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 121 })).toBe(false);
    expect(isDuplicateKeyError(new Error('x'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
