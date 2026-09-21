import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

type Rec = Record<string, unknown>;

function fakeCollection(opts: {
  countValue?: number;
  aggregateRows?: Rec[];
}) {
  return {
    countDocuments: async () => opts.countValue ?? 0,
    aggregate: () => ({ toArray: async () => opts.aggregateRows ?? [] }),
    find: () => ({
      sort: () => ({
        limit: () => ({ toArray: async () => [] }),
      }),
    }),
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
}

function harness(reportDoc: Rec) {
  const dealsAgg: unknown[][] = [];
  const deals = {
    countDocuments: async () => 5,
    aggregate: (pipeline: unknown[]) => {
      dealsAgg.push(pipeline);
      return { toArray: async () => [{ n: 2 }] };
    },
    find: () => ({
      sort: () => ({
        limit: () => ({ toArray: async () => [] }),
      }),
    }),
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
  const mongo = {
    reports: () => ({
      findOne: async () => reportDoc,
      find: () => ({ project: () => ({ toArray: async () => [] }) }),
      updateOne: async () => ({}),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
    }),
    deals: () => deals,
    orders: () => fakeCollection({ countValue: 0 }),
    contacts: () => fakeCollection({ countValue: 0 }),
    companies: () => fakeCollection({ countValue: 0 }),
    activities: () => fakeCollection({ countValue: 0 }),
    ensureIndexes: async () => undefined,
  };
  const outbox = { enqueue: async () => undefined };
  const pipeClient = {
    getService: () => ({
      listPipelines: () => of({ list: [] }),
    }),
  };
  const svc = new ReportsService(
    mongo as never,
    outbox as never,
    pipeClient as never,
    { getService: () => ({}) } as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return { svc, dealsAgg };
}

const scopeAll: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

describe('ReportsService round2', () => {
  it('run применяет stalledDays из params в funnel пресете', async () => {
    const id = new ObjectId();
    const { svc } = harness({
      _id: id,
      projectId: 'p1',
      kind: 'builtin',
      presetKey: 'funnel',
      name: 'F',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    const run = await svc.run(
      'p1',
      id.toString(),
      JSON.stringify({ stalledDays: 14 }),
      scopeAll,
      'u1',
      false,
      undefined,
      undefined,
      ['deals'],
    );
    const data = JSON.parse(run.data_json) as Rec;
    expect(data.stalled_days).toBe(14);
  });

  it('run отклоняет пресет при выключенном модуле-источнике (FR-REPORTS-190)', async () => {
    const { svc } = harness({
      _id: new ObjectId(),
      projectId: 'p1',
      kind: 'builtin',
      presetKey: 'activity',
      name: 'A',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      svc.run('p1', String(new ObjectId()), '{}', scopeAll, 'u1', true, undefined, undefined, [
        'deals',
      ]),
    ).rejects.toThrow(/requires module/);
  });

  it('run кладёт coverage и totals_previous в data_json при периоде', async () => {
    const id = new ObjectId();
    const { svc } = harness({
      _id: id,
      projectId: 'p1',
      kind: 'builtin',
      presetKey: 'sales',
      name: 'S',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    const run = await svc.run(
      'p1',
      id.toString(),
      JSON.stringify({ period: 'month' }),
      scopeAll,
      'u1',
      false,
      undefined,
      undefined,
      ['deals', 'orders', 'contacts', 'companies', 'activities'],
    );
    const data = JSON.parse(run.data_json) as Rec;
    expect(data.coverage).toBeDefined();
    expect(data.totals_previous).toBeDefined();
    expect(data.stalled_days).toBeGreaterThan(0);
  });

  it('toReport отдаёт spec_json для edit UI', async () => {
    const id = new ObjectId();
    const { svc } = harness({
      _id: id,
      projectId: 'p1',
      kind: 'custom',
      presetKey: null,
      name: 'C',
      description: '',
      spec: { entity: 'deals' },
      createdAt: 1,
      updatedAt: 1,
    });
    const report = await svc.get('p1', id.toString());
    expect(report.spec_json).toContain('deals');
  });
});
