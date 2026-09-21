import { ActionDispatcher, type ActionResult } from './action-dispatcher.service';
import { DlqRetryService } from './dlq-retry.service';
import {
  DLQ_EXHAUSTED,
  backoffMs,
  freshIdempotencyKey,
  isRetryableFailure,
  regeneratePayload,
  type DlqRow,
} from './dlq-retry.policy';
import { FinalActionConsumerService } from './final-action.consumer';
import type { MongoService } from '../mongo/mongo.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ExecutorRegistry } from './executors/executor-registry.service';
import type { SecretProviderRegistry } from './secret-provider';
import type { ExecutorOutcome } from './executors/executor.types';

type AnyRec = Record<string, unknown>;

/**
 * TODO-041 — a DLQ row that can actually come back.
 *
 * Two halves used to be missing. `next_retry_at` was on the wire and in the
 * schema but NOTHING ever wrote it on insert and nothing ever read it, so a
 * failed external action waited for a human forever. And the retry, when a human
 * did press it, replayed the stored payload verbatim — same idempotency key —
 * which the receiver recognised as a duplicate and dropped, leaving the order it
 * was meant to rescue stuck in SENDING. Both are pinned here.
 */

/**
 * Mongo-ish filter matcher: enough of the query language for the sweeper's two
 * selects (`next_retry_at` range, `updated_at` lease bound) and the conditional
 * write-backs (`status`, `status:{$in}`).
 */
function matchesFilter(row: DlqRow, filter: AnyRec): boolean {
  return Object.entries(filter).every(([field, cond]) => {
    const actual = (row as unknown as AnyRec)[field];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as AnyRec;
      if ('$in' in c && !(c.$in as unknown[]).includes(actual)) return false;
      if ('$gt' in c && !(Number(actual ?? 0) > Number(c.$gt))) return false;
      if ('$lte' in c && !(Number(actual ?? 0) <= Number(c.$lte))) return false;
      return true;
    }
    return actual === cond;
  });
}

/** Minimal in-memory `automation_dlq` with the operations the service uses. */
function makeDlqStore(rows: DlqRow[]) {
  const updates: Array<{ filter: AnyRec; set: AnyRec }> = [];
  const collection = {
    find: (filter: AnyRec) => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => rows.filter((r) => matchesFilter(r, filter)),
        }),
      }),
    }),
    findOneAndUpdate: async (filter: AnyRec, update: AnyRec) => {
      const row = rows.find((r) => matchesFilter(r, filter));
      if (!row) return null;
      Object.assign(row, (update.$set as AnyRec) ?? {});
      for (const [k, v] of Object.entries((update.$inc as AnyRec) ?? {})) {
        const target = row as unknown as AnyRec;
        target[k] = Number(target[k] ?? 0) + Number(v);
      }
      return { ...row };
    },
    updateOne: async (filter: AnyRec, update: AnyRec) => {
      updates.push({ filter, set: (update.$set as AnyRec) ?? {} });
      const row = rows.find((r) => matchesFilter(r, filter));
      if (row) Object.assign(row, (update.$set as AnyRec) ?? {});
      return { matchedCount: row ? 1 : 0 };
    },
    insertOne: async () => ({}),
  };
  return { collection, rows, updates };
}

/** Rule the DLQ rows belong to, as the re-dispatch gate reads it back. */
type RuleDocLike = { id: string; enabled?: boolean; state?: string } | null;
const ACTIVE_RULE: RuleDocLike = { id: 'r1', enabled: true, state: 'enabled' };

/**
 * Mongo double: the DLQ collection plus the `automation_rules` lookup the retry
 * engine does before every re-dispatch (a rule disabled after the failure must
 * not keep firing from the ladder).
 */
function mongoOf(store: ReturnType<typeof makeDlqStore>, rule: RuleDocLike = ACTIVE_RULE) {
  return {
    dlq: () => store.collection,
    rules: () => ({ findOne: async () => rule }),
  } as unknown as MongoService;
}

