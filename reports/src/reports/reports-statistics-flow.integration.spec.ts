import type { Db, MongoClient } from 'mongodb';
import { of } from 'rxjs';
import type { VisibilityScope } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { ReportsService } from './reports.service';
import { StatisticsRollupStore } from '../rollup/statistics-rollup.store';
import { StatisticsRollupCoverageStore } from '../rollup/statistics-rollup-coverage';
import { StatisticsRollupConsumer } from '../rollup/statistics-rollup.consumer';
import { StageTransitionsStore } from '../stage-transitions/stage-transitions.store';
import { StageTransitionsConsumer } from '../stage-transitions/stage-transitions.consumer';
import type { DashboardAggregate } from './statistics-aggregate-cache';

/**
 * Reports ↔ statistics rollup integration (wave reports-statistics-flow).
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set.
 * Exercises the REAL chain inside the reports workspace — no mocked store at
 * the boundary between bus-fact consumers and dashboard/metrics read-switch:
 *
 *   CRM envelope → StatisticsRollupConsumer / StageTransitionsConsumer
 *               → Mongo materialization (statistics_rollup / stage_transitions)
 *               → StatisticsRollupCoverageStore backfill marker
 *               → ReportsService.getDashboard / getMetrics (rollup read-path)
 *
 * gRPC to pipe/contact is stubbed (those domains are out of scope here); Mongo,
 * idempotent increment guards, coverage gate and KPI/slice assembly are real.
 */

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u-admin',
  ownerIds: [],
  sharedRecordIds: [],
};

const RESTRICTED_SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u1',
  ownerIds: ['u1'],
  sharedRecordIds: [],
};

const DAY = '2026-07-04';
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
const DAY_END = Date.parse('2026-07-05T00:00:00.000Z');
const NOON = Date.parse(`${DAY}T12:00:00.000Z`);

type MongoShape = {
  statisticsRollup: () => ReturnType<Db['collection']>;
  statisticsRollupMsgs: () => ReturnType<Db['collection']>;
  statisticsRollupState: () => ReturnType<Db['collection']>;
  stageTransitions: () => ReturnType<Db['collection']>;
  deals: () => ReturnType<Db['collection']>;
  orders: () => ReturnType<Db['collection']>;
  contacts: () => ReturnType<Db['collection']>;
  companies: () => ReturnType<Db['collection']>;
  activities: () => ReturnType<Db['collection']>;
  reports: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
};

function mongoAdapter(client: MongoClient, db: Db): MongoShape {
  return {
    statisticsRollup: () => db.collection('statistics_rollup'),
    statisticsRollupMsgs: () => db.collection('statistics_rollup_msgs'),
    statisticsRollupState: () => db.collection('statistics_rollup_state'),
    stageTransitions: () => db.collection('stage_transitions'),
    deals: () => db.collection('crm_deals'),
    orders: () => db.collection('crm_orders'),
    contacts: () => db.collection('contacts'),
    companies: () => db.collection('companies'),
    activities: () => db.collection('crm_activities'),
    reports: () => db.collection('reports_definitions'),
    outbox: () => db.collection('_outbox'),
    getClient: () => client,
  };
}

function dealCreatedEnvelope(
  projectId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'crm.deal.created',
    messageId: id('msg'),
    timestamp: `${DAY}T12:00:00.000Z`,
    projectId,
    payload: { dealId: id('deal'), amount: 1000 },
    ...over,
  };
}

function kpiValue(dashboard: DashboardAggregate, key: string): number {
  const cell = dashboard.kpi.find((k) => k.key === key);
  return cell?.value ?? -1;
}

jest.setTimeout(30_000);

