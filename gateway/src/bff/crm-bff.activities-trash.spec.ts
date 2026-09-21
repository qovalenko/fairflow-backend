import { of } from 'rxjs';
import { ForbiddenException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

/**
 * be-activities-trash-slice: GET /activities?state=trashed and the explicit
 * GET /activities/trash route must both hit ActivityGrpc.ListTrash (honest total),
 * NOT ListActivities. The normal list path stays on ListActivities.
 */
describe('CrmBffController activities trash slice', () => {
  const trashRow = { id: 't1', type: 'task', title: 'deleted', deleted_at: 5 };

  function build() {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const activitySvc = {
      listActivities: (p: Record<string, unknown>) => {
        calls.push({ method: 'listActivities', payload: p });
        return of({ list: [{ id: 'a1', type: 'task', title: 'live' }], total: 3 });
      },
      listTrash: (p: Record<string, unknown>) => {
        calls.push({ method: 'listTrash', payload: p });
        return of({ list: [trashRow], total: 137 });
      },
    };
    const activityClient = {
      getService: () => activitySvc,
    } as unknown as ClientGrpcProxy;
    const nullClient = { getService: () => ({}) } as unknown as ClientGrpcProxy;
    const outboundMeta = {
      build: () => ({}),
    } as unknown as GatewayOutboundMetadataService;

    const ctrl = new CrmBffController(
      nullClient, // PIPE
      nullClient, // ORDERS
      nullClient, // PRODUCT
      activityClient, // ACTIVITY
      nullClient, // DOCUMENTS
      nullClient, // REPORTS
      nullClient, // AUTOMATION
      nullClient, // CONTROL
      nullClient, // CONTACT
      nullClient, // COMPANY
      outboundMeta,
      {} as never, // docStorage
      { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
      { resolveNames: async () => new Map() } as never, // identity (TODO-207)
      {} as never, // reportRunNames (не используется в этом сценарии)
    );
    ctrl.onModuleInit();
    return { ctrl, calls };
  }

  const req = { __projectRole: 'owner' } as never;

  it('state=trashed → ListTrash with honest total, not ListActivities', async () => {
    const { ctrl, calls } = build();
    const res = await ctrl.listActivities(
      req,
      'p1',
      '0',
      '25',
      undefined, // query
      undefined, // type
      undefined, // types
      undefined, // status
      undefined, // overdueOnly
      undefined, // assigneeId
      undefined, // linkEntityType
      undefined, // linkEntityId
      undefined, // dateFrom
      undefined, // dateTo
      undefined, // includeDeleted
      undefined, // sortField
      undefined, // sortOrder
      'trashed', // state
    );
    expect(calls.map((c) => c.method)).toEqual(['listTrash']);
    expect(res.total).toBe(137);
    expect(res.list).toHaveLength(1);
    expect(res.list[0].id).toBe('t1');
  });

  it('state=trashed without delete permission → 403', async () => {
    const { ctrl } = build();
    await expect(
      ctrl.listActivities(
        {} as never,
        'p1',
        '0',
        '25',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'trashed',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no state → ListActivities (normal path unchanged)', async () => {
    const { ctrl, calls } = build();
    const res = await ctrl.listActivities(req, 'p1', '0', '25');
    expect(calls.map((c) => c.method)).toEqual(['listActivities']);
    expect(res.total).toBe(3);
  });

  it('GET /activities/trash → ListTrash', async () => {
    const { ctrl, calls } = build();
    const res = await ctrl.listActivitiesTrash(req, 'p1', '0', '25', undefined);
    expect(calls.map((c) => c.method)).toEqual(['listTrash']);
    expect(calls[0].payload.project_id).toBe('p1');
    expect(res.total).toBe(137);
  });
});