function makeService(rows: DlqRow[], results: ActionResult[], rule: RuleDocLike = ACTIVE_RULE) {
  const store = makeDlqStore(rows);
  const mongo = mongoOf(store, rule);
  const dispatched: Array<{ type: string; action: AnyRec; ctx: AnyRec }> = [];
  let i = 0;
  const dispatcher = {
    dispatchOne: async (type: string, action: AnyRec, ctx: AnyRec) => {
      dispatched.push({ type, action, ctx });
      return results[Math.min(i++, results.length - 1)];
    },
  } as unknown as ActionDispatcher;
  const rabbit = mockRabbit();
  return { service: new DlqRetryService(mongo, dispatcher, rabbit), store, dispatched, rabbit };
}

function mockRabbit() {
  return { publishEnvelope: jest.fn(async () => undefined) } as unknown as RabbitMqService;
}

const row = (over: Partial<DlqRow> = {}): DlqRow => ({
  id: 'dlq-1',
  project_id: 'p1',
  execution_id: 'e1',
  rule_id: 'r1',
  action_index: 0,
  action_type: 'send_webhook',
  action_config_json: JSON.stringify({ type: 'send_webhook', connection_id: 'c1' }),
  connection_id: 'c1',
  payload_json: JSON.stringify({ order_id: 'o1', idempotency_key: 'o1:3:email:2:1' }),
  status: 'failed',
  attempts: 1,
  next_retry_at: 1_000,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const fail = (error: string, httpCode = 0): ActionResult => ({
  index: 0,
  type: 'send_webhook',
  status: 'fail',
  attempts: 1,
  error,
  http_code: httpCode,
});
const success = (): ActionResult => ({
  index: 0,
  type: 'send_webhook',
  status: 'success',
  attempts: 1,
  http_code: 200,
});

describe('fresh generation key (the rake that made retries no-ops)', () => {
  it('bumps sendGen and preserves payloadGen', () => {
    expect(freshIdempotencyKey('ord-1:1:email:3:1', 1)).toBe('ord-1:1:email:3:2');
    expect(freshIdempotencyKey('ord-1:1:email:3:2', 2)).toBe('ord-1:1:email:3:4');
  });

  it('gives a key without generations a pair of its own', () => {
    expect(freshIdempotencyKey('plain-key', 1)).toBe('plain-key:1:2');
  });

  it('rewrites every idempotency marker in the replayed payload', () => {
    const out = regeneratePayload(
      { order_id: 'o1', idempotency_key: 'o1:1:email:1:1', idempotencyKey: 'o1:1:email:1:1', keep: 'me' },
      1,
    );
    expect(out).toEqual({
      order_id: 'o1',
      idempotency_key: 'o1:1:email:1:2',
      idempotencyKey: 'o1:1:email:1:2',
      keep: 'me',
    });
  });

  it('the regenerated key is NOT deduped by the final-action claim (order leaves SENDING)', async () => {
    // The saga claims one doc per idempotencyKey and rejects anything already
    // terminal. Replaying the old key hits that guard, so the order that was
    // waiting in SENDING never gets its answer — the whole point of the retry.
    const terminal = { idempotency_key: 'o1:1:email:1:1', status: 'failed' };
    const finalActions = {
      findOne: async (f: AnyRec) => (f.idempotency_key === terminal.idempotency_key ? terminal : null),
      insertOne: async () => ({}),
      updateOne: async () => ({ modifiedCount: 1 }),
    };
    const consumer = new FinalActionConsumerService(
      {} as never,
      { finalActions: () => finalActions } as unknown as MongoService,
      {} as never,
      {} as never,
    );
    const claim = (
      consumer as unknown as {
        claim: (p: string, o: string, k: string, a: number) => Promise<boolean>;
      }
    ).claim.bind(consumer);

    expect(await claim('p1', 'o1', 'o1:1:email:1:1', 0)).toBe(false); // replayed key: swallowed
    expect(await claim('p1', 'o1', freshIdempotencyKey('o1:1:email:1:1', 1), 0)).toBe(true);
  });
});

describe('backoff ladder and retryability', () => {
  it('grows exponentially off the shared consumer ladder and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(300_000);
    expect(backoffMs(4)).toBe(600_000);
    expect(backoffMs(5)).toBe(1_200_000);
    expect(backoffMs(99)).toBe(3_600_000);
    // strictly increasing until the cap
    for (let a = 1; a < 6; a += 1) expect(backoffMs(a + 1)).toBeGreaterThan(backoffMs(a));
  });

  it('auto-retries transport faults but not config errors', () => {
    expect(isRetryableFailure('http_503', 503)).toBe(true);
    expect(isRetryableFailure('timeout')).toBe(true);
    expect(isRetryableFailure('breaker_open')).toBe(true);
    expect(isRetryableFailure('executor_transient:assign_user:14 UNAVAILABLE')).toBe(true);
    expect(isRetryableFailure('email_send_unavailable:boom')).toBe(true);

    expect(isRetryableFailure('http_400', 400)).toBe(false);
    expect(isRetryableFailure('connection_unavailable')).toBe(false);
    expect(isRetryableFailure('assign_user_rejected:not_found')).toBe(false);
    expect(isRetryableFailure('')).toBe(false);
  });
});

describe('background auto-retry sweep (next_retry_at finally has a reader)', () => {
  it('picks up only rows whose next_retry_at is due', async () => {
    const due = row({ id: 'due', next_retry_at: 500 });
    const later = row({ id: 'later', next_retry_at: 50_000 });
    const unscheduled = row({ id: 'never', next_retry_at: 0 });
    const { service, dispatched } = makeService([due, later, unscheduled], [success()]);

    const handled = await service.sweep(1_000);

    expect(handled).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctx).toMatchObject({ projectId: 'p1', source: 'dlq_retry', skipDlq: true });
    expect(due.status).toBe('resolved');
    expect(later.status).toBe('failed');
  });

  it('re-dispatches with a FRESH generation, never the key it is retrying', async () => {
    const target = row({ next_retry_at: 500 });
    const { service, dispatched } = makeService([target], [fail('timeout')]);

    await service.sweep(1_000);
    expect(dispatched[0].ctx.retryGeneration).toBe(1);
    expect((dispatched[0].ctx.payload as AnyRec).idempotency_key).toBe('o1:3:email:2:2');

    // Second automatic attempt: another generation, another key.
    target.next_retry_at = 500;
    target.status = 'failed';
    await service.sweep(1_000);
    expect(dispatched[1].ctx.retryGeneration).toBe(2);
    expect((dispatched[1].ctx.payload as AnyRec).idempotency_key).toBe('o1:3:email:2:3');
  });

  it('re-schedules with a GROWING backoff while the budget lasts', async () => {
    // `http_503`: the peer answered, so the outcome is KNOWN (nothing was
    // half-delivered) and the row keeps the full ladder — unlike a timeout,
    // which is capped at one automatic re-send.
    const target = row({ next_retry_at: 500, attempts: 1, max_attempts: 5 });
    const { service } = makeService([target], [fail('http_503', 503)]);

    const now = 1_000;
    await service.sweep(now);
    expect(target.status).toBe('failed');
    const firstDelay = Number(target.next_retry_at) - Date.now();
    expect(firstDelay).toBeGreaterThan(29_000);

    target.next_retry_at = 500;
    await service.sweep(now);
    const secondDelay = Number(target.next_retry_at) - Date.now();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('stops at the attempt cap with a terminal `exhausted` row (never spins forever)', async () => {
    const target = row({ next_retry_at: 500, attempts: 2, max_attempts: 3 });
    const { service, dispatched, rabbit } = makeService([target], [fail('http_503', 503)]);

    await service.sweep(1_000); // attempts 2 → 3 == cap
    expect(target.attempts).toBe(3);
    expect(target.status).toBe(DLQ_EXHAUSTED);
    expect(target.next_retry_at).toBe(0);
    expect(rabbit.publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'automation.dlq.exhausted' }),
    );

    // An exhausted row is no longer picked up by the sweeper.
    target.next_retry_at = 500;
    await service.sweep(1_000);
    expect(dispatched).toHaveLength(1);
  });

  it('does not auto-reschedule a config error (visible, manually retryable)', async () => {
    const target = row({ next_retry_at: 500 });
    const { service } = makeService([target], [fail('connection_unavailable')]);

    await service.sweep(1_000);
    expect(target.status).toBe('failed');
    expect(target.next_retry_at).toBe(0);
  });

  it('skips a project whose automation module is frozen (FR-LIFE-17)', async () => {
    const target = row({ next_retry_at: 500 });
    const store = makeDlqStore([target]);
    const dispatched: unknown[] = [];
    const service = new DlqRetryService(
      mongoOf(store),
      {
        dispatchOne: async () => {
          dispatched.push(1);
          return success();
        },
      } as unknown as ActionDispatcher,
      mockRabbit(),
      { isAutomationRuntimeActive: async () => false } as never,
    );

    expect(await service.sweep(1_000)).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(target.status).toBe('failed'); // preserved, not consumed
  });

  it('claims atomically, so a row already `retrying` is not dispatched twice', async () => {
    const target = row({ next_retry_at: 500, status: 'retrying' });
    // The sweep query only selects `failed`; even if a row slipped through, the
    // conditional claim refuses it.
    const { service, dispatched } = makeService([target], [success()]);
    expect(await service.sweep(1_000)).toBe(0);
    expect(dispatched).toHaveLength(0);
  });
});

