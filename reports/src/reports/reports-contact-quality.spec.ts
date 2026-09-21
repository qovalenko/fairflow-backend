import { ReportsService } from './reports.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import type { VisibilityScope } from '@fairflow/shared';
import { of } from 'rxjs';

describe('ReportsService clientsSlice contact_quality (FR-CONTACTS-440)', () => {
  const scope = {
    mode: 'all',
    level: 'all',
    ownerIds: [],
    sharedRecordIds: [],
  } as VisibilityScope;

  it('includes contact_quality from contact gRPC', async () => {
    const contactGrpc = {
      getContactQualityMetrics: jest.fn().mockReturnValue(
        of({
          total_contacts: 10,
          filled_both_pct: 55.5,
          duplicate_candidate_pairs: 2,
          open_drift_links: 1,
        }),
      ),
    };
    const pipeClient = { getService: () => ({ listPipelines: () => of({ list: [] }) }) };
    const contactClient = { getService: () => contactGrpc };

    const mongo = {
      contacts: () => ({
        countDocuments: jest.fn().mockResolvedValue(3),
      }),
      companies: () => ({
        countDocuments: jest.fn().mockResolvedValue(1),
      }),
      deals: () => ({
        aggregate: () => ({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    const svc = new ReportsService(
      mongo as unknown as MongoService,
      {} as MongoOutboxStore,
      pipeClient as never,
      contactClient as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
    );
    svc.onModuleInit();

    const slice = await (svc as unknown as {
      clientsSlice: (
        p: string,
        s: VisibilityScope,
        q: Record<string, unknown>,
        a?: unknown,
      ) => Promise<Record<string, unknown>>;
    }).clientsSlice('p1', scope, {}, undefined);

    expect(slice.contact_quality).toEqual({
      total_contacts: 10,
      filled_both_pct: 55.5,
      duplicate_candidate_pairs: 2,
      open_drift_links: 1,
    });
    expect(contactGrpc.getContactQualityMetrics).toHaveBeenCalled();
  });
});
