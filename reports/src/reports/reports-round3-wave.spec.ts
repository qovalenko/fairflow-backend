import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import { DEPARTMENT_BENCHMARK_MANAGER_ID, catalogForRun } from './reports-preset-catalog';
import type { VisibilityScope } from '@fairflow/shared';

type Rec = Record<string, unknown>;

const SCOPE_ONLY_OWN: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u-self',
  ownerIds: ['u-self'],
  sharedRecordIds: [],
} as VisibilityScope;

const SCOPE_MEMBER: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u-member',
  ownerIds: ['u-member'],
  sharedRecordIds: [],
} as VisibilityScope;

function baseSvc(dealsOverrides: Rec = {}) {
  const emptyAgg = () => ({ toArray: async () => [] });
  const mongo = {
    reports: () => ({
      countDocuments: async () => 0,
      find: () => ({
        sort: () => ({
          limit: () => ({
            skip: () => ({ project: () => ({ toArray: async () => [] }) }),
          }),
        }),
      }),
      findOne: async () => null,
      aggregate: () => emptyAgg(),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
      updateMany: async () => ({ modifiedCount: 0 }),
    }),
    deals: () => ({
      countDocuments: async () => 0,
      aggregate: () => emptyAgg(),
      findOne: async () => null,
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      ...dealsOverrides,
    }),
    orders: () => ({ countDocuments: async () => 0, aggregate: () => emptyAgg() }),
    contacts: () => ({ countDocuments: async () => 0, aggregate: () => emptyAgg() }),
    companies: () => ({ countDocuments: async () => 0, aggregate: () => emptyAgg() }),
    activities: () => ({ countDocuments: async () => 0, aggregate: () => emptyAgg() }),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    { getService: () => ({ listPipelines: () => of({ list: [] }) }) } as never,
    { getService: () => ({}) } as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return svc;
}

describe('ReportsService round3 wave', () => {
  it('FR-REPORTS-100: buildDepartmentBenchmarkRow — обезличенное среднее', async () => {
    const svc = baseSvc({
      findOne: async () => ({ departmentId: 'd1' }),
      aggregate: () => ({
        toArray: async () => [
          {
            _id: null,
            count: 9,
            amount: 900,
            won: 3,
            lost: 1,
            managers: ['u-self', 'u2', 'u3'],
          },
        ],
      }),
    });
    const row = await (
      svc as unknown as {
        buildDepartmentBenchmarkRow(
          p: string,
          params: Rec,
          access: undefined,
          selfId: string,
        ): Promise<Rec | null>;
      }
    ).buildDepartmentBenchmarkRow('p1', {}, undefined, 'u-self');
    expect(row?.manager_id).toBe(DEPARTMENT_BENCHMARK_MANAGER_ID);
    expect(row?.row_kind).toBe('department_benchmark');
    expect(row?.count).toBe(3);
    expect(row?.amount).toBe(300);
  });

  it('FR-REPORTS-160/270: run() включает viz и metric_formulas в data_json', async () => {
    const doc = {
      _id: new ObjectId(),
      projectId: 'p1',
      name: 'Продажи',
      presetKey: 'sales',
      kind: 'builtin',
      deletedAt: null,
    };
    const mongo = {
      reports: () => ({
        countDocuments: async () => 1,
        find: () => ({
          sort: () => ({
            limit: () => ({
              skip: () => ({ project: () => ({ toArray: async () => [doc] }) }),
            }),
          }),
        }),
        findOne: async () => doc,
        aggregate: () => ({ toArray: async () => [] }),
        bulkWrite: async () => ({}),
        createIndex: async () => 'ix',
      }),
      deals: () => ({
        countDocuments: async () => 0,
        aggregate: () => ({ toArray: async () => [] }),
        findOne: async () => null,
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      }),
      orders: () => ({ countDocuments: async () => 0, aggregate: () => ({ toArray: async () => [] }) }),
      contacts: () => ({ countDocuments: async () => 0, aggregate: () => ({ toArray: async () => [] }) }),
      companies: () => ({ countDocuments: async () => 0, aggregate: () => ({ toArray: async () => [] }) }),
      activities: () => ({ countDocuments: async () => 0, aggregate: () => ({ toArray: async () => [] }) }),
    };
    const svc = new ReportsService(
      mongo as never,
      { enqueue: async () => undefined } as never,
      { getService: () => ({ listPipelines: () => of({ list: [] }) }) } as never,
      { getService: () => ({}) } as never,
      { read: async () => [] } as never,
      { get: async () => null, isTrusted: () => false } as never,
      { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
    );
    svc.onModuleInit();
    const res = await svc.run('p1', String(doc._id), undefined, SCOPE_MEMBER, 'u-member');
    const data = JSON.parse(res.data_json) as Rec;
    expect(data.viz).toEqual(catalogForRun('sales', null).viz);
    expect((data.metric_formulas as Rec).avg_check).toContain('Сумма сделок');
  });

  it('FR-REPORTS-290: drill countDocuments использует тот же baseMatch', async () => {
    const counts: Rec[] = [];
    const svc = baseSvc({
      countDocuments: async (m: Rec) => {
        counts.push(m);
        return 7;
      },
      find: () => ({
        sort: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    });
    const doc = {
      _id: new ObjectId(),
      projectId: 'p1',
      presetKey: 'funnel',
      kind: 'builtin',
      deletedAt: null,
    };
    (svc as unknown as { mongo: { reports: () => Rec } }).mongo.reports = () =>
      ({
        findOne: async () => doc,
      }) as Rec;
    const out = await (
      svc as unknown as {
        drill(
          p: string,
          id: string,
          params: undefined,
          dim: string,
          val: string,
          limit: number,
          cursor: undefined,
          scope: VisibilityScope,
        ): Promise<{ total: number }>;
      }
    ).drill('p1', String(doc._id), undefined, 'stage_id', 'st1', 10, undefined, SCOPE_MEMBER);
    expect(out.total).toBe(7);
    expect(JSON.stringify(counts[0])).toContain('st1');
  });

  it('FR-REPORTS-290: drill по всем измерениям включает dimensionFragment в match', async () => {
    const dimensions: Array<[string, string, string]> = [
      ['funnel', 'stage_id', 'st1'],
      ['sources', 'source', 'web'],
      ['by_managers', 'manager_id', 'u1'],
      ['depts', 'department_id', 'd1'],
      ['clients', 'company_id', 'c1'],
      ['activity', 'type', 'call'],
      ['activity', 'manager_id', 'u1'],
    ];
    for (const [presetKey, dim, val] of dimensions) {
      const counts: Rec[] = [];
      const findMock = () => ({
        sort: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      });
      const svc = baseSvc({
        countDocuments: async (m: Rec) => {
          counts.push(m);
          return 3;
        },
        find: findMock,
      });
      if (presetKey === 'activity') {
        (svc as unknown as { mongo: { activities: () => Rec } }).mongo.activities = () =>
          ({
            countDocuments: async (m: Rec) => {
              counts.push(m);
              return 3;
            },
            find: findMock,
          }) as Rec;
      }
      const doc = {
        _id: new ObjectId(),
        projectId: 'p1',
        presetKey,
        kind: 'builtin',
        deletedAt: null,
      };
      (svc as unknown as { mongo: { reports: () => Rec } }).mongo.reports = () =>
        ({
          findOne: async () => doc,
        }) as Rec;
      const drillDim = presetKey === 'activity' && dim === 'manager_id' ? 'manager_id' : dim;
      await (
        svc as unknown as {
          drill(
            p: string,
            id: string,
            params: undefined,
            dim: string,
            val: string,
            limit: number,
            cursor: undefined,
            scope: VisibilityScope,
          ): Promise<{ total: number }>;
        }
      ).drill('p1', String(doc._id), undefined, drillDim, val, 10, undefined, SCOPE_MEMBER);
      expect(JSON.stringify(counts[0])).toContain(val);
    }
  });

  it('FR-REPORTS-360: customSlice применяет spec.filters', async () => {
    const captured: Rec[] = [];
    const svc = baseSvc({
      aggregate: (pipe: unknown[]) => {
        captured.push((pipe[0] as Rec).$match as Rec);
        return { toArray: async () => [{ _id: 's1', value: 2 }] };
      },
    });
    const slice = await (
      svc as unknown as {
        customSlice(p: string, spec: Rec, scope: VisibilityScope, params: Rec): Promise<Rec>;
      }
    ).customSlice(
      'p1',
      {
        entity: 'deals',
        groupBy: [{ field: 'stage' }],
        measures: [{ fn: 'count' }],
        filters: [{ field: 'stage', operator: 'eq', value: 's1' }],
      },
      SCOPE_MEMBER,
      {},
    );
    expect(slice.custom_table).toBeDefined();
    expect(JSON.stringify(captured[0])).toContain('s1');
  });

  it('TODO-473: orderTypesSlice отдаёт order_types', async () => {
    const svc = baseSvc();
    (svc as unknown as { mongo: { orders: () => Rec } }).mongo.orders = () =>
      ({
        aggregate: () => ({ toArray: async () => [{ _id: 'ot1', count: 4 }] }),
      }) as Rec;
    const slice = await (
      svc as unknown as {
        orderTypesSlice(p: string, scope: VisibilityScope, params: Rec): Promise<Rec>;
      }
    ).orderTypesSlice('p1', SCOPE_MEMBER, {});
    expect(slice.order_types).toEqual([{ order_type_id: 'ot1', orders_count: 4 }]);
  });

  it('FR-REPORTS-100: drill по бенчмарку отдела отклоняется', async () => {
    const svc = baseSvc();
    const doc = {
      _id: new ObjectId(),
      projectId: 'p1',
      presetKey: 'by_managers',
      kind: 'builtin',
      deletedAt: null,
    };
    (svc as unknown as { mongo: { reports: () => Rec } }).mongo.reports = () =>
      ({
        findOne: async () => doc,
      }) as Rec;
    await expect(
      (
        svc as unknown as {
          drill(
            p: string,
            id: string,
            params: undefined,
            dim: string,
            val: string,
            limit: number,
            cursor: undefined,
            scope: VisibilityScope,
          ): Promise<{ total: number }>;
        }
      ).drill(
        'p1',
        String(doc._id),
        undefined,
        'manager_id',
        DEPARTMENT_BENCHMARK_MANAGER_ID,
        10,
        undefined,
        SCOPE_MEMBER,
      ),
    ).rejects.toBeTruthy();
  });

  it('FR-REPORTS-360: $where в spec.filters не попадает в $match', async () => {
    const captured: Rec[] = [];
    const svc = baseSvc({
      aggregate: (pipe: unknown[]) => {
        captured.push((pipe[0] as Rec).$match as Rec);
        return { toArray: async () => [{ _id: 's1', value: 2 }] };
      },
    });
    await (
      svc as unknown as {
        customSlice(p: string, spec: Rec, scope: VisibilityScope, params: Rec): Promise<Rec>;
      }
    ).customSlice(
      'p1',
      {
        entity: 'deals',
        groupBy: [{ field: 'stage' }],
        measures: [{ fn: 'count' }],
        filters: [{ field: '$where', operator: 'eq', value: '1 == 1' }],
      },
      SCOPE_MEMBER,
      {},
    );
    expect(JSON.stringify(captured[0])).not.toContain('$where');
  });

  it('BR-REPORTS-060: reassignOrphanedSharedReports', async () => {
    let filter: Rec | undefined;
    const svc = baseSvc();
    (svc as unknown as { mongo: { reports: () => Rec } }).mongo.reports = () =>
      ({
        updateMany: async (f: Rec) => {
          filter = f;
          return { modifiedCount: 2 };
        },
      }) as Rec;
    const r = await svc.reassignOrphanedSharedReports('p1', 'leaver', 'admin');
    expect(r.reassigned).toBe(2);
    expect(filter?.createdBy).toBe('leaver');
    expect(filter?.presetKey).toBeNull();
  });
});