describeMongoIntegration('reports statistics rollup flow (real Mongo)', () => {
  let close: () => Promise<void>;
  let mongo: MongoShape;
  let rollupStore: StatisticsRollupStore;
  let rollupCoverage: StatisticsRollupCoverageStore;
  let rollupConsumer: StatisticsRollupConsumer;
  let stageStore: StageTransitionsStore;
  let stageConsumer: StageTransitionsConsumer;
  let reports: ReportsService;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('reports-stats');
    close = eph.close;
    mongo = mongoAdapter(eph.client, eph.db);

    rollupStore = new StatisticsRollupStore(mongo as never);
    rollupCoverage = new StatisticsRollupCoverageStore(mongo as never);
    stageStore = new StageTransitionsStore(mongo as never);
    await rollupStore.onModuleInit();
    await rollupCoverage.onModuleInit();
    await stageStore.onModuleInit();

    rollupConsumer = new StatisticsRollupConsumer({ consume: jest.fn() } as never, rollupStore);
    stageConsumer = new StageTransitionsConsumer({ consume: jest.fn() } as never, stageStore);

    const pipeClient = {
      getService: () => ({
        listPipelines: () => of({ list: [{ id: 'pl1', is_default: true, stages: [] }] }),
      }),
    };
    const contactClient = {
      getService: () => ({
        getContactQualityMetrics: () =>
          of({
            total_contacts: 0,
            filled_both_pct: 0,
            duplicate_candidate_pairs: 0,
            open_drift_links: 0,
          }),
      }),
    };

    reports = new ReportsService(
      mongo as never,
      { enqueue: async () => undefined } as never,
      pipeClient as never,
      contactClient as never,
      rollupStore,
      rollupCoverage,
      stageStore,
    );
    reports.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function markTrusted(projectId: string, fromDay = '2026-01-01'): Promise<void> {
    await rollupCoverage.markBackfilled(projectId, fromDay);
  }

  async function feedDealFacts(
    projectId: string,
    facts: Array<{ routingKey: string; envelope: Record<string, unknown> }>,
  ): Promise<void> {
    for (const f of facts) {
      await rollupConsumer.handle(f.envelope, f.routingKey);
    }
  }

  // ── consumer → store materialization ─────────────────────────────────────
  it('materializes CRM deal facts into statistics_rollup cells', async () => {
    const projectId = id('proj');
    await feedDealFacts(projectId, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 'm-create', payload: { amount: 5000 } }),
      },
      {
        routingKey: 'crm.deal.won',
        envelope: dealCreatedEnvelope(projectId, {
          messageId: 'm-won',
          type: 'crm.deal.won',
          payload: { amount: 5000 },
        }),
      },
    ]);

    const rows = await rollupStore.read({
      projectId,
      metrics: ['deals_created', 'deals_won'],
      dayFrom: DAY,
      dayTo: DAY,
    });
    const created = rows.find((r) => r.metric === 'deals_created');
    const won = rows.find((r) => r.metric === 'deals_won');
    expect(created?.value).toBe(1);
    expect(created?.amount).toBe(5000);
    expect(won?.value).toBe(1);
    expect(won?.amount).toBe(5000);
  });

  it('applies duplicate bus deliveries exactly once (idempotent guard)', async () => {
    const projectId = id('proj');
    const env = dealCreatedEnvelope(projectId, { messageId: 'dup-key', payload: { amount: 100 } });
    await rollupConsumer.handle(env, 'crm.deal.created');
    await rollupConsumer.handle(env, 'crm.deal.created');

    const rows = await rollupStore.read({
      projectId,
      metrics: ['deals_created'],
      dayFrom: DAY,
      dayTo: DAY,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(1);
    expect(rows[0]?.amount).toBe(100);
  });

  // ── coverage gate → read-switch on getDashboard ────────────────────────────
  it('without backfill marker getDashboard ignores rollup (live path → zero deals)', async () => {
    const projectId = id('proj');
    await feedDealFacts(projectId, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 'no-backfill', payload: { amount: 9000 } }),
      },
    ]);

    const dash = await reports.getDashboard(
      projectId,
      'custom',
      DAY_START,
      DAY_END,
      ALL_SCOPE,
      ['deals'],
    );
    expect(kpiValue(dash, 'deals_amount')).toBe(0);
    expect(kpiValue(dash, 'won')).toBe(0);
  });

  it('after backfill marker getDashboard reads won/deals_amount from rollup cells', async () => {
    const projectId = id('proj');
    await feedDealFacts(projectId, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 'c1', payload: { amount: 1000 } }),
      },
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 'c2', payload: { amount: 2000 } }),
      },
      {
        routingKey: 'crm.deal.won',
        envelope: dealCreatedEnvelope(projectId, {
          messageId: 'w1',
          type: 'crm.deal.won',
          payload: { amount: 1500 },
        }),
      },
    ]);
    await markTrusted(projectId);

    const dash = await reports.getDashboard(
      projectId,
      'custom',
      DAY_START,
      DAY_END,
      ALL_SCOPE,
      ['deals'],
    );
    expect(kpiValue(dash, 'deals_amount')).toBe(3000);
    expect(kpiValue(dash, 'won')).toBe(1);
  });

  // ── getMetrics sales slice via rollup ──────────────────────────────────────
  it('getMetrics sales slice builds daily series from rollup (not live aggregation)', async () => {
    const projectId = id('proj');
    await feedDealFacts(projectId, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 's1', payload: { amount: 4000 } }),
      },
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 's2', payload: { amount: 6000 } }),
      },
    ]);
    await markTrusted(projectId);

    const metrics = (await reports.getMetrics(
      projectId,
      'custom',
      DAY_START,
      DAY_END,
      ['sales'],
      ALL_SCOPE,
      ['deals'],
    )) as {
      sales: Array<{ bucket: string; count: number; amount: number }>;
      avg_check: number;
      slices: string[];
    };

    expect(metrics.slices).toContain('sales');
    expect(metrics.sales).toEqual([{ bucket: DAY, count: 2, amount: 10_000 }]);
    expect(metrics.avg_check).toBe(5000);
  });

  // ── restricted visibility keeps live Mongo path ───────────────────────────
  it('restricted scope disables rollup read even when backfill marker exists', async () => {
    const projectId = id('proj');
    await feedDealFacts(projectId, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projectId, { messageId: 'r-scope', payload: { amount: 50_000 } }),
      },
    ]);
    await markTrusted(projectId);

    await mongo.deals().insertOne({
      projectId,
      amount: 777,
      status: 'open',
      assigneeId: 'u1',
      createdAt: NOON,
      deletedAt: null,
    });

    const dash = await reports.getDashboard(
      projectId,
      'custom',
      DAY_START,
      DAY_END,
      RESTRICTED_SCOPE,
      ['deals'],
    );
    expect(kpiValue(dash, 'deals_amount')).toBe(777);
  });

  // ── tenant isolation on rollup read ───────────────────────────────────────
  it('rollup cells never leak across projects on dashboard read', async () => {
    const projA = id('proj-a');
    const projB = id('proj-b');
    await feedDealFacts(projA, [
      {
        routingKey: 'crm.deal.created',
        envelope: dealCreatedEnvelope(projA, { messageId: 'iso-a', payload: { amount: 42_000 } }),
      },
    ]);
    await markTrusted(projA);
    await markTrusted(projB);

    const dashB = await reports.getDashboard(
      projB,
      'custom',
      DAY_START,
      DAY_END,
      ALL_SCOPE,
      ['deals'],
    );
    expect(kpiValue(dashB, 'deals_amount')).toBe(0);
    expect(kpiValue(dashB, 'won')).toBe(0);
  });

  // ── stage transitions consumer → getMetrics stage_timing ───────────────────
  it('stage_changed facts materialize dwell metrics consumed by getMetrics', async () => {
    const projectId = id('proj');
    const dealId = id('deal');
    const t0 = NOON;
    const t1 = t0 + 3_600_000;

    await stageConsumer.handle(
      {
        type: 'crm.deal.stage_changed',
        messageId: 'st-1',
        timestamp: new Date(t0).toISOString(),
        projectId,
        payload: { dealId, fromStageId: 'st1', toStageId: 'st2', pipelineId: 'pl1' },
      },
      'crm.deal.stage_changed',
    );
    await stageConsumer.handle(
      {
        type: 'crm.deal.stage_changed',
        messageId: 'st-2',
        timestamp: new Date(t1).toISOString(),
        projectId,
        payload: { dealId, fromStageId: 'st2', toStageId: 'st3', pipelineId: 'pl1' },
      },
      'crm.deal.stage_changed',
    );

    const metrics = (await reports.getMetrics(
      projectId,
      'custom',
      DAY_START,
      DAY_END,
      ['stage_timing'],
      ALL_SCOPE,
      ['deals'],
    )) as {
      stage_durations: Array<{ stage_id: string; transition_count: number; avg_duration_ms: number }>;
      slices: string[];
    };

    expect(metrics.slices).toContain('stage_timing');
    const st2 = metrics.stage_durations.find((r) => r.stage_id === 'st2');
    expect(st2?.transition_count).toBe(1);
    expect(st2?.avg_duration_ms).toBe(3_600_000);
  });

  // ── multi-metric bus mapping (orders + activities) ─────────────────────────
  it('maps order and activity routing keys into distinct rollup metrics', async () => {
    const projectId = id('proj');
    const base = {
      timestamp: `${DAY}T08:00:00.000Z`,
      projectId,
    };
    await rollupConsumer.handle(
      { ...base, messageId: 'o1', type: 'crm.order.created', payload: { orderId: 'ord1' } },
      'crm.order.created',
    );
    await rollupConsumer.handle(
      { ...base, messageId: 'a1', type: 'crm.activity.completed', payload: { activityId: 'act1' } },
      'crm.activity.completed',
    );

    const rows = await rollupStore.read({
      projectId,
      metrics: ['orders_created', 'activities_completed'],
      dayFrom: DAY,
      dayTo: DAY,
    });
    expect(rows.find((r) => r.metric === 'orders_created')?.value).toBe(1);
    expect(rows.find((r) => r.metric === 'activities_completed')?.value).toBe(1);
  });
});