describe('lease reclaim: a row stuck in `retrying` always comes back', () => {
  // The runner is not transactional: claim (failed → retrying) and settle are two
  // writes. A pod killed in between used to leave the row `retrying` FOREVER —
  // the due-select only reads `failed`, RetryDlq answers RETRY_IN_PROGRESS, and
  // nothing else in automation touches that status. Same wedge orders' SENDING
  // watchdog exists for.
  const LEASE = 300_000;
  const stuck = (over: Partial<DlqRow> = {}) =>
    row({ status: 'retrying', next_retry_at: 0, attempts: 1, retry_generation: 1, ...over });

  it('crash between claim and settle → the next sweep picks the row up', async () => {
    const now = Date.now();
    const orphan = stuck({ updated_at: now - LEASE - 1_000 });
    const { service, dispatched } = makeService([orphan], [success()]);

    expect(await service.sweep(now)).toBe(1);
    expect(dispatched).toHaveLength(1);
    // Re-dispatch, not a replay: a fresh generation, or the peer dedups the rescue.
    expect(dispatched[0].ctx.retryGeneration).toBe(2);
    expect((dispatched[0].ctx.payload as AnyRec).idempotency_key).toBe('o1:3:email:2:3');
    expect(orphan.status).toBe('resolved');
    expect(orphan.attempts).toBe(2);
  });

  it('does NOT steal a dispatch that is still in flight (lease alive)', async () => {
    const now = Date.now();
    const live = stuck({ updated_at: now - 5_000 });
    const { service, dispatched } = makeService([live], [success()]);

    expect(await service.sweep(now)).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(live.status).toBe('retrying');
  });

  it('reclaims atomically — only one of two racing sweepers takes the row', async () => {
    const now = Date.now();
    const orphan = stuck({ updated_at: now - LEASE - 1_000 });
    const store = makeDlqStore([orphan]);
    const mongo = mongoOf(store);
    const dispatched: unknown[] = [];
    const make = () =>
      new DlqRetryService(
        mongo,
        {
          dispatchOne: async () => {
            dispatched.push(1);
            return success();
          },
        } as unknown as ActionDispatcher,
        mockRabbit(),
      );

    const [a, b] = await Promise.all([make().sweep(now), make().sweep(now)]);
    expect(a + b).toBe(1);
    expect(dispatched).toHaveLength(1);
  });

  it('parks a reclaimed row whose budget is spent as `exhausted` — no free attempts', async () => {
    const now = Date.now();
    // A human retry of an exhausted row that then died mid-flight: attempts are
    // already past the cap, so the sweeper must not re-fire the effect for them.
    const orphan = stuck({ updated_at: now - LEASE - 1_000, attempts: 6, max_attempts: 5 });
    const { service, dispatched, rabbit } = makeService([orphan], [success()]);

    expect(await service.sweep(now)).toBe(1);
    expect(dispatched).toHaveLength(0);
    expect(orphan.status).toBe(DLQ_EXHAUSTED);
    expect(orphan.next_retry_at).toBe(0);
    expect(rabbit.publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'automation.dlq.exhausted' }),
    );
  });

  it('leaves an orphan of a frozen project alone (FR-LIFE-17)', async () => {
    const now = Date.now();
    const orphan = stuck({ updated_at: now - LEASE - 1_000 });
    const store = makeDlqStore([orphan]);
    const dispatched: unknown[] = [];
    const service = new DlqRetryService(
      mongoOf(store),
      {
        dispatchOne: async () => {
          dispatched.push(1);
          return success();
        },
      } as unknown as ActionDispatcher,
      mockRabbit(),
      { isAutomationRuntimeActive: async () => false } as never,
    );

    expect(await service.sweep(now)).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it('writes a success through onto a row FreezeRules parked mid-dispatch', async () => {
    // §3.22 flips `retrying` → `paused_*` under the flying dispatch, so settle's
    // conditional update matches nothing. Losing the outcome there would show a
    // DELIVERED action as pending, and the human retry after unfreeze would fire
    // the external effect a second time for real.
    const target = row({ next_retry_at: 500 });
    const store = makeDlqStore([target]);
    const service = new DlqRetryService(
      mongoOf(store),
      {
        dispatchOne: async () => {
          target.status = 'paused_module_disabled'; // freeze lands mid-dispatch
          return success();
        },
      } as unknown as ActionDispatcher,
      mockRabbit(),
    );

    await service.sweep(1_000);
    expect(target.status).toBe('resolved');
  });
});

