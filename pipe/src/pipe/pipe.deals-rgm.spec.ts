import { ObjectId } from 'mongodb';
import { status } from '@grpc/grpc-js';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import { PipeService } from './pipe.service';

/**
 * REAL-GAP-M deals wave — capabilities triaged in 10-deals.md.
 */
describe('PipeService — REAL-GAP-M deals', () => {
  const PROJECT = 'p-rgm';
  const DEAL_A = new ObjectId().toString();
  const DEAL_B = new ObjectId().toString();

  let deals: Record<string, jest.Mock>;
  let bulkJobs: Record<string, jest.Mock>;
  let pipelines: Record<string, jest.Mock>;
  let emitted: EmitIntent[];

  const mongo = {
    deals: () => deals,
    bulkJobs: () => bulkJobs,
    pipelines: () => pipelines,
    dealStageHistory: () => ({ insertMany: jest.fn() }),
    dealSources: () => ({ findOne: jest.fn() }),
    lostReasons: () => ({ findOne: jest.fn() }),
    getClient: () => ({
      startSession: () => ({
        withTransaction: async (fn: () => Promise<void>) => fn(),
        endSession: async () => undefined,
      }),
    }),
  };

  const outbox = {
    withOutbox: jest.fn(async (work: () => Promise<{ result: unknown; intents: EmitIntent[] }>) => {
      const out = await work();
      emitted.push(...out.intents);
      return out.result;
    }),
  };

  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  const ownScope = {
    mode: 'restricted' as const,
    level: 'only_own' as const,
    selfId: 'u-viewer',
    ownerIds: ['u-viewer'],
    sharedRecordIds: [],
    viewerUnitIds: ['dept-1'],
  } as VisibilityScope;

  const dealDoc = (id: string, over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(id),
    projectId: PROJECT,
    pipelineId: 'pl-1',
    stageId: 'st-1',
    name: 'Сделка',
    status: 'open',
    assigneeId: 'u-other',
    departmentId: 'dept-1',
    driftFlag: true,
    driftFields: ['phone'],
    driftDetail: { phone: { snapshotValue: '+7000', currentValue: '+7999' } },
    contactSnapshot: { phone: '+7000' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  beforeEach(() => {
    emitted = [];
    outbox.withOutbox.mockClear();
    pipelines = {
      findOne: jest.fn().mockResolvedValue({
        id: 'pl-1',
        stages: [{ id: 'st-1', name: 'Новые' }],
      }),
      countDocuments: jest.fn().mockResolvedValue(1),
    };
    deals = {
      findOne: jest.fn(),
      find: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      countDocuments: jest.fn(),
    };
    bulkJobs = {
      insertOne: jest.fn().mockResolvedValue({}),
    };
    pipelines.insertOne = jest.fn().mockResolvedValue({});
  });

  describe('FR-DEALS-315 — department visibility', () => {
    it('getDeal allows viewer in the same department without assignee match', async () => {
      deals.findOne.mockResolvedValue(dealDoc(DEAL_A, { assigneeId: 'u-stranger' }));
      const result = await service.getDeal(PROJECT, DEAL_A, ownScope);
      expect(result.id).toBe(DEAL_A);
    });

    it('getDeal hides deal when department is outside viewer units', async () => {
      deals.findOne.mockResolvedValue(
        dealDoc(DEAL_A, { assigneeId: 'u-stranger', departmentId: 'dept-2' }),
      );
      await expect(service.getDeal(PROJECT, DEAL_A, ownScope)).rejects.toMatchObject({
        error: { code: status.NOT_FOUND },
      });
    });
  });

  describe('FR-DEALS-290 — bulkAcceptDrift', () => {
    it('accepts drift on visible deals and skips invisible ones', async () => {
      const drifted = dealDoc(DEAL_A, { assigneeId: 'u-viewer', driftFlag: true });
      deals.findOne.mockImplementation(async (query: { _id?: ObjectId }) => {
        const id = String(query._id);
        if (id === DEAL_A) return drifted;
        return null;
      });
      deals.updateOne.mockResolvedValue({});

      const result = await service.bulkAcceptDrift(
        PROJECT,
        [DEAL_A, DEAL_B],
        undefined,
        { ...ownScope, ownerIds: ['u-viewer'], viewerUnitIds: [] } as VisibilityScope,
        'u-viewer',
      );
      expect(result.accepted).toEqual([DEAL_A]);
      expect(result.skipped).toEqual([{ id: DEAL_B, reason: 'not_visible' }]);
    });
  });

  describe('FR-DEALS-220 — pipeline auto-transition DFS', () => {
    it('rejects cyclic auto-transitions on createPipeline', async () => {
      pipelines.insertOne = jest.fn().mockResolvedValue({});
      pipelines.findOne = jest.fn();
      await expect(
        service.createPipeline(PROJECT, {
          name: 'Воронка',
          stages: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          auto_transitions: [
            { from_stage_id: 'a', to_stage_id: 'b' },
            { from_stage_id: 'b', to_stage_id: 'a' },
          ],
        }),
      ).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT, message: expect.stringContaining('Цикл') },
      });
      expect(pipelines.insertOne).not.toHaveBeenCalled();
    });
  });

  describe('NFR-DEALS-060 — async bulk threshold', () => {
    it('enqueues async job when dealIds exceed 200', async () => {
      const ids = Array.from({ length: 201 }, () => new ObjectId().toString());
      const res = await service.bulkUpdateDeals(
        PROJECT,
        ids,
        { stageId: 'st-2' },
        ownScope,
        'u-viewer',
      );
      expect(res.async).toBe(true);
      expect(res.job_id).toBeTruthy();
      expect(bulkJobs.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT,
          dealIds: ids,
          status: 'pending',
        }),
      );
      expect(deals.find).not.toHaveBeenCalled();
    });

    it('runs synchronously for 200 or fewer ids', async () => {
      deals.find.mockReturnValue({
        toArray: async () => [],
      });
      const ids = Array.from({ length: 2 }, () => new ObjectId().toString());
      const res = await service.bulkUpdateDeals(
        PROJECT,
        ids,
        { stageId: 'st-2' },
        ownScope,
        'u-viewer',
      );
      expect(res.async).toBe(false);
      expect(bulkJobs.insertOne).not.toHaveBeenCalled();
    });
  });
});
