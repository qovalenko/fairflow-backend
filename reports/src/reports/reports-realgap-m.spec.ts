import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

type Rec = Record<string, unknown>;

function fakeCollection(opts: {
  countValue?: number;
  aggregateRows?: Rec[];
  findRows?: Rec[];
  onFind?: (filter: Rec) => void;
}) {
  return {
    countDocuments: async () => opts.countValue ?? 0,
    aggregate: () => ({ toArray: async () => opts.aggregateRows ?? [] }),
    find: (filter: Rec = {}) => {
      opts.onFind?.(filter);
      return {
        sort: () => ({
          limit: () => ({ toArray: async () => opts.findRows ?? [] }),
        }),
      };
    },
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
}

function harness(presetKey: string, mongoOverrides: Partial<Record<string, ReturnType<typeof fakeCollection>>>) {
  const reportDoc = {
    _id: new ObjectId(),
    projectId: 'p1',
    name: 'Test',
    description: '',
    kind: 'builtin',
    presetKey,
    visibility: 'project',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  const mongo = {
    reports: () => ({
      findOne: async () => reportDoc,
      find: () => ({ project: () => ({ toArray: async () => [] }) }),
      updateOne: async () => ({}),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
    }),
    deals: () => mongoOverrides.deals ?? fakeCollection({ countValue: 0 }),
    orders: () => mongoOverrides.orders ?? fakeCollection({ countValue: 0 }),
    contacts: () => mongoOverrides.contacts ?? fakeCollection({ countValue: 0 }),
    companies: () => mongoOverrides.companies ?? fakeCollection({ countValue: 0 }),
    activities: () => mongoOverrides.activities ?? fakeCollection({ countValue: 0 }),
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
  return { svc, reportDoc };
}

const scopeOnlyOwn: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u1',
  ownerIds: ['u1'],
  sharedRecordIds: [],
} as VisibilityScope;

describe('FR-REPORTS-190: requires_modules в модели Report', () => {
  it('toReport отдаёт requires_modules для встроенного пресета', async () => {
    const { svc } = harness('activity', {});
    const doc = {
      _id: new ObjectId(),
      projectId: 'p1',
      name: 'По активности',
      description: '',
      kind: 'builtin',
      presetKey: 'activity',
      visibility: 'project',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const mapped = (svc as unknown as { toReport(d: unknown): Rec }).toReport(doc);
    expect(mapped.requires_modules).toEqual(['activities']);
  });
});

describe('FR-REPORTS-190: assertPresetModules в run()', () => {
  it('отклоняет пресет при выключенном модуле-источнике', async () => {
    const { svc, reportDoc } = harness('activity', {});
    await expect(
      svc.run(
        'p1',
        reportDoc._id.toString(),
        '{}',
        scopeOnlyOwn,
        'u1',
        false,
        undefined,
        undefined,
        ['deals'],
      ),
    ).rejects.toBeInstanceOf(RpcException);
    try {
      await svc.run(
        'p1',
        reportDoc._id.toString(),
        '{}',
        scopeOnlyOwn,
        'u1',
        false,
        undefined,
        undefined,
        ['deals'],
      );
    } catch (e) {
      expect((e as RpcException).getError()).toMatchObject({
        code: status.FAILED_PRECONDITION,
      });
    }
  });
});

describe('FR-REPORTS-110: пресет my_overdue', () => {
  it('возвращает персональные просрочки и неактивные сделки', async () => {
    const overdueAct = {
      _id: new ObjectId(),
      title: 'Позвонить',
      type: 'call',
      dueDate: Date.now() - 86_400_000,
      assigneeId: 'u1',
      status: 'open',
    };
    const { svc, reportDoc } = harness('my_overdue', {
      activities: fakeCollection({
        findRows: [overdueAct],
        aggregateRows: [],
      }),
      deals: fakeCollection({
        findRows: [
          {
            _id: new ObjectId(),
            name: 'Сделка без активности',
            amount: 1000,
            stageId: 's1',
            status: 'open',
            updatedAt: Date.now() - 10 * 86_400_000,
            assigneeId: 'u1',
          },
        ],
      }),
    });
    const res = await svc.run(
      'p1',
      reportDoc._id.toString(),
      JSON.stringify({ stalledDays: 7 }),
      scopeOnlyOwn,
      'u1',
      false,
      undefined,
      undefined,
      ['activities', 'deals'],
    );
    const data = JSON.parse(res.data_json) as Rec;
    expect(data.my_overdue_totals).toMatchObject({
      overdue_activities: 1,
      stalled_days: 7,
    });
    expect(Array.isArray(data.my_overdue_activities)).toBe(true);
    expect((data.my_overdue_activities as Rec[])[0]).toMatchObject({
      title: 'Позвонить',
    });
    expect(Array.isArray(data.my_inactive_deals)).toBe(true);
  });

  it('TODO-467: overdue activities match uses indexable $or, not $expr', async () => {
    const activityFilters: Rec[] = [];
    const overdueAct = {
      _id: new ObjectId(),
      title: 'Позвонить',
      type: 'call',
      dueDate: Date.now() - 86_400_000,
      assigneeId: 'u1',
      status: 'open',
    };
    const { svc, reportDoc } = harness('my_overdue', {
      activities: fakeCollection({
        findRows: [overdueAct],
        aggregateRows: [],
        onFind: (f) => activityFilters.push(f),
      }),
      deals: fakeCollection({ findRows: [], aggregateRows: [] }),
    });
    await svc.run(
      'p1',
      reportDoc._id.toString(),
      JSON.stringify({ stalledDays: 7 }),
      scopeOnlyOwn,
      'u1',
      false,
      undefined,
      undefined,
      ['activities', 'deals'],
    );
    expect(activityFilters.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(activityFilters);
    expect(serialized).not.toContain('$expr');
    expect(serialized).toContain('dueDate');
  });
});

describe('NFR-020: пагинация агрегата прогона', () => {
  it('возвращает aggregate_pagination с total_groups', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      _id: `2026-01-${String(i + 1).padStart(2, '0')}`,
      count: 1,
      amount: 100,
    }));
    const { svc, reportDoc } = harness('sales', {
      deals: fakeCollection({ aggregateRows: rows }),
    });
    const res = await svc.run(
      'p1',
      reportDoc._id.toString(),
      JSON.stringify({ pageIndex: 1, pageSize: 10 }),
      scopeOnlyOwn,
      'u1',
      false,
    );
    const data = JSON.parse(res.data_json) as Rec;
    const pagination = data.aggregate_pagination as Rec;
    expect(pagination).toMatchObject({
      page_index: 1,
      page_size: 10,
      total_groups: 30,
    });
    expect((data.sales_dynamics as Rec[]).length).toBe(10);
  });
});

