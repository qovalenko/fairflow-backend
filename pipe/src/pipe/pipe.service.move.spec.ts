import { ObjectId } from 'mongodb';
import { status } from '@grpc/grpc-js';
import { PipeService } from './pipe.service';

/**
 * Unit tests for PipeService.moveDealToStage — the real stage-transition logic
 * (invariants, project isolation, closed-deal guard, foreign-pipeline stage,
 * TOCTOU matchedCount===0). Mongo + outbox are mocked; the service logic runs.
 */
describe('PipeService.moveDealToStage', () => {
  const DEAL_ID = new ObjectId().toString();
  const PROJECT = 'p-own';

  // --- collection mocks -------------------------------------------------------
  let dealsFindOne: jest.Mock;
  let dealsUpdateOne: jest.Mock;
  let pipelinesFindOne: jest.Mock;

  const mongo = {
    deals: () => ({ findOne: dealsFindOne, updateOne: dealsUpdateOne }),
    pipelines: () => ({ findOne: pipelinesFindOne }),
  };

  // Outbox that runs the work callback with no session (standalone-Mongo path)
  // and returns the callback's `result` — mirrors the real MongoOutboxStore.
  const outbox = {
    withOutbox: jest.fn(async (work: (s?: unknown) => Promise<{ result: unknown }>) => {
      const { result } = await work(undefined);
      return result;
    }),
  };

  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  // A permissive "see all" scope — getDeal fails closed (returns 404) without one,
  // so every move test resolves the deal through an `all`-mode scope.
  const scope = {
    mode: 'all' as const,
    level: 'all' as const,
    selfId: 'u-1',
    ownerIds: [] as string[],
    sharedRecordIds: [] as string[],
  };

  /** A default open deal doc in pipeline pl-1 on stage st1. */
  const openDeal = (over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(DEAL_ID),
    projectId: PROJECT,
    pipelineId: 'pl-1',
    stageId: 'st1',
    name: 'Deal',
    status: 'open',
    assigneeId: '',
    ...over,
  });

  const pipeline = {
    projectId: PROJECT,
    id: 'pl-1',
    stages: [
      { id: 'st1', name: 'Новые', order: 0 },
      { id: 'st2', name: 'В работе', order: 1 },
    ],
  };

  beforeEach(() => {
    dealsFindOne = jest.fn();
    dealsUpdateOne = jest.fn();
    pipelinesFindOne = jest.fn();
    outbox.withOutbox.mockClear();
  });

  it('rejects a foreign/unknown dealId (findOne returns null → NOT_FOUND)', async () => {
    // getDeal cannot find the deal in this project → 404 (also the isolation path:
    // a foreign projectId never matches the {_id, projectId} filter).
    dealsFindOne.mockResolvedValue(null);
    await expect(service.moveDealToStage(PROJECT, DEAL_ID, 'st2')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
    expect(dealsUpdateOne).not.toHaveBeenCalled();
  });

  it('project isolation: getDeal is scoped by {_id, projectId} so another tenant cannot move it', async () => {
    dealsFindOne.mockResolvedValue(null);
    await service.moveDealToStage('p-foreign', DEAL_ID, 'st2').catch(() => undefined);
    expect(dealsFindOne).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-foreign' }));
  });

  it('rejects moving a won (closed) deal with FAILED_PRECONDITION', async () => {
    dealsFindOne.mockResolvedValue(openDeal({ status: 'won' }));
    pipelinesFindOne.mockResolvedValue(pipeline);
    await expect(service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope)).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Сделка закрыта' },
    });
    expect(dealsUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects moving a lost (closed) deal with FAILED_PRECONDITION', async () => {
    dealsFindOne.mockResolvedValue(openDeal({ status: 'lost' }));
    pipelinesFindOne.mockResolvedValue(pipeline);
    await expect(service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope)).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION },
    });
  });

  it('rejects a target stage that does not belong to the deal pipeline (INVALID_ARGUMENT)', async () => {
    dealsFindOne.mockResolvedValue(openDeal());
    pipelinesFindOne.mockResolvedValue(pipeline); // has st1, st2 — not "ghost"
    await expect(service.moveDealToStage(PROJECT, DEAL_ID, 'ghost', scope)).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'stageId не принадлежит воронке сделки' },
    });
    expect(dealsUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects a stage from another pipeline (resolveStage scopes by deal's pipeline → not found)", async () => {
    dealsFindOne.mockResolvedValue(openDeal());
    // resolveStage looks up pipelines by {projectId, id: current.pipeline_id='pl-1'};
    // the stage 'st9' (belonging to some other pipeline pl-2) is not in pl-1.
    pipelinesFindOne.mockResolvedValue(pipeline);
    await expect(service.moveDealToStage(PROJECT, DEAL_ID, 'st9', scope)).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('is a no-op when the target stage equals the current stage (returns the deal, no update)', async () => {
    dealsFindOne.mockResolvedValue(openDeal({ stageId: 'st2' }));
    pipelinesFindOne.mockResolvedValue(pipeline);
    const res = await service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope);
    expect(res.stage_id).toBe('st2');
    expect(dealsUpdateOne).not.toHaveBeenCalled();
    expect(outbox.withOutbox).not.toHaveBeenCalled();
  });

  it('performs a valid move and re-reads the deal on the new stage', async () => {
    // Reads in order: getDeal pre-move (st1) → raw debounce probe → stageLog eviction probe
    // (TODO-383) → getDeal post-move (st2, after the update).
    dealsFindOne
      .mockResolvedValueOnce(openDeal({ stageId: 'st1' })) // pre-move read
      .mockResolvedValueOnce(openDeal({ stageId: 'st1', stageLog: [] })) // debounce probe
      .mockResolvedValueOnce(openDeal({ stageId: 'st1' })) // eviction probe
      .mockResolvedValueOnce(openDeal({ stageId: 'st2' })); // post-move read
    pipelinesFindOne.mockResolvedValue(pipeline);
    dealsUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const res = await service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope, 'u-1');

    expect(res.stage_id).toBe('st2');
    // The update filter carries the open + from-stage invariants (TOCTOU guard).
    const filter = dealsUpdateOne.mock.calls[0][0];
    expect(filter).toMatchObject({ projectId: PROJECT, stageId: 'st1' });
    expect(filter.status).toEqual({ $nin: ['won', 'lost'] });
  });

  // REGRESSION PIN (a34d520 / T-036.4). Proven at runtime against the live stend:
  // the historical classic form — `$set('stageLog.$[open].exitedAt')` + `$push(stageLog)`
  // — is rejected by MongoDB with code 40 "Updating the path 'stageLog' would create a
  // conflict at 'stageLog'", so EVERY real stage move 500'd. Mongo is mocked here so a
  // unit run can't observe code 40; instead we pin the SHAPE of the update: it MUST be an
  // aggregation pipeline (Array) and MUST NOT mix a `stageLog.$[…]` positional `$set` with
  // a `$push(stageLog)` on overlapping paths. Reverting to the buggy form fails this test
  // without needing a database (the DB-backed proof lives in the integration spec).
  it('REGRESSION: writes stageLog via an aggregation pipeline, never a conflicting $set+$push', async () => {
    dealsFindOne
      .mockResolvedValueOnce(openDeal({ stageId: 'st1' }))
      .mockResolvedValueOnce(openDeal({ stageId: 'st1', stageLog: [] }))
      .mockResolvedValueOnce(openDeal({ stageId: 'st1' })) // eviction probe (TODO-383)
      .mockResolvedValueOnce(openDeal({ stageId: 'st2' }));
    pipelinesFindOne.mockResolvedValue(pipeline);
    dealsUpdateOne.mockResolvedValue({ matchedCount: 1 });

    await service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope, 'u-1');

    const update = dealsUpdateOne.mock.calls[0][1];
    const options = dealsUpdateOne.mock.calls[0][2] ?? {};
    // The conflict-free form is an aggregation pipeline (array of stages).
    expect(Array.isArray(update)).toBe(true);
    // It closes the open entry + appends the new one via $concatArrays (no positional
    // $set), now wrapped in a bounded `$slice` window (TODO-383).
    const stageSet = (
      update as Array<Record<string, { stageLog?: { $slice?: unknown[] }; stageId?: string }>>
    ).find((s) => s.$set);
    expect(stageSet?.$set?.stageLog).toHaveProperty('$slice');
    expect(stageSet?.$set?.stageLog?.$slice?.[0]).toHaveProperty('$concatArrays');
    expect(stageSet?.$set?.stageLog?.$slice?.[1]).toBeLessThan(0);
    expect(stageSet?.$set?.stageId).toBe('st2');
    // The buggy signature must be gone: no mixed $set-path/$push and no arrayFilters.
    const serialized = JSON.stringify(update);
    expect(serialized).not.toContain('stageLog.$[');
    expect(serialized).not.toContain('$push');
    expect(options).not.toHaveProperty('arrayFilters');
  });

  it('TODO-382 / FR-DEALS-170: bounce-back within debounceMs collapses the log but still emits stage_changed', async () => {
    const enteredAt = Date.now() - 1000;
    dealsFindOne
      .mockResolvedValueOnce(openDeal({ stageId: 'st2' }))
      .mockResolvedValueOnce(
        openDeal({
          stageId: 'st2',
          stageLog: [
            { stageId: 'st1', enteredAt: enteredAt - 5000, exitedAt: enteredAt },
            { stageId: 'st2', enteredAt },
          ],
        }),
      )
      .mockResolvedValueOnce(openDeal({ stageId: 'st1' }));
    pipelinesFindOne.mockResolvedValue({ ...pipeline, debounceMs: 5000 });
    dealsUpdateOne.mockResolvedValue({ matchedCount: 1 });

    let emittedIntents: unknown[] = [];
    outbox.withOutbox.mockImplementationOnce(
      async (work: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const out = await work(undefined);
        emittedIntents = out.intents;
        return out.result;
      },
    );

    const res = await service.moveDealToStage(PROJECT, DEAL_ID, 'st1', scope, 'u-1');
    expect(res.stage_id).toBe('st1');
    const update = dealsUpdateOne.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set.stageId).toBe('st1');
    expect(update.$set.stageLog).toHaveLength(1);
    // The event must NOT be debounced away: search/reports/automation project the
    // current stage from `toStageId` and would otherwise be stuck on the hop stage.
    expect(emittedIntents).toHaveLength(1);
    expect(emittedIntents[0]).toMatchObject({
      type: 'crm.deal.stage_changed',
      payload: { fromStageId: 'st2', toStageId: 'st1' },
    });
  });

  it('TOCTOU: matchedCount===0 (lost the race) throws FAILED_PRECONDITION and emits no event', async () => {
    dealsFindOne.mockResolvedValue(openDeal({ stageId: 'st1' }));
    pipelinesFindOne.mockResolvedValue(pipeline);
    dealsUpdateOne.mockResolvedValue({ matchedCount: 0 }); // concurrent close/move won

    let emittedIntents: unknown[] = [];
    outbox.withOutbox.mockImplementationOnce(
      async (work: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const out = await work(undefined);
        emittedIntents = out.intents;
        return out.result;
      },
    );

    await expect(
      service.moveDealToStage(PROJECT, DEAL_ID, 'st2', scope, 'u-1'),
    ).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Сделка была изменена другим процессом' },
    });
    // No phantom stage-change event on a lost race.
    expect(emittedIntents).toEqual([]);
  });
});
