import { of } from 'rxjs';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

/**
 * TODO-030: POST /activities/bulk lost the projectId. The frontend ships it in
 * the body (and always as the `x-project-id` header via the axios interceptor),
 * while the handler read it only from the query → project_id: undefined in every
 * gRPC call → INVALID_ARGUMENT «projectId обязателен» for each id, i.e. bulk
 * complete/delete never worked.
 *
 * The fix resolves the pid through `authoritativeProjectId` (SEC-ISO-1 /
 * TODO-001): guard-enforced query/header only, a mismatching body value → 403,
 * no project context at all → 400 (fail-closed).
 */
describe('CrmBffController POST /activities/bulk projectId resolution (TODO-030)', () => {
  function build() {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const metaPids: unknown[] = [];
    const activitySvc = {
      completeActivity: (p: Record<string, unknown>) => {
        calls.push({ method: 'completeActivity', payload: p });
        return of({ id: p.id });
      },
      deleteActivity: (p: Record<string, unknown>) => {
        calls.push({ method: 'deleteActivity', payload: p });
        return of({});
      },
    };
    const activityClient = { getService: () => activitySvc } as unknown as ClientGrpcProxy;
    const nullClient = { getService: () => ({}) } as unknown as ClientGrpcProxy;
    const outboundMeta = {
      build: (_req: unknown, opts?: { projectId?: string }) => {
        metaPids.push(opts?.projectId);
        return {};
      },
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
    return { ctrl, calls, metaPids };
  }

  /** Request as the guard leaves it: role resolved, ambient x-project-id header. */
  const reqFor = (headerPid?: string, role = 'owner') =>
    ({
      headers: headerPid ? { 'x-project-id': headerPid } : {},
      __projectRole: role,
    }) as never;

  it('header-only project context (current frontend) → pid reaches gRPC payload and metadata', async () => {
    const { ctrl, calls, metaPids } = build();
    const res = await ctrl.bulkActivities(reqFor('p1'), undefined as unknown as string, {
      action: 'complete',
      ids: ['a1', 'a2'],
      projectId: 'p1',
    });
    expect(res.succeeded).toEqual(['a1', 'a2']);
    expect(res.failed).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['completeActivity', 'completeActivity']);
    for (const c of calls) expect(c.payload.project_id).toBe('p1');
    // Outbound gRPC metadata (x-project-id) must carry the same resolved pid.
    expect(metaPids).toEqual(['p1', 'p1']);
  });

  it('query projectId is the authoritative source for delete as well', async () => {
    const { ctrl, calls } = build();
    await ctrl.bulkActivities(reqFor('p1'), 'p1', { action: 'delete', ids: ['a1'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('deleteActivity');
    expect(calls[0].payload.project_id).toBe('p1');
  });

  it('no query/header project context → 400 (fail-closed), no gRPC calls', async () => {
    const { ctrl, calls } = build();
    await expect(
      ctrl.bulkActivities(reqFor(undefined), undefined as unknown as string, {
        action: 'complete',
        ids: ['a1'],
        projectId: 'p-body-only',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('body projectId mismatching the authorized one → 403, no gRPC calls', async () => {
    const { ctrl, calls } = build();
    await expect(
      ctrl.bulkActivities(reqFor('p1'), 'p1', {
        action: 'complete',
        ids: ['a1'],
        projectId: 'p-other',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  // TODO-004: bulk action='delete' must require the same right as the single
  // DELETE activities/:id (@RequirePermission('activities','delete')) — the
  // route decorator only enforces 'write', so a member (write, no delete) could
  // mass-delete up to 100 activities past their assigned role.
  it("action='delete' with a role lacking activities:delete (member) → 403, no gRPC calls", async () => {
    const { ctrl, calls } = build();
    await expect(
      ctrl.bulkActivities(reqFor('p1', 'member'), 'p1', { action: 'delete', ids: ['a1'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it("action='complete' stays allowed for a member (write is enough)", async () => {
    const { ctrl, calls } = build();
    const res = await ctrl.bulkActivities(reqFor('p1', 'member'), 'p1', {
      action: 'complete',
      ids: ['a1'],
    });
    expect(res.succeeded).toEqual(['a1']);
    expect(calls.map((c) => c.method)).toEqual(['completeActivity']);
  });

  it("action='delete' with a delete-capable role (manager) proceeds", async () => {
    const { ctrl, calls } = build();
    const res = await ctrl.bulkActivities(reqFor('p1', 'manager'), 'p1', {
      action: 'delete',
      ids: ['a1'],
    });
    expect(res.succeeded).toEqual(['a1']);
    expect(calls.map((c) => c.method)).toEqual(['deleteActivity']);
  });
});
