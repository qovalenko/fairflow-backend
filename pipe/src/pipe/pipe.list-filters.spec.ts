import { PipeService } from './pipe.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { ProjectMembersService } from './project-members.service';

describe('PipeService listDeals — FR-SEARCH-390 filters', () => {
  let capturedFilter: Record<string, unknown> = {};
  let countFilters: Record<string, unknown>[] = [];

  function makeService() {
    capturedFilter = {};
    countFilters = [];
    const deals = {
      countDocuments: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        countFilters.push(f);
        return Promise.resolve(0);
      }),
      find: jest.fn((f: Record<string, unknown>) => {
        capturedFilter = f;
        return {
          sort: () => ({
            skip: () => ({
              limit: () => ({ toArray: () => Promise.resolve([]) }),
            }),
          }),
        };
      }),
    };
    const pipelines = {
      find: jest.fn(() => ({ toArray: () => Promise.resolve([]) })),
    };
    const mongo = {
      deals: () => deals,
      pipelines: () => pipelines,
    } as unknown as MongoService;
    return new PipeService(mongo, {} as MongoOutboxStore, {} as ProjectMembersService);
  }

  function flatAnd(f: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(f.$and) ? (f.$and as Record<string, unknown>[]) : [f];
  }

  it('withoutAssignee AND-ится поверх базового фильтра', async () => {
    const svc = makeService();
    await svc.listDeals('p1', 0, 25, undefined, undefined, undefined, undefined, {
      withoutAssignee: true,
    });
    const clauses = flatAnd(capturedFilter);
    expect(clauses).toContainEqual({
      $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }],
    });
  });

  it('minDaysOnStage сужает по stageEnteredAt', async () => {
    const svc = makeService();
    const before = Date.now();
    await svc.listDeals('p1', 0, 25, undefined, undefined, undefined, undefined, {
      minDaysOnStage: 7,
    });
    const clauses = flatAnd(capturedFilter);
    const stageClause = clauses.find(
      (c) => typeof c.stageEnteredAt === 'object' && c.stageEnteredAt !== null,
    ) as { stageEnteredAt: { $lt: number; $gt: number } } | undefined;
    expect(stageClause).toBeDefined();
    expect(stageClause!.stageEnteredAt.$gt).toBe(0);
    expect(stageClause!.stageEnteredAt.$lt).toBeLessThanOrEqual(before - 7 * 86_400_000 + 50);
  });

  it('user filters входят в projectTotal (hiddenByPolicy не раздувается)', async () => {
    const svc = makeService();
    await svc.listDeals('p1', 0, 25, undefined, undefined, undefined, undefined, {
      withoutAssignee: true,
    });
    expect(countFilters.length).toBeGreaterThanOrEqual(2);
    const unassigned = {
      $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }],
    };
    for (const f of countFilters) {
      expect(flatAnd(f)).toContainEqual(unassigned);
    }
  });
});
