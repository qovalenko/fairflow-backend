import { loadSync } from '@grpc/proto-loader';
import { CrmEntityExecutor } from './crm-entity-executor';
import { AUTOMATION_GRPC_LOADER_OPTIONS, protoPath, type GrpcInvokeResult } from './grpc-action-executor';
import type { EntityDomain } from './entity-domains';
import type { ExecutorContext } from './executor.types';

/**
 * The three CRM actions the rule editor has always offered and the backend has
 * always refused: `assign_user`, `change_stage`, `update_field` (TODO-039).
 *
 * Until this executor existed all three came back `deferred/executor_unavailable`
 * — the user configured a rule, it saved, it triggered, and nothing happened.
 * These tests pin the four properties that make them safe to actually run:
 * they hit the right existing RPC, a stage change goes through the MOVE path,
 * a repeat is a no-op (retry-safe), and a wrong config fails terminally instead
 * of looping on the retry ladder.
 */

type Req = Record<string, unknown>;
type Call = { domain: string; method: string; req: Req };

class TestExecutor extends CrmEntityExecutor {
  calls: Call[] = [];
  responses = new Map<string, GrpcInvokeResult>();
  fallback: GrpcInvokeResult = { ok: true, response: {} };

  protected invoke(
    domain: EntityDomain,
    method: string,
    req: Record<string, unknown>,
    _ctx: ExecutorContext,
  ): Promise<GrpcInvokeResult> {
    this.calls.push({ domain: domain.kind, method, req });
    return Promise.resolve(this.responses.get(method) ?? this.fallback);
  }

  on(method: string, result: GrpcInvokeResult): this {
    this.responses.set(method, result);
    return this;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const ctx = (payload: Record<string, unknown>, extra: Partial<ExecutorContext> = {}): ExecutorContext => ({
  projectId: 'p1',
  userId: '',
  payload,
  ...extra,
});

describe('assign_user (TODO-039)', () => {
  it('reassigns the triggering deal through PipeGrpc.UpdateDeal', async () => {
    const ex = new TestExecutor().on('GetDeal', {
      ok: true,
      response: { id: 'd1', assignee_id: 'old', stage_id: 's1' },
    });
    const res = await ex.execute('assign_user', { config: { userId: 'u-42' } }, ctx({ dealId: 'd1' }));

    expect(res).toEqual({ ok: true, assignee: 'u-42' });
    expect(ex.methods()).toEqual(['GetDeal', 'UpdateDeal']);
    expect(ex.calls[1]).toMatchObject({
      domain: 'deal',
      // snake_case exactly as the proto declares it — the keepCase rake.
      req: { project_id: 'p1', id: 'd1', assignee_id: 'u-42' },
    });
  });

  it('is a NO-OP when the record already has that assignee (retry-safe)', async () => {
    const ex = new TestExecutor().on('GetDeal', {
      ok: true,
      response: { id: 'd1', assignee_id: 'u-42' },
    });
    const res = await ex.execute('assign_user', { config: { userId: 'u-42' } }, ctx({ dealId: 'd1' }));

    expect(res).toEqual({ ok: true, noop: true, assignee: 'u-42' });
    expect(ex.methods()).toEqual(['GetDeal']); // no second write
  });

  it('writes the contact owner through its OWN field pair (owner_id read / assignee_id write)', async () => {
    const ex = new TestExecutor().on('GetContact', {
      ok: true,
      response: { id: 'c1', owner_id: 'old' },
    });
    const res = await ex.execute(
      'assign_user',
      { config: { userId: 'u-9', entityType: 'contact' } },
      ctx({ contactId: 'c1' }),
    );

    expect(res.ok).toBe(true);
    expect(ex.methods()).toEqual(['GetContact', 'UpdateContact']);
    expect(ex.calls[1].req).toMatchObject({ project_id: 'p1', id: 'c1', assignee_id: 'u-9' });
  });

  it('targets the record the TRIGGER fired on when the payload names several', async () => {
    const ex = new TestExecutor().on('GetContact', { ok: true, response: { owner_id: '' } });
    await ex.execute(
      'assign_user',
      { config: { userId: 'u1' } },
      ctx({ contactId: 'c1', dealId: 'd1' }, { entityType: 'contact' }),
    );
    expect(ex.calls[0].domain).toBe('contact');
  });

  it('fails terminally without a user id instead of silently doing nothing', async () => {
    const ex = new TestExecutor();
    const res = await ex.execute('assign_user', { config: {} }, ctx({ dealId: 'd1' }));
    expect(res).toEqual({ ok: false, error: 'assign_user_user_required' });
    expect(ex.calls).toHaveLength(0);
  });

  it('resolves {{...}} placeholders from the trigger payload', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { assignee_id: '' } });
    const res = await ex.execute(
      'assign_user',
      { config: { userId: '{{trigger.movedBy}}' } },
      ctx({ dealId: 'd1', movedBy: 'u-77' }),
    );
    expect(res.assignee).toBe('u-77');
    expect(ex.calls[1].req).toMatchObject({ assignee_id: 'u-77' });
  });
});

