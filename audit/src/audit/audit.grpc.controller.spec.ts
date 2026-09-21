import { RpcException } from '@nestjs/microservices';
import { GW_METADATA } from '@fairflow/shared';
import { AuditGrpcController } from './audit.grpc.controller';
import type { AuditService } from './audit.service';

const PID = 'proj-audit-1';

function metadata(extra: Record<string, string> = {}) {
  const map: Record<string, string[]> = {
    [GW_METADATA.PROJECT_ID]: [PID],
    [GW_METADATA.USER_ID]: ['user-1'],
    [GW_METADATA.ACTOR_TYPE]: ['user'],
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, [v]])),
  };
  return {
    get: (key: string) => map[key] ?? [],
  } as never;
}

function stubAudit() {
  return {
    appendEvent: jest.fn().mockResolvedValue({ id: 'e1', project_id: PID }),
    listEvents: jest.fn().mockResolvedValue({ list: [], total: 0 }),
    getEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
    verifyChain: jest.fn().mockResolvedValue({
      chainKey: 'record|p1',
      status: 'ok',
      checked: 5,
    }),
  };
}

describe('AuditGrpcController', () => {
  it('AppendEvent maps snake_case body and prefers trusted metadata for project/actor', async () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    await ctrl.appendEvent(
      {
        event_name: 'crm.deal.updated.v1',
        entity_type: 'deal',
        entity_id: 'd-1',
        actor_id: 'spoofed',
        actor_type: 'system',
        payload_json: '{}',
        request_id: 'req-1',
        trace_id: 'trace-1',
      },
      metadata(),
    );

    expect(audit.appendEvent).toHaveBeenCalledWith(PID, {
      event_name: 'crm.deal.updated.v1',
      entity_type: 'deal',
      entity_id: 'd-1',
      actor_id: 'user-1',
      actor_type: 'user',
      payload_json: '{}',
      request_id: 'req-1',
      trace_id: 'trace-1',
    });
  });

  it('AppendEvent rejects a body project_id that conflicts with x-project-id', () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    expect(() =>
      ctrl.appendEvent({ project_id: 'other', event_name: 'crm.deal.updated.v1' }, metadata()),
    ).toThrow(RpcException);
    expect(audit.appendEvent).not.toHaveBeenCalled();
  });

  it('ListEvents forwards pagination and entity filters', async () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    await ctrl.listEvents(
      {
        page_index: 2,
        page_size: 10,
        entity_type: 'contact',
        entity_id: 'c-1',
      },
      metadata(),
    );

    expect(audit.listEvents).toHaveBeenCalledWith(PID, 2, 10, 'contact', 'c-1');
  });

  it('GetEvent resolves project from metadata and passes the event id', async () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    await ctrl.getEvent({ id: '507f1f77bcf86cd799439011' }, metadata());

    expect(audit.getEvent).toHaveBeenCalledWith(PID, '507f1f77bcf86cd799439011');
  });

  it('VerifyAuditChain maps verifyChain result to snake_case gRPC response', async () => {
    const audit = stubAudit();
    audit.verifyChain.mockResolvedValue({
      chainKey: 'record|p1',
      status: 'broken',
      checked: 3,
      brokenAt: {
        seq: 2,
        expectedHash: 'aaa',
        actualHash: 'bbb',
        reason: 'hash_mismatch',
      },
    });
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    const res = await ctrl.verifyAuditChain({ level: 'record' }, metadata({ [GW_METADATA.PROJECT_ID]: 'p1' }));

    expect(audit.verifyChain).toHaveBeenCalledWith({
      level: 'record',
      organizationId: undefined,
      projectId: 'p1',
    });
    expect(res).toMatchObject({
      chain_key: 'record|p1',
      status: 'broken',
      checked: 3,
      broken_at: {
        seq: 2,
        expected_hash: 'aaa',
        actual_hash: 'bbb',
        reason: 'hash_mismatch',
      },
    });
    expect(res.verified_at).toEqual(expect.any(Number));
  });

  it('falls back to body project_id when metadata has no x-project-id (s2s)', async () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    await ctrl.listEvents({ project_id: 'body-only' }, { get: () => [] } as never);

    expect(audit.listEvents).toHaveBeenCalledWith('body-only', 0, 25, undefined, undefined);
  });

  it('falls back to body actor when gateway metadata has no user (s2s)', async () => {
    const audit = stubAudit();
    const ctrl = new AuditGrpcController(audit as unknown as AuditService);

    await ctrl.appendEvent(
      {
        project_id: 'body-only',
        event_name: 'crm.deal.updated.v1',
        entity_type: 'deal',
        entity_id: 'd-1',
        actor_id: 'svc-1',
        actor_type: 'service',
      },
      { get: () => [] } as never,
    );

    expect(audit.appendEvent).toHaveBeenCalledWith(
      'body-only',
      expect.objectContaining({
        actor_id: 'svc-1',
        actor_type: 'service',
      }),
    );
  });
});
