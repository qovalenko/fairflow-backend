process.env.REPORTS_METRIC_BLOCK_MS = '50';

import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

type Rec = Record<string, unknown>;

const SCOPE_ALL: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

function slowMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function harness() {
  const dealsColl = {
    countDocuments: async () => {
      await slowMs(200);
      return 0;
    },
    aggregate: () => ({ toArray: async () => [] }),
    find: () => ({
      sort: () => ({
        limit: () => ({ toArray: async () => [] }),
      }),
    }),
  };
  const emptyColl = {
    countDocuments: async () => 0,
    aggregate: () => ({ toArray: async () => [] }),
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
    deals: () => dealsColl,
    orders: () => emptyColl,
    contacts: () => emptyColl,
    companies: () => emptyColl,
    activities: () => emptyColl,
    reports: () => ({
      countDocuments: async () => 0,
      aggregate: () => ({ toArray: async () => [] }),
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      findOne: async () => ({
        _id: new ObjectId('507f1f77bcf86cd799439011'),
        projectId: 'p1',
        name: 'Продажи',
        kind: 'sales',
        presetKey: 'sales',
        createdAt: 1,
        updatedAt: 1,
      }),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
    }),
  };
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
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    pipeClient as never,
    contactClient as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return svc;
}

describe('NFR-020 (statistics): metric block deadline', () => {
  it('marks partial=true when a dashboard provider exceeds the block deadline', async () => {
    const svc = harness();
    const res = (await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL)) as {
      partial?: boolean;
    };
    expect(res.partial).toBe(true);
  });
});