describe('manual RetryDlq shares the same path', () => {
  it('claims, re-dispatches with a fresh generation and resolves on success', async () => {
    const target = row({ next_retry_at: 0 });
    const { service, dispatched } = makeService([target], [success()]);

    const settled = await service.retry('p1', 'dlq-1', 'failed');

    expect(settled?.status).toBe('resolved');
    expect(dispatched[0].ctx.retryGeneration).toBe(1);
    expect(target.attempts).toBe(2);
  });

  it('returns null when another caller already owns the row', async () => {
    const target = row({ status: 'retrying' });
    const { service } = makeService([target], [success()]);
    expect(await service.retry('p1', 'dlq-1', 'failed')).toBeNull();
  });

  it('lets a human retry an exhausted row', async () => {
    const target = row({ status: DLQ_EXHAUSTED, attempts: 5, max_attempts: 5, next_retry_at: 0 });
    const { service, dispatched } = makeService([target], [success()]);

    const settled = await service.retry('p1', 'dlq-1', DLQ_EXHAUSTED);
    expect(settled?.status).toBe('resolved');
    expect(dispatched).toHaveLength(1);
  });
});

describe('ActionDispatcher schedules the first auto-retry', () => {
  function makeDispatcher(outcome: ExecutorOutcome) {
    const dlqRows: AnyRec[] = [];
    const mongo = {
      dlq: () => ({
        insertOne: async (d: AnyRec) => {
          dlqRows.push(d);
          return { insertedId: d._id };
        },
      }),
    } as unknown as MongoService;
    const rabbit = { publish: async () => undefined, publishEnvelope: async () => undefined } as unknown as RabbitMqService;
    const executors = {
      forAction: () => ({ handles: ['send_email'], execute: async () => outcome }),
    } as unknown as ExecutorRegistry;
    return {
      dispatcher: new ActionDispatcher(mongo, rabbit, executors, {} as unknown as SecretProviderRegistry, { notify: async () => true } as never),
      dlqRows,
    };
  }
  const ctx = () => ({
    projectId: 'p1',
    ruleId: 'r1',
    executionId: 'e1',
    source: 'rule',
    payload: { order_id: 'o1' },
  });

  it('writes next_retry_at on a transient failure so the sweeper can find it', async () => {
    const { dispatcher, dlqRows } = makeDispatcher({
      ok: false,
      error: 'email_send_unavailable:14 UNAVAILABLE',
    });
    await dispatcher.dispatchOne('send_email', { config: {} }, ctx());

    expect(dlqRows).toHaveLength(1);
    expect(Number(dlqRows[0].next_retry_at)).toBeGreaterThan(Date.now());
    expect(Number(dlqRows[0].max_attempts)).toBeGreaterThan(1);
  });

  it('leaves next_retry_at at 0 for a config error (no auto-hammering)', async () => {
    const { dispatcher, dlqRows } = makeDispatcher({ ok: false, error: 'email_recipient_invalid' });
    await dispatcher.dispatchOne('send_email', { config: {} }, ctx());

    expect(dlqRows[0].next_retry_at).toBe(0);
  });

  it('gives a transient CRM action a DLQ row too, so it is retried rather than lost', async () => {
    const { dispatcher, dlqRows } = makeDispatcher({
      ok: false,
      error: 'executor_transient:assign_user:14 UNAVAILABLE',
    });
    const res = await dispatcher.dispatchOne('assign_user', { config: { userId: 'u1' } }, ctx());

    expect(res.status).toBe('fail');
    expect(res.dlq_id).toBeTruthy();
    expect(Number(dlqRows[0].next_retry_at)).toBeGreaterThan(Date.now());
  });

  it('does NOT create a DLQ row for a terminal CRM config error', async () => {
    const { dispatcher, dlqRows } = makeDispatcher({
      ok: false,
      error: 'update_field_unknown_field:deal.nope',
    });
    const res = await dispatcher.dispatchOne('update_field', { config: {} }, ctx());

    expect(res.status).toBe('fail');
    expect(res.dlq_id).toBeUndefined();
    expect(dlqRows).toHaveLength(0);
  });

  it('caps the ladder of an AMBIGUOUS external failure at one automatic re-send', async () => {
    // The mail relay took the message and timed out answering. "Failed" here is
    // not "not delivered", so the row gets ONE automatic re-send, not four.
    const { dispatcher, dlqRows } = makeDispatcher({
      ok: false,
      error: 'email_send_unavailable:4 DEADLINE_EXCEEDED',
    });
    await dispatcher.dispatchOne('send_email', { config: {} }, ctx());

    expect(Number(dlqRows[0].max_attempts)).toBe(2);
    expect(Number(dlqRows[0].next_retry_at)).toBeGreaterThan(Date.now());
  });

  it('keeps the full ladder when the request never left (unambiguous)', async () => {
    const { dispatcher, dlqRows } = makeDispatcher({
      ok: false,
      error: 'email_send_unavailable:14 UNAVAILABLE ECONNREFUSED',
    });
    await dispatcher.dispatchOne('send_email', { config: {} }, ctx());

    expect(Number(dlqRows[0].max_attempts)).toBe(5);
  });
});