describe('change_stage (TODO-039)', () => {
  it('uses the MOVE path, never a flat stage_id write', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { stage_id: 's1' } });
    const res = await ex.execute('change_stage', { config: { stageId: 's2' } }, ctx({ dealId: 'd1' }));

    expect(res).toEqual({ ok: true });
    expect(ex.methods()).toEqual(['GetDeal', 'MoveDealToStage']);
    expect(ex.calls[1].req).toEqual({ project_id: 'p1', deal_id: 'd1', stage_id: 's2' });
    // A stage written through UpdateDeal would skip stageLog/history entirely.
    expect(ex.methods()).not.toContain('UpdateDeal');
  });

  it('is a NO-OP when the deal is already on that stage (no duplicate stage-log entry)', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { stage_id: 's2' } });
    const res = await ex.execute('change_stage', { config: { stageId: 's2' } }, ctx({ dealId: 'd1' }));

    expect(res).toEqual({ ok: true, noop: true });
    expect(ex.methods()).toEqual(['GetDeal']);
  });

  it('moves an ORDER through MoveOrderToStage', async () => {
    const ex = new TestExecutor().on('GetOrder', { ok: true, response: { stage_id: 'a' } });
    const res = await ex.execute(
      'change_stage',
      { config: { stage: 'b', entityType: 'order' } },
      ctx({ orderId: 'o1' }),
    );
    expect(res.ok).toBe(true);
    expect(ex.calls[1]).toMatchObject({
      method: 'MoveOrderToStage',
      req: { project_id: 'p1', order_id: 'o1', stage_id: 'b' },
    });
  });

  it('accepts the legacy `move_stage` id the v2 palette still ships', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { stage_id: 's1' } });
    const res = await ex.execute('move_stage', { config: { stage: 's2' } }, ctx({ dealId: 'd1' }));
    expect(res.ok).toBe(true);
    expect(ex.methods()).toContain('MoveDealToStage');
  });

  it('fails terminally without a stage id', async () => {
    const ex = new TestExecutor();
    const res = await ex.execute('change_stage', { config: {} }, ctx({ dealId: 'd1' }));
    expect(res).toEqual({ ok: false, error: 'change_stage_stage_required' });
  });
});

