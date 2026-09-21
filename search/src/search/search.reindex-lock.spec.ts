/**
 * TODO-491 — the recovery reindex is a project-wide rebuild that ENDS with a
 * tombstone sweep, and it is reachable from the READ path (the lazy backfill of
 * `search()`), i.e. by any project member with `search:read`. Two things follow,
 * both regression-pinned here:
 *
 *  1. Two concurrent rebuilds are destructive, not merely wasteful: pass B
 *     rewrites the documents, pass A then sweeps everything it does not
 *     recognise and live records vanish from search until the next full rebuild.
 *     A second rebuild is therefore rejected with gRPC ABORTED (the gateway maps
 *     it to HTTP 409), and the sweep keys on THIS run's id rather than on a
 *     wall clock shared with the delta consumer.
 *
 *  2. A project that cannot complete (cut off by `SEARCH_REINDEX_MAX_DOCS`) is
 *     never stamped, so without a brake every debounced keystroke of every
 *     viewer would launch another six-collection scan. The catch-up attempt is
 *     rate-limited per project via `SEARCH_BACKFILL_RETRY_MS`.
 */
import { status } from '@grpc/grpc-js';
import { SearchService } from './search.service';
import type { VisibilityScope } from '@fairflow/shared';
import { buildMongo, row, type Row } from './fake-mongo.testkit';

const PID = 'proj-1';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

function contact(id: string, firstName: string, extra: Record<string, unknown> = {}): Row {
  return row(id, {
    projectId: PID,
    firstName,
    lastName: 'Zeta',
    ownerId: 'user-1',
    departmentId: 'dept-1',
    ...extra,
  });
}

const ENV_KEYS = [
  'SEARCH_REINDEX_MAX_DOCS',
  'SEARCH_REINDEX_BATCH',
  'SEARCH_BACKFILL_RETRY_MS',
  'SEARCH_REINDEX_LOCK_TTL_MS',
  'SEARCH_LAZY_BACKFILL',
] as const;

describe('reindex single-flight lock (TODO-491)', () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('rejects a second concurrent rebuild of the same project with ABORTED', async () => {
    const { mongo } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);

    // Hold the lock exactly as a running pass does, then try to start another.
    const held = await (
      svc as unknown as { acquireReindexLock(p: string): Promise<string | null> }
    ).acquireReindexLock(PID);
    expect(held).toBeTruthy();

    await expect(svc.reindex(PID, ['contact'])).rejects.toMatchObject({
      error: { code: status.ABORTED },
    });
  });

  it('declares uq_state_project, so the lock really is a CAS over ONE row', async () => {
    // The single-flight guarantee rests on "exactly one search_index_state row
    // per project": without the unique key two concurrent upserts of a missing
    // row both insert, each CAS then matches its own copy and both rebuilds run
    // (and findOne({projectId}) in backfill/status starts reading an arbitrary
    // copy). Pin the declaration, not just the runtime handling.
    const { mongo, state } = buildMongo();
    const svc = new SearchService(mongo as never);

    await svc.onModuleInit();

    expect(state.createdIndexes).toEqual([
      { key: { projectId: 1 }, opts: { name: 'uq_state_project', unique: true } },
    ]);
  });

  it('an insert lost to a concurrent starter (11000) is settled by the CAS, not by a 2nd row', async () => {
    const { mongo, state } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    const acquire = () =>
      (
        svc as unknown as { acquireReindexLock(p: string): Promise<string | null> }
      ).acquireReindexLock(PID);

    // Both first queries against an empty project reach acquire at once: the
    // rival's row lands between our filter and our insert, so Mongo answers our
    // upsert with 11000 (instead of quietly giving this project a second row).
    const real = state.updateOne.bind(state);
    jest.spyOn(state, 'updateOne').mockImplementation(async (filter, update, opts) => {
      if (opts?.upsert) {
        if (!state.docs.some((d) => d.projectId === PID)) {
          state.docs.push(row('rival', { projectId: PID }));
        }
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      return real(filter, update, opts);
    });

    // The rival had only created the row, so the lock is still free — we take it,
    // and the project still has exactly one bookkeeping row.
    const mine = await acquire();
    expect(mine).toBeTruthy();
    expect(state.docs.filter((d) => d.projectId === PID)).toHaveLength(1);

    // Now that a holder exists, the loser of the insert race gets nothing back —
    // it does NOT start a parallel rebuild off a private copy of the row.
    expect(await acquire()).toBeNull();
    jest.restoreAllMocks();
  });

  it('releases the lock so the next rebuild succeeds (also after a failure)', async () => {
    const { mongo, state } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact']);
    expect((state.docs[0] as { reindexLockAt?: number | null }).reindexLockAt).toBeNull();

    // A second, sequential rebuild is fine — the lock is single-FLIGHT, not once-only.
    await expect(svc.reindex(PID, ['contact'])).resolves.toMatchObject({ indexed_count: 1 });
  });

  it('a stale lock (holder died) expires and does not wedge the project forever', async () => {
    const { mongo, state } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    process.env.SEARCH_REINDEX_LOCK_TTL_MS = '1000';
    state.docs.push(
      row('s1', { projectId: PID, reindexLockAt: Date.now() - 60_000, reindexRunId: 'dead-run' }),
    );

    await expect(svc.reindex(PID, ['contact'])).resolves.toMatchObject({ indexed_count: 1 });
  });

  it('locks per project — a rebuild of another project is not blocked', async () => {
    const { mongo } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    await (
      svc as unknown as { acquireReindexLock(p: string): Promise<string | null> }
    ).acquireReindexLock(PID);

    await expect(svc.reindex('proj-2', ['contact'])).resolves.toMatchObject({ indexed_count: 0 });
  });

  it('sweeps by the run id, so a doc another writer touched later is still swept', async () => {
    // The vanished record carries a FUTURE updatedAt (a delta write from a replica
    // with a skewed clock). The old `updatedAt < now` sweep would have spared it
    // and the deleted record would stay findable.
    const future = Date.now() + 60_000;
    const { mongo, index } = buildMongo({
      index: [
        row('contact:gone', {
          projectId: PID,
          entityType: 'contact',
          entityId: 'gone',
          title: 'ghost record',
          tokens: 'ghost record',
          ownerId: 'user-1',
          deletedAt: null,
          version: future,
          updatedAt: future,
        }),
      ],
      contacts: [contact('c1', 'alphaone')],
    });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact']);

    expect(index.docs.find((d) => d.entityId === 'gone')?.deletedAt).toEqual(expect.any(Number));
    expect(index.docs.find((d) => d.entityId === 'c1')?.deletedAt).toBeNull();
  });
});