describe('a retry runs the ORIGINAL actor, never the system one', () => {
  it('replays a user-initiated row under that user and their stored scope', async () => {
    const target = row({
      next_retry_at: 500,
      actor: 'user',
      actor_user_id: 'u-7',
      actor_visibility_scope: 'mode:own;selfId:u-7',
    });
    const { service, dispatched } = makeService([target], [success()]);

    await service.sweep(1_000);

    expect(dispatched[0].ctx).toMatchObject({
      actor: 'user',
      userId: 'u-7',
      visibilityScope: 'mode:own;selfId:u-7',
    });
  });

  it('does NOT widen a user row whose scope was not stored (fail-closed, not mode:all)', async () => {
    const target = row({ next_retry_at: 500, actor: 'user', actor_user_id: 'u-7' });
    const { service, dispatched } = makeService([target], [success()]);

    await service.sweep(1_000);

    // `system` is what would hand the run `mode:'all'` in buildServiceActorMetadata.
    expect(dispatched[0].ctx.actor).toBe('user');
    expect(dispatched[0].ctx.visibilityScope).toBe('');
  });

  it('treats a row written before the actor field as `user` (the restrictive branch)', async () => {
    const target = row({ next_retry_at: 500 }); // no actor/* fields at all
    const { service, dispatched } = makeService([target], [success()]);

    await service.sweep(1_000);

    expect(dispatched[0].ctx.actor).toBe('user');
    expect(dispatched[0].ctx.userId).toBe('');
  });

  it('keeps the system scope for a row born on the bus path', async () => {
    const target = row({ next_retry_at: 500, actor: 'system', actor_user_id: '' });
    const { service, dispatched } = makeService([target], [success()]);

    await service.sweep(1_000);

    expect(dispatched[0].ctx.actor).toBe('system');
  });

  it('re-sends the action at its ORIGINAL position (same delivery, not a new one)', async () => {
    const target = row({ next_retry_at: 500, action_index: 2 });
    const { service, dispatched } = makeService([target], [success()]);

    await service.sweep(1_000);

    expect(dispatched[0].ctx.actionIndex).toBe(2);
  });
});