describe('update_field (TODO-039)', () => {
  it('updates a whitelisted deal field', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { source: 'web' } });
    const res = await ex.execute(
      'update_field',
      { config: { field: 'source', value: 'partner' } },
      ctx({ dealId: 'd1' }),
    );
    expect(res).toEqual({ ok: true });
    expect(ex.calls[1].req).toMatchObject({ project_id: 'p1', id: 'd1', source: 'partner' });
  });

  it('coerces a numeric field and rejects a non-numeric value terminally', async () => {
    const ok = new TestExecutor().on('GetDeal', { ok: true, response: { amount: 100 } });
    await ok.execute('update_field', { config: { field: 'amount', value: '250' } }, ctx({ dealId: 'd1' }));
    expect(ok.calls[1].req).toMatchObject({ amount: 250 });

    const bad = new TestExecutor();
    const res = await bad.execute(
      'update_field',
      { config: { field: 'amount', value: 'много' } },
      ctx({ dealId: 'd1' }),
    );
    expect(res).toEqual({ ok: false, error: 'update_field_value_not_a_number' });
    expect(bad.calls).toHaveLength(0);
  });

  it('accepts camelCase field names from the editor (assigneeId → assignee_id)', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { assignee_id: 'a' } });
    await ex.execute(
      'update_field',
      { config: { field: 'assigneeId', value: 'b' } },
      ctx({ dealId: 'd1' }),
    );
    expect(ex.calls[1].req).toMatchObject({ assignee_id: 'b' });
  });

  it('routes a stage_id write to the MOVE path rather than a flat update', async () => {
    const ex = new TestExecutor().on('GetDeal', { ok: true, response: { stage_id: 's1' } });
    const res = await ex.execute(
      'update_field',
      { config: { field: 'stage_id', value: 's3' } },
      ctx({ dealId: 'd1' }),
    );
    expect(res.ok).toBe(true);
    expect(ex.methods()).toEqual(['GetDeal', 'MoveDealToStage']);
  });

  it('merges an order custom field into fields_json instead of replacing the blob', async () => {
    const ex = new TestExecutor().on('GetOrder', {
      ok: true,
      response: { fields_json: JSON.stringify({ kept: 'yes', target: 'old' }) },
    });
    const res = await ex.execute(
      'update_field',
      { config: { field: 'target', value: 'new', entityType: 'order' } },
      ctx({ orderId: 'o1' }),
    );
    expect(res.ok).toBe(true);
    expect(JSON.parse(String(ex.calls[1].req.fields_json))).toEqual({ kept: 'yes', target: 'new' });
  });

  it('is a NO-OP when the order custom field already holds the value', async () => {
    const ex = new TestExecutor().on('GetOrder', {
      ok: true,
      response: { fields_json: JSON.stringify({ target: 'new' }) },
    });
    const res = await ex.execute(
      'update_field',
      { config: { field: 'target', value: 'new', entityType: 'order' } },
      ctx({ orderId: 'o1' }),
    );
    expect(res).toEqual({ ok: true, noop: true });
    expect(ex.methods()).toEqual(['GetOrder']);
  });

  it('rejects an unknown field terminally (a typo must not retry forever)', async () => {
    const ex = new TestExecutor();
    const res = await ex.execute(
      'update_field',
      { config: { field: 'nope', value: 'x' } },
      ctx({ dealId: 'd1' }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('update_field_unknown_field:deal.nope');
    expect(ex.calls).toHaveLength(0);
  });
});

describe('isolation and error classification', () => {
  it('refuses an action config pointing at another project', async () => {
    const ex = new TestExecutor();
    const res = await ex.execute(
      'assign_user',
      { config: { userId: 'u1', project_id: 'other-project' } },
      ctx({ dealId: 'd1' }),
    );
    expect(res).toEqual({ ok: false, error: 'project_scope_violation' });
    expect(ex.calls).toHaveLength(0);
  });

  it('fails terminally when no target record can be resolved', async () => {
    const ex = new TestExecutor();
    const res = await ex.execute('assign_user', { config: { userId: 'u1' } }, ctx({}));
    expect(res).toEqual({ ok: false, error: 'assign_user_target_unresolved' });
  });

  it('marks a transport fault TRANSIENT and a domain rejection TERMINAL', async () => {
    const unavailable = new TestExecutor().on('GetDeal', {
      ok: false,
      grpcCode: 14,
      error: '14 UNAVAILABLE: no connection',
    });
    const transient = await unavailable.execute(
      'assign_user',
      { config: { userId: 'u1' } },
      ctx({ dealId: 'd1' }),
    );
    expect(transient.ok).toBe(false);
    expect(transient.error).toMatch(/^executor_transient:assign_user/);

    const notFound = new TestExecutor().on('GetDeal', { ok: false, grpcCode: 5, error: 'Not found' });
    const terminal = await notFound.execute(
      'assign_user',
      { config: { userId: 'u1' } },
      ctx({ dealId: 'd1' }),
    );
    expect(terminal.error).toBe('assign_user_rejected:not_found');

    const unconfigured = new TestExecutor().on('GetDeal', {
      ok: false,
      notConfigured: true,
      error: 'executor_unavailable',
    });
    const deployment = await unconfigured.execute(
      'change_stage',
      { config: { stageId: 's2' } },
      ctx({ dealId: 'd1' }),
    );
    expect(deployment.error).toBe('change_stage_target_not_configured');
  });
});