describe('NFR-050: кэш агрегатов с scopeHash', () => {
  it('второй прогон с тем же scope/filters не пересчитывает агрегат', async () => {
    let aggregateCalls = 0;
    const deals = {
      countDocuments: async () => 0,
      aggregate: () => {
        aggregateCalls += 1;
        return { toArray: async () => [{ _id: 'd1', count: 1, amount: 1 }] };
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
    const { svc, reportDoc } = harness('sales', { deals: deals as never });
    const id = reportDoc._id.toString();
    await svc.run('p1', id, '{}', scopeOnlyOwn, 'u1', false);
    const first = aggregateCalls;
    await svc.run('p1', id, '{}', scopeOnlyOwn, 'u1', false);
    expect(aggregateCalls).toBe(first);
  });

  it('разный scopeHash не переиспользует чужой агрегат', async () => {
    let aggregateCalls = 0;
    const deals = {
      countDocuments: async () => 0,
      aggregate: () => {
        aggregateCalls += 1;
        return { toArray: async () => [{ _id: 'd1', count: 1, amount: 1 }] };
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
    const { svc, reportDoc } = harness('sales', { deals: deals as never });
    const id = reportDoc._id.toString();
    const other: VisibilityScope = {
      ...scopeOnlyOwn,
      selfId: 'u2',
      ownerIds: ['u2'],
    };
    await svc.run('p1', id, '{}', scopeOnlyOwn, 'u1', false);
    const first = aggregateCalls;
    await svc.run('p1', id, '{}', other, 'u2', false);
    expect(aggregateCalls).toBeGreaterThan(first);
  });
});

describe('FR-REPORTS-380: entity_mini в прогоне', () => {
  it('возвращает мини-срез для deal', async () => {
    const dealId = new ObjectId();
    const deals = {
      countDocuments: async () => 0,
      aggregate: () => ({ toArray: async () => [] }),
      find: () => ({
        sort: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
      findOne: async () => ({
        _id: dealId,
        name: 'Крупная',
        amount: 5000,
        stageId: 's1',
        status: 'open',
      }),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
    };
    const { svc, reportDoc } = harness('sales', {
      deals: deals as never,
      activities: fakeCollection({ countValue: 2 }),
    });
    const res = await svc.run(
      'p1',
      reportDoc._id.toString(),
      JSON.stringify({ entityType: 'deal', entityId: dealId.toString() }),
      scopeOnlyOwn,
      'u1',
      false,
    );
    const data = JSON.parse(res.data_json) as Rec;
    expect(data.entity_mini).toMatchObject({
      entity_type: 'deal',
      found: true,
      name: 'Крупная',
      amount: 5000,
    });
  });
});
