import { status } from '@grpc/grpc-js';
import { PipeService } from './pipe.service';

/**
 * Component tests for the pipe configuration CRUD: pipelines/stages (FR-20/21/22),
 * deal sources (FR-23) and lost reasons (FR-24). Mongo is mocked (jest.fn per
 * collection method) so the service's guards run for real — single-default
 * invariant, delete guards (last pipeline / active deals), and dup detection —
 * without a broker or a database. Real-storage coverage of the same paths lives
 * in pipe.service.integration.spec.ts.
 */
describe('PipeService — pipelines / deal sources / lost reasons CRUD', () => {
  const PROJECT = 'p-crud';

  let pipelines: Record<string, jest.Mock>;
  let deals: Record<string, jest.Mock>;
  let dealSources: Record<string, jest.Mock>;
  let lostReasons: Record<string, jest.Mock>;

  // A session whose withTransaction just runs the work — the default-switch tx.
  const session = {
    withTransaction: async (fn: () => Promise<void>) => {
      await fn();
    },
    endSession: async () => undefined,
  };

  const mongo = {
    pipelines: () => pipelines,
    deals: () => deals,
    dealSources: () => dealSources,
    lostReasons: () => lostReasons,
    getClient: () => ({ startSession: () => session }),
  };
  const outbox = { withOutbox: jest.fn() };
  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  beforeEach(() => {
    pipelines = {
      findOne: jest.fn(),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      countDocuments: jest.fn(),
    };
    deals = { countDocuments: jest.fn().mockResolvedValue(0) };
    dealSources = {
      findOne: jest.fn(),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      deleteOne: jest.fn().mockResolvedValue({}),
    };
    lostReasons = {
      findOne: jest.fn(),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      deleteOne: jest.fn().mockResolvedValue({}),
    };
  });

  // ── pipelines ──────────────────────────────────────────────────────────
  describe('createPipeline', () => {
    it('rejects an empty name', async () => {
      await expect(service.createPipeline(PROJECT, { name: '  ' })).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT },
      });
      expect(pipelines.insertOne).not.toHaveBeenCalled();
    });

    it('creates a non-default pipeline without demoting others', async () => {
      pipelines.findOne.mockResolvedValue({
        projectId: PROJECT,
        id: 'x',
        name: 'Retention',
        isDefault: false,
        stages: [],
      });
      const res = await service.createPipeline(PROJECT, { name: 'Retention' });
      expect(res.name).toBe('Retention');
      expect(pipelines.insertOne).toHaveBeenCalledTimes(1);
      // No default in play → no demote sweep.
      expect(pipelines.updateMany).not.toHaveBeenCalled();
    });

    it('creating a default pipeline demotes the current default in one switch (single-default invariant)', async () => {
      pipelines.findOne.mockResolvedValue({
        projectId: PROJECT,
        id: 'x',
        name: 'Main',
        isDefault: true,
        stages: [],
      });
      await service.createPipeline(PROJECT, { name: 'Main', is_default: true });
      // Demote-current-default then insert-new both ran (inside the tx work).
      expect(pipelines.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT, isDefault: true }),
        { $set: { isDefault: false } },
        expect.anything(),
      );
      expect(pipelines.insertOne).toHaveBeenCalledTimes(1);
    });

    it('normalizes stages (kind defaults to active, order backfilled)', async () => {
      pipelines.findOne.mockResolvedValue({
        projectId: PROJECT,
        id: 'x',
        name: 'P',
        isDefault: false,
        stages: [{ id: 's1', name: 'One', color: '#fff', order: 0, kind: 'active' }],
      });
      await service.createPipeline(PROJECT, { name: 'P', stages: [{ name: 'One' }] });
      const inserted = pipelines.insertOne.mock.calls[0][0];
      expect(inserted.stages[0]).toMatchObject({ name: 'One', kind: 'active', order: 0 });
    });
  });

  describe('updatePipeline', () => {
    it('404s an unknown pipeline', async () => {
      pipelines.findOne.mockResolvedValue(null);
      await expect(service.updatePipeline(PROJECT, 'ghost', { name: 'x' })).rejects.toMatchObject({
        error: { code: status.NOT_FOUND },
      });
    });

    it('promoting to default demotes the previous default', async () => {
      pipelines.findOne.mockResolvedValue({
        projectId: PROJECT,
        id: 'pl-2',
        name: 'Second',
        isDefault: true,
        stages: [],
      });
      await service.updatePipeline(PROJECT, 'pl-2', { is_default: true });
      expect(pipelines.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT, isDefault: true }),
        { $set: { isDefault: false } },
        expect.anything(),
      );
    });
  });

  describe('deletePipeline', () => {
    it('refuses to delete the only pipeline of a project', async () => {
      pipelines.countDocuments.mockResolvedValue(1);
      await expect(service.deletePipeline(PROJECT, 'pl-1')).rejects.toMatchObject({
        error: { code: status.FAILED_PRECONDITION, message: 'Нельзя удалить единственную воронку' },
      });
      expect(pipelines.deleteOne).not.toHaveBeenCalled();
    });

    it('refuses to delete a pipeline that still has active deals and surfaces the count', async () => {
      pipelines.countDocuments.mockResolvedValue(3);
      deals.countDocuments.mockResolvedValue(7);
      await expect(service.deletePipeline(PROJECT, 'pl-1')).rejects.toMatchObject({
        error: { code: status.FAILED_PRECONDITION, details: { pipelineId: 'pl-1', count: 7 } },
      });
      expect(pipelines.deleteOne).not.toHaveBeenCalled();
    });

    it('deletes a spare, empty pipeline', async () => {
      pipelines.countDocuments.mockResolvedValue(2);
      deals.countDocuments.mockResolvedValue(0);
      const res = await service.deletePipeline(PROJECT, 'pl-1');
      expect(res).toEqual({ ok: true });
      expect(pipelines.deleteOne).toHaveBeenCalledWith({ projectId: PROJECT, id: 'pl-1' });
    });
  });

  // ── deal sources ─────────────────────────────────────────────────────────
  describe('deal sources', () => {
    it('rejects an empty name', async () => {
      await expect(service.createDealSource(PROJECT, ' ', '#fff')).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT },
      });
    });

    it('rejects a duplicate name in the same project (ALREADY_EXISTS)', async () => {
      dealSources.findOne.mockResolvedValue({ id: 'ds1', name: 'Сайт' });
      await expect(service.createDealSource(PROJECT, 'Сайт', '#fff')).rejects.toMatchObject({
        error: { code: status.ALREADY_EXISTS },
      });
      expect(dealSources.insertOne).not.toHaveBeenCalled();
    });

    it('creates a source scoped to the project', async () => {
      dealSources.findOne.mockResolvedValue(null);
      const res = await service.createDealSource(PROJECT, 'Реклама', '#123');
      expect(res).toMatchObject({ name: 'Реклама', color: '#123' });
      expect(dealSources.insertOne.mock.calls[0][0]).toMatchObject({ projectId: PROJECT });
    });

    it('404s updating an unknown source', async () => {
      dealSources.findOne.mockResolvedValue(null);
      await expect(service.updateDealSource(PROJECT, 'ghost', 'x')).rejects.toMatchObject({
        error: { code: status.NOT_FOUND },
      });
    });
  });

  // ── lost reasons ─────────────────────────────────────────────────────────
  describe('lost reasons', () => {
    it('rejects an empty name', async () => {
      await expect(service.createLostReason(PROJECT, '')).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT },
      });
    });

    it('rejects a duplicate reason (ALREADY_EXISTS)', async () => {
      lostReasons.findOne.mockResolvedValue({ id: 'lr1', name: 'Дорого' });
      await expect(service.createLostReason(PROJECT, 'Дорого')).rejects.toMatchObject({
        error: { code: status.ALREADY_EXISTS },
      });
    });

    it('creates a reason scoped to the project with defaults', async () => {
      lostReasons.findOne.mockResolvedValue(null);
      const res = await service.createLostReason(PROJECT, 'Конкурент');
      expect(res).toMatchObject({ name: 'Конкурент', order: 0, active: true });
      expect(lostReasons.insertOne.mock.calls[0][0]).toMatchObject({ projectId: PROJECT });
    });

    it('404s updating an unknown reason', async () => {
      lostReasons.findOne.mockResolvedValue(null);
      await expect(service.updateLostReason(PROJECT, 'ghost', 'x')).rejects.toMatchObject({
        error: { code: status.NOT_FOUND },
      });
    });
  });
});