describe('wire contract (keepCase rake guard)', () => {
  const serde = (proto: string[], serviceFq: string, method: string) => {
    const def = loadSync(protoPath(...proto), AUTOMATION_GRPC_LOADER_OPTIONS);
    const svc = def[serviceFq] as unknown as Record<
      string,
      {
        requestSerialize: (v: Record<string, unknown>) => Buffer;
        requestDeserialize: (b: Buffer) => Record<string, unknown>;
      }
    >;
    return svc[method];
  };

  it('MoveDealToStage keeps project_id/deal_id/stage_id on the wire', () => {
    const m = serde(['fairflow', 'pipe', 'v1', 'pipe.proto'], 'fairflow.pipe.v1.PipeGrpc', 'MoveDealToStage');
    const back = m.requestDeserialize(
      m.requestSerialize({ project_id: 'p1', deal_id: 'd1', stage_id: 's2' }),
    );
    expect(back).toMatchObject({ project_id: 'p1', deal_id: 'd1', stage_id: 's2' });
  });

  it('UpdateDeal keeps assignee_id on the wire', () => {
    const m = serde(['fairflow', 'pipe', 'v1', 'pipe.proto'], 'fairflow.pipe.v1.PipeGrpc', 'UpdateDeal');
    const back = m.requestDeserialize(
      m.requestSerialize({ project_id: 'p1', id: 'd1', assignee_id: 'u-42' }),
    );
    expect(back.assignee_id).toBe('u-42');
  });

  it('UpdateContact / UpdateCompany / UpdateOrder keep their snake_case fields', () => {
    const c = serde(['fairflow', 'contact', 'v1', 'contact.proto'], 'fairflow.contact.v1.ContactGrpc', 'UpdateContact');
    expect(c.requestDeserialize(c.requestSerialize({ project_id: 'p', id: 'c', first_name: 'Анна' })).first_name).toBe('Анна');

    const k = serde(['fairflow', 'company', 'v1', 'company.proto'], 'fairflow.company.v1.CompanyGrpc', 'UpdateCompany');
    expect(k.requestDeserialize(k.requestSerialize({ project_id: 'p', id: 'k', legal_address: 'Москва' })).legal_address).toBe('Москва');

    const o = serde(['fairflow', 'orders', 'v1', 'orders.proto'], 'fairflow.orders.v1.OrdersGrpc', 'UpdateOrder');
    expect(o.requestDeserialize(o.requestSerialize({ project_id: 'p', id: 'o', fields_json: '{"a":1}' })).fields_json).toBe('{"a":1}');
  });

  it('NotificationGrpc.Send keeps project_id/user_id/data_json on the wire', () => {
    const m = serde(
      ['fairflow', 'notification', 'v1', 'notification.proto'],
      'fairflow.notification.v1.NotificationGrpc',
      'Send',
    );
    const back = m.requestDeserialize(
      m.requestSerialize({
        project_id: 'p1',
        user_id: 'u1',
        channel: 'in_app',
        title: 't',
        body: 'b',
        data_json: '{"source":"automation"}',
        email_to: '',
      }),
    );
    expect(back).toMatchObject({ project_id: 'p1', user_id: 'u1', data_json: '{"source":"automation"}' });
  });
});