describe('lazy backfill catch-up back-off (TODO-491)', () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does not rebuild on every query while the index cannot be completed', async () => {
    // Budget smaller than the project → every pass is truncated and never stamped.
    process.env.SEARCH_REINDEX_MAX_DOCS = '1';
    process.env.SEARCH_BACKFILL_RETRY_MS = '600000';
    const { mongo, state } = buildMongo({
      contacts: [contact('c1', 'alphaone'), contact('c2', 'alphatwo')],
    });
    const svc = new SearchService(mongo as never);
    const reindex = jest.spyOn(svc, 'reindex');

    for (let i = 0; i < 5; i += 1) {
      await svc.search(PID, 'alpha', 0, 25, { entityTypes: ['contact'], ctx: { scope: ALL_SCOPE } });
    }

    // One catch-up pass, not one per keystroke.
    expect(reindex).toHaveBeenCalledTimes(1);
    const st = state.docs[0] as { backfillNextAttemptAt?: number; backfilledAt?: number };
    expect(st.backfillNextAttemptAt).toBeGreaterThan(Date.now());
    expect(st.backfilledAt).toBeUndefined();
  });

  it('retries once the window elapsed, and stops for good when the rebuild completes', async () => {
    process.env.SEARCH_REINDEX_MAX_DOCS = '1';
    process.env.SEARCH_BACKFILL_RETRY_MS = '600000';
    const { mongo, state } = buildMongo({
      contacts: [contact('c1', 'alphaone'), contact('c2', 'alphatwo')],
    });
    const svc = new SearchService(mongo as never);

    await svc.search(PID, 'alpha', 0, 25, { entityTypes: ['contact'], ctx: { scope: ALL_SCOPE } });
    expect((state.docs[0] as { backfilledAt?: number }).backfilledAt).toBeUndefined();

    // Window elapsed + budget lifted → the catch-up completes and stamps.
    (state.docs[0] as { backfillNextAttemptAt?: number }).backfillNextAttemptAt = Date.now() - 1;
    delete process.env.SEARCH_REINDEX_MAX_DOCS;
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });

    expect(res.total).toBe(2);
    const st = state.docs[0] as { backfilledAt?: number; backfillNextAttemptAt?: number | null };
    expect(st.backfilledAt).toBeGreaterThan(0);
    expect(st.backfillNextAttemptAt).toBeNull();
  });

  it('a search never fails because a concurrent rebuild holds the lock', async () => {
    const { mongo } = buildMongo({ contacts: [contact('c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    await (
      svc as unknown as { acquireReindexLock(p: string): Promise<string | null> }
    ).acquireReindexLock(PID);

    // Backfill wants to rebuild, gets ABORTED, swallows it: the query still answers.
    await expect(
      svc.search(PID, 'alpha', 0, 25, { entityTypes: ['contact'], ctx: { scope: ALL_SCOPE } }),
    ).resolves.toMatchObject({ total: 0 });
  });
});
