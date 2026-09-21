import { ObjectId } from 'mongodb';
import { status } from '@grpc/grpc-js';
import type { EmitIntent } from '@fairflow/shared';
import { PipeService } from './pipe.service';

/**
 * Component tests for the deal close/reopen terminal-state machine
 * (closeDeal won/lost, reopenDeal) — the won/lost terminality invariants plus
 * the outbox event intents each transition emits. Mongo + the outbox are mocked
 * (the "publisher замокан" component level, QA-STRATEGY §7): the service logic
 * runs for real, and we capture the `EmitIntent[]` handed to `withOutbox` to
 * assert the exact bus events (crm.deal.won / crm.deal.lost / crm.deal.reopened)
 * without a broker. Pairs with pipe.service.move.spec.ts (stage moves) and the
 * real-Mongo pipe.service.integration.spec.ts.
 */
describe('PipeService — deal terminal lifecycle (close/reopen)', () => {
  const DEAL_ID = new ObjectId().toString();
  const PROJECT = 'p-own';

  let dealsFindOne: jest.Mock;
  let dealsUpdateOne: jest.Mock;
  let pipelinesFindOne: jest.Mock;
  let lostReasonsCount: jest.Mock;
  let lostReasonsFindOne: jest.Mock;
  /** Every intent handed to the outbox across the test — the "bus" we assert on. */
  let emitted: EmitIntent[];

  const mongo = {
    deals: () => ({ findOne: dealsFindOne, updateOne: dealsUpdateOne }),
    pipelines: () => ({ findOne: pipelinesFindOne }),
    lostReasons: () => ({ countDocuments: lostReasonsCount, findOne: lostReasonsFindOne }),
  };

  // Outbox that runs the work callback (standalone-Mongo/no-session path), records
  // the intents it returned, and yields the callback's `result` — mirrors the real
  // MongoOutboxStore.withOutbox contract so a captured intent === an event that
  // would be relayed to RabbitMQ.
  const outbox = {
    withOutbox: jest.fn(
      async (work: (s?: unknown) => Promise<{ result: unknown; intents: EmitIntent[] }>) => {
        const out = await work(undefined);
        emitted.push(...(out.intents ?? []));
        return out.result;
      },
    ),
  };

  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  const scope = {
    mode: 'all' as const,
    level: 'all' as const,
    selfId: 'u-1',
    ownerIds: [] as string[],
    sharedRecordIds: [] as string[],
  };

  const openDeal = (over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(DEAL_ID),
    projectId: PROJECT,
    pipelineId: 'pl-1',
    stageId: 'st1',
    name: 'Deal',
    amount: 5000,
    currency: 'RUB',
    status: 'open',
    assigneeId: 'u-1',
    ...over,
  });

  const pipeline = {
    projectId: PROJECT,
    id: 'pl-1',
    stages: [
      { id: 'st1', name: 'Новые', order: 0, kind: 'active' },
      { id: 'st2', name: 'В работе', order: 1, kind: 'active' },
      { id: 'won', name: 'Успех', order: 2, kind: 'won' },
      { id: 'lost', name: 'Провал', order: 3, kind: 'lost' },
    ],
  };

  beforeEach(() => {
    dealsFindOne = jest.fn();
    dealsUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    pipelinesFindOne = jest.fn().mockResolvedValue(pipeline);
    lostReasonsCount = jest.fn().mockResolvedValue(0);
    lostReasonsFindOne = jest.fn();
    emitted = [];
    outbox.withOutbox.mockClear();
  });

  const lastEventTypes = () => emitted.map((e) => e.type);

  // ── won ────────────────────────────────────────────────────────────────────
  describe('closeDeal(won)', () => {
    it('closes an open deal as won, moves it onto the kind=won stage and emits crm.deal.won', async () => {
      dealsFindOne
        .mockResolvedValueOnce(openDeal()) // getDeal pre-check
        .mockResolvedValueOnce(openDeal()) // raw read for snapshot payload
        .mockResolvedValueOnce(openDeal({ status: 'won', stageId: 'won' })); // getDeal post-close
      const res = await service.closeDeal(
        PROJECT,
        DEAL_ID,
        'won',
        undefined,
        undefined,
        scope,
        'u-1',
      );
      expect(res.status).toBe('won');
      // The close writes status=won, wonAt, wonVersion and the won-stage id (drift onto kind=won).
      const set = dealsUpdateOne.mock.calls[0][1].$set;
      expect(set.status).toBe('won');
      expect(set.stageId).toBe('won');
      expect(set.wonVersion).toBe(1);
      // Business-dedup key = dealId:wonVersion (protects orders from a duplicate order).
      const won = emitted.find((e) => e.type === 'crm.deal.won');
      expect(won?.idempotencyKey).toBe(`${DEAL_ID}:1`);
      expect(lastEventTypes()).toEqual(['crm.deal.won']);
    });

    it('the close updateOne carries the still-open TOCTOU guard in its filter', async () => {
      dealsFindOne
        .mockResolvedValueOnce(openDeal())
        .mockResolvedValueOnce(openDeal())
        .mockResolvedValueOnce(openDeal({ status: 'won' }));
      await service.closeDeal(PROJECT, DEAL_ID, 'won', undefined, undefined, scope, 'u-1');
      const filter = dealsUpdateOne.mock.calls[0][0];
      expect(filter).toMatchObject({ projectId: PROJECT });
      expect(filter.status).toEqual({ $nin: ['won', 'lost'] });
    });
  });

  // ── lost ─────────────────────────────────────────────────────────────────
  describe('closeDeal(lost)', () => {
    it('closes as lost and emits crm.deal.lost when no lost-reason dictionary exists', async () => {
      dealsFindOne
        .mockResolvedValueOnce(openDeal())
        .mockResolvedValueOnce(openDeal())
        .mockResolvedValueOnce(openDeal({ status: 'lost', stageId: 'lost' }));
      lostReasonsCount.mockResolvedValue(0);
      const res = await service.closeDeal(
        PROJECT,
        DEAL_ID,
        'lost',
        undefined,
        undefined,
        scope,
        'u-1',
      );
      expect(res.status).toBe('lost');
      const set = dealsUpdateOne.mock.calls[0][1].$set;
      expect(set.status).toBe('lost');
      expect(set.stageId).toBe('lost');
      expect(lastEventTypes()).toEqual(['crm.deal.lost']);
      const lost = emitted.find((e) => e.type === 'crm.deal.lost');
      expect(lost?.payload).toMatchObject({ dealId: DEAL_ID, assigneeId: 'u-1' });
    });

    it('requires a lostReasonId when the per-project dictionary is non-empty (FR-11)', async () => {
      dealsFindOne.mockResolvedValueOnce(openDeal());
      lostReasonsCount.mockResolvedValue(2);
      await expect(
        service.closeDeal(PROJECT, DEAL_ID, 'lost', undefined, undefined, scope, 'u-1'),
      ).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT, message: 'Укажите причину проигрыша' },
      });
      expect(dealsUpdateOne).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });

    it('rejects an unknown lostReasonId (not in this project dictionary)', async () => {
      dealsFindOne.mockResolvedValueOnce(openDeal());
      lostReasonsCount.mockResolvedValue(2);
      lostReasonsFindOne.mockResolvedValue(null);
      await expect(
        service.closeDeal(PROJECT, DEAL_ID, 'lost', 'lr-ghost', undefined, scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
    });
  });

  // ── invalid / terminal guards ───────────────────────────────────────────
  it('rejects an invalid result value (must be won|lost)', async () => {
    dealsFindOne.mockResolvedValueOnce(openDeal());
    await expect(
      service.closeDeal(PROJECT, DEAL_ID, 'maybe', undefined, undefined, scope, 'u-1'),
    ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
  });

  it('rejects closing an already-won deal (terminality, no re-publish)', async () => {
    dealsFindOne.mockResolvedValueOnce(openDeal({ status: 'won' }));
    await expect(
      service.closeDeal(PROJECT, DEAL_ID, 'lost', undefined, undefined, scope, 'u-1'),
    ).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Сделка уже закрыта' },
    });
    expect(dealsUpdateOne).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('TOCTOU: a concurrent close (matchedCount===0) throws and emits no won/lost event', async () => {
    dealsFindOne.mockResolvedValueOnce(openDeal()).mockResolvedValueOnce(openDeal());
    dealsUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(
      service.closeDeal(PROJECT, DEAL_ID, 'won', undefined, undefined, scope, 'u-1'),
    ).rejects.toMatchObject({ error: { code: status.FAILED_PRECONDITION } });
    expect(emitted).toEqual([]);
  });

  // ── reopen ─────────────────────────────────────────────────────────────
  describe('reopenDeal', () => {
    it('reopens a won deal onto an active stage and emits crm.deal.reopened', async () => {
      dealsFindOne
        .mockResolvedValueOnce(openDeal({ status: 'won', stageId: 'won' })) // pre-check
        .mockResolvedValueOnce(openDeal({ status: 'won', stageId: 'won' })) // stageLog eviction probe (TODO-383)
        .mockResolvedValueOnce(openDeal({ status: 'open', stageId: 'st2' })); // post read
      const res = await service.reopenDeal(PROJECT, DEAL_ID, 'мимо', 'st2', scope, 'u-1');
      expect(res.status).toBe('open');
      const set = dealsUpdateOne.mock.calls[0][1].$set;
      expect(set.status).toBe('open');
      expect(set.stageId).toBe('st2');
      // Terminal fields are cleared on reopen.
      expect(set.wonAt).toBe(0);
      expect(set.lostAt).toBe(0);
      expect(lastEventTypes()).toEqual(['crm.deal.reopened']);
      const reopened = emitted.find((e) => e.type === 'crm.deal.reopened');
      expect(reopened?.payload).toMatchObject({ dealId: DEAL_ID, assigneeId: 'u-1' });
      // The reopen updateOne is guarded to a still-closed deal (TOCTOU).
      expect(dealsUpdateOne.mock.calls[0][0].status).toEqual({ $in: ['won', 'lost'] });
    });

    it('rejects reopening an already-open deal', async () => {
      dealsFindOne.mockResolvedValueOnce(openDeal({ status: 'open' }));
      await expect(
        service.reopenDeal(PROJECT, DEAL_ID, 'r', 'st2', scope, 'u-1'),
      ).rejects.toMatchObject({
        error: { code: status.FAILED_PRECONDITION, message: 'Сделка уже открыта' },
      });
      expect(emitted).toEqual([]);
    });

    it('requires a non-empty reason', async () => {
      dealsFindOne.mockResolvedValueOnce(openDeal({ status: 'lost' }));
      await expect(
        service.reopenDeal(PROJECT, DEAL_ID, '   ', 'st2', scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
    });

    it('rejects reopening onto a non-active (won/lost) target stage', async () => {
      dealsFindOne.mockResolvedValueOnce(openDeal({ status: 'lost', stageId: 'lost' }));
      await expect(
        service.reopenDeal(PROJECT, DEAL_ID, 'r', 'won', scope, 'u-1'),
      ).rejects.toMatchObject({
        error: {
          code: status.INVALID_ARGUMENT,
          message: 'targetStageId должен быть активной стадией воронки',
        },
      });
      expect(dealsUpdateOne).not.toHaveBeenCalled();
    });
  });
});