describe('a retry is bounded by what the receiver can tell apart', () => {
  it('an ambiguous webhook timeout is re-sent once, then parked as exhausted', async () => {
    const target = row({ next_retry_at: 500, attempts: 1, max_attempts: 2 });
    const { service, dispatched } = makeService([target], [fail('timeout')]);

    await service.sweep(1_000); // attempts 1 → 2 == the ambiguous cap
    expect(dispatched).toHaveLength(1);
    expect(target.status).toBe(DLQ_EXHAUSTED);
    expect(target.next_retry_at).toBe(0);
  });

  it('still spends the full budget when the peer refused the connection', async () => {
    const target = row({ next_retry_at: 500, attempts: 1, max_attempts: 5 });
    const { service } = makeService([target], [fail('ECONNREFUSED')]);

    await service.sweep(1_000);
    expect(target.status).toBe('failed');
    expect(Number(target.next_retry_at)).toBeGreaterThan(Date.now());
  });
});

describe('a re-send needs a rule that still wants it', () => {
  it('stops the ladder when the rule was disabled after the failure', async () => {
    const target = row({ next_retry_at: 500 });
    const { service, dispatched } = makeService([target], [success()], {
      id: 'r1',
      enabled: false,
      state: 'disabled',
    });

    await service.sweep(1_000);

    expect(dispatched).toHaveLength(0); // no external effect from a disabled rule
    expect(target.status).toBe('failed');
    expect(target.next_retry_at).toBe(0);
    expect(target.last_error).toBe('rule_disabled_or_deleted');
    expect(target.attempts).toBe(1); // the refused claim gives its attempt back
  });

  it('stops the ladder when the rule was deleted', async () => {
    const target = row({ next_retry_at: 500 });
    const { service, dispatched } = makeService([target], [success()], null);

    await service.sweep(1_000);

    expect(dispatched).toHaveLength(0);
    expect(target.last_error).toBe('rule_disabled_or_deleted');
  });

  it('a Mongo blip is not "the rule is gone" — the row waits instead of dying', async () => {
    const target = row({ next_retry_at: 500 });
    const store = makeDlqStore([target]);
    const dispatched: unknown[] = [];
    const service = new DlqRetryService(
      {
        dlq: () => store.collection,
        rules: () => ({
          findOne: async () => {
            throw new Error('connection reset');
          },
        }),
      } as unknown as MongoService,
      {
        dispatchOne: async () => {
          dispatched.push(1);
          return success();
        },
      } as unknown as ActionDispatcher,
      mockRabbit(),
    );

    await service.sweep(1_000);

    expect(dispatched).toHaveLength(0);
    expect(target.status).toBe('failed');
    expect(Number(target.next_retry_at)).toBeGreaterThan(Date.now());
    expect(target.last_error).toBe('rule_unavailable');
  });

  it('blocks the manual button too — a disabled rule does not fire by hand either', async () => {
    const target = row({ next_retry_at: 0 });
    const { service, dispatched } = makeService([target], [success()], {
      id: 'r1',
      enabled: false,
    });

    const settled = await service.retry('p1', 'dlq-1', 'failed');

    expect(dispatched).toHaveLength(0);
    expect(settled?.last_error).toBe('rule_disabled_or_deleted');
  });
});
