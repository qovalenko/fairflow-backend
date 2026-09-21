/**
 * Regression tests for the P0 automation fixes:
 *  - TODO-007: external-effect actions in FLAT (v1) rules require automation:manage
 *    (fail-closed — absent can_manage denies);
 *  - TODO-037: the classic-form trigger id is normalized on write
 *    (trigger_type='event' + trigger_config_json.event_name), unknown ids rejected;
 *  - TODO-038: non-compilable conditions are rejected on save (reject-on-save);
 *  - TODO-039: GetRegistry only offers actions that can actually run;
 *  - TODO-041: RetryDlq re-dispatches the stored action and resolves/fails the row.
 */
import { RpcException } from '@nestjs/microservices';
import { AutomationService } from './automation.service';
import { DlqRetryService } from './dlq-retry.service';

type AnyFn = jest.Mock;

function makeCollections() {
  return {
    rules: {
      insertOne: jest.fn(async (_doc?: unknown) => ({})),
      findOne: jest.fn(async () => null),
      find: jest.fn(() => ({
        sort: () => ({ toArray: async () => [] as unknown[] }),
        toArray: async () => [] as unknown[],
      })),
      updateOne: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    },
    dlq: {
      findOne: jest.fn(async () => null),
      findOneAndUpdate: jest.fn(async () => null),
      updateOne: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    },
  };
}

function makeService(
  cols = makeCollections(),
  dispatcher?: { dispatchOne?: AnyFn; dispatch?: AnyFn },
) {
  const mongo = {
    rules: () => cols.rules,
    dlq: () => cols.dlq,
    executions: () => ({
      insertOne: jest.fn(),
      updateOne: jest.fn(),
      countDocuments: jest.fn(async () => 0),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ toArray: async () => [] }),
          }),
        }),
      })),
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
    }),
    connections: () => ({ findOne: jest.fn() }),
    eventHooks: () => ({ insertOne: jest.fn() }),
  };
  const rabbit = {
    publish: jest.fn(async () => undefined),
    publishEnvelope: jest.fn(async () => undefined),
  };
  const gate = { isAutomationRuntimeActive: jest.fn(async () => true) };
  const disp = { dispatch: jest.fn(), dispatchOne: jest.fn(), ...(dispatcher ?? {}) };
  const secrets = { sealer: jest.fn(), reveal: jest.fn() };
  const entitySnapshot = {
    fetchRecord: jest.fn(async () => ({ entity_type: 'deal', entity_id: 'd1', amount: 1 })),
  };
  // Only create_activity has a wired executor (mirrors ExecutorRegistry today).
  const executors = {
    forAction: (t: string) => (t === 'create_activity' ? ({} as never) : null),
  };
  // The REAL retry engine over the mocked collections: RetryDlq delegates to it,
  // so the tests still cover the claim → dispatch → settle path end to end.
  const dlqRetry = new DlqRetryService(mongo as never, disp as never, { publishEnvelope: jest.fn() } as never);
  const throttle = { isThrottled: jest.fn(async () => false) };
  const operatorNotify = { notify: jest.fn(async () => true) };
  const outbox = {
    withOutbox: jest.fn(async (work: (session?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
      const captured = await work(undefined);
      return captured.result;
    }),
  };
  const service = new AutomationService(
    mongo as never,
    rabbit as never,
    gate as never,
    disp as never,
    secrets as never,
    executors as never,
    dlqRetry as never,
    entitySnapshot as never,
    throttle as never,
    operatorNotify as never,
    outbox as never,
  );
  return { service, cols, rabbit, disp, dlqRetry, entitySnapshot, throttle, outbox, gate, operatorNotify };
}

const PROJECT = 'proj-1';

describe('AutomationService v1 save gates', () => {
  it('TODO-007: rejects a flat rule with send_webhook without can_manage (fail-closed)', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'wh',
        trigger_type: 'crm.deal.created',
        actions_json: JSON.stringify([{ type: 'send_webhook', connectionId: 'c1' }]),
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'EXTERNAL_EFFECT_REQUIRES_MANAGE' }),
    });
  });

  it('TODO-007: rejects can_manage=false explicitly', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'wh',
        trigger_type: 'crm.deal.created',
        can_manage: false,
        actions_json: JSON.stringify([{ type: 'send_email', config: {} }]),
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('TODO-007: allows the same rule with can_manage=true', async () => {
    const { service, cols } = makeService();
    const rule = await service.createRule(PROJECT, {
      name: 'wh',
      trigger_type: 'crm.deal.created',
      can_manage: true,
      actions_json: JSON.stringify([{ type: 'send_webhook', connectionId: 'c1' }]),
    });
    expect(rule.name).toBe('wh');
    expect(cols.rules.insertOne).toHaveBeenCalled();
  });

  it('TODO-037: normalizes the classic-form trigger id into event + event_name', async () => {
    const { service, cols } = makeService();
    await service.createRule(PROJECT, {
      name: 'r',
      trigger_type: 'crm.deal.created',
      actions_json: JSON.stringify([{ type: 'create_activity', config: { title: 't' } }]),
    });
    const inserted = cols.rules.insertOne.mock.calls[0][0] as Record<string, string>;
    expect(inserted.trigger_type).toBe('event');
    expect(JSON.parse(inserted.trigger_config_json)).toMatchObject({
      event_name: 'crm.deal.created',
    });
  });

  it('TODO-037: rejects an unknown trigger id instead of saving an unmatchable rule', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'r',
        trigger_type: 'crm.task.overdue',
        actions_json: '[]',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('TODO-038: rejects the legacy {op:and,args} shape the compiler cannot evaluate', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'r',
        trigger_type: 'crm.deal.created',
        conditions_json: JSON.stringify({
          op: 'and',
          args: [{ field: 'amount', op: 'gt', value: 1000 }],
        }),
        actions_json: '[]',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining('CONDITIONS_NOT_COMPILABLE'),
      }),
    });
  });

  it('TODO-038: accepts the canonical {and:[...]} shape the form now sends', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'r',
        trigger_type: 'crm.deal.created',
        conditions_json: JSON.stringify({
          and: [
            { field: 'amount', op: 'gt', value: '1000' },
            { field: 'owner', op: 'exists', value: true },
          ],
        }),
        actions_json: '[]',
      }),
    ).resolves.toMatchObject({ name: 'r' });
  });
});

describe('AutomationService registry honesty (TODO-039)', () => {
  it('only lists actions with a wired executor (plus send_webhook)', () => {
    const { service } = makeService();
    const { actions } = service.getRegistry(PROJECT, []);
    expect(actions.map((a: { id: string }) => a.id).sort()).toEqual([
      'create_activity',
      'send_webhook',
    ]);
  });
});

describe('AutomationService.retryDlq (TODO-041)', () => {
  const dlqDoc = {
    id: 'd1',
    project_id: PROJECT,
    execution_id: 'e1',
    rule_id: 'r1',
    action_index: 0,
    action_type: 'send_webhook',
    action_config_json: JSON.stringify({ type: 'send_webhook', connection_id: 'c1' }),
    connection_id: 'c1',
    payload_json: JSON.stringify({ amount: 1 }),
    status: 'failed',
    attempts: 1,
    created_at: 1,
    updated_at: 1,
  };

  /** The rule the row belongs to, as the retry engine re-reads it before re-sending. */
  const activeRule = { id: 'r1', enabled: true, state: 'enabled' };

  it('re-dispatches the stored action and resolves the row on success', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(activeRule as never);
    cols.dlq.findOne.mockResolvedValue({ ...dlqDoc } as never);
    cols.dlq.findOneAndUpdate.mockResolvedValue({
      ...dlqDoc,
      status: 'retrying',
      attempts: 2,
    } as never);
    const dispatchOne = jest.fn(async () => ({
      index: 0,
      type: 'send_webhook',
      status: 'success',
      attempts: 1,
      http_code: 200,
    }));
    const { service, disp } = makeService(cols, { dispatchOne });
    const result = await service.retryDlq(PROJECT, 'd1');
    expect(disp.dispatchOne).toHaveBeenCalledWith(
      'send_webhook',
      expect.objectContaining({ connection_id: 'c1' }),
      expect.objectContaining({ projectId: PROJECT, skipDlq: true, source: 'dlq_retry' }),
    );
    expect(result.status).toBe('resolved');
    expect(cols.dlq.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'd1', status: 'retrying' },
      { $set: expect.objectContaining({ status: 'resolved' }) },
    );
  });

  it('returns the row to failed (not eternal retrying) when the dispatch fails', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(activeRule as never);
    cols.dlq.findOne.mockResolvedValue({ ...dlqDoc } as never);
    cols.dlq.findOneAndUpdate.mockResolvedValue({
      ...dlqDoc,
      status: 'retrying',
      attempts: 2,
    } as never);
    const dispatchOne = jest.fn(async () => ({
      index: 0,
      type: 'send_webhook',
      status: 'fail',
      attempts: 1,
      error: 'http_503',
      http_code: 503,
    }));
    const { service } = makeService(cols, { dispatchOne });
    const result = await service.retryDlq(PROJECT, 'd1');
    expect(result.status).toBe('failed');
    expect(result.last_error).toBe('http_503');
  });

  it('blocks a concurrent retry of an already-retrying row', async () => {
    const cols = makeCollections();
    cols.dlq.findOne.mockResolvedValue({ ...dlqDoc, status: 'retrying' } as never);
    const { service } = makeService(cols);
    await expect(service.retryDlq(PROJECT, 'd1')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'RETRY_IN_PROGRESS' }),
    });
  });
});

describe('AutomationService v2 graph execution (TODO-040)', () => {
  const v2Rule = {
    id: 'r2',
    project_id: PROJECT,
    name: 'v2 rule',
    enabled: true,
    trigger_type: 'event',
    trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
    conditions_json: '[]',
    // v2: the flat list is intentionally empty — the graph is the source of truth.
    actions_json: '{}',
    engine_version: 2,
    graph_json: JSON.stringify({
      version: 1,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, config: { trigger_id: 'crm.deal.created' } },
        {
          id: 'c1',
          type: 'condition',
          position: { x: 0, y: 0 },
          config: { predicate: { op: 'gt', left: { ref: 'record.amount' }, right: { lit: 1000 } } },
        },
        { id: 'a1', type: 'action', position: { x: 0, y: 0 }, config: { action_id: 'create_activity', params: { title: 'call' } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'out', target: 'c1' },
        { id: 'e2', source: 'c1', sourceHandle: 'true', target: 'a1' },
      ],
    }),
  };

  it('executes the stored graph via dispatchOne instead of the flat actions_json', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({ ...v2Rule } as never);
    const dispatchOne = jest.fn(async (type: string) => ({
      index: 0,
      type,
      status: 'success',
      attempts: 1,
    }));
    const { service, disp } = makeService(cols, { dispatchOne });
    const result = await service.executeRule(
      PROJECT,
      'r2',
      'manual',
      JSON.stringify({ amount: 2000 }),
    );
    // Graph path was taken: the single reached action ran via dispatchOne, and
    // the flat dispatcher (which would see '{}' → skipped) was NOT used.
    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(dispatchOne.mock.calls[0][0]).toBe('create_activity');
    expect(disp.dispatch).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('does not reach the action when the graph condition fails', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({ ...v2Rule } as never);
    const dispatchOne = jest.fn();
    const { service } = makeService(cols, { dispatchOne });
    const result = await service.executeRule(
      PROJECT,
      'r2',
      'manual',
      JSON.stringify({ amount: 5 }),
    );
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
  });
});

/**
 * §3.8 IDOR: a run started from a GATEWAY request must execute under the
 * CALLER's visibility, never under the s2s `mode:'all'` actor.
 *
 * The hole this locks: `POST /api/v1/automation/integration/trigger`
 * (`automation.integration:invoke`, manager+) and `POST /automation/rules/:id/run`
 * (`automation:execute`, manager+) both take a client-supplied payload from which
 * the entity-generic executors resolve their target record. While they dispatched
 * with no actor, `buildServiceActorMetadata` substituted the system scope — so a
 * manager with `only_own` visibility could trigger a rule with `{deal_id: <foreign
 * deal>}` and have `assign_user` / `update_field` mutate it.
 */
describe('gateway-initiated runs carry the caller, not the system actor', () => {
  const eventRule = {
    id: 'r1',
    project_id: PROJECT,
    enabled: true,
    state: 'enabled',
    trigger_type: 'event',
    // Empty event name == matches ANY event (the widest possible trigger).
    trigger_config_json: JSON.stringify({ event_name: '' }),
    conditions_json: '',
    actions_json: JSON.stringify([{ type: 'assign_user', config: { user_id: 'attacker' } }]),
    created_at: 1,
    updated_at: 1,
  };
  const ok = { status: 'success', action_results: [] };
  const CALLER_SCOPE = JSON.stringify({ mode: 'restricted', level: 'only_own', selfId: 'u-att' });

  it('HookEvent forwards the caller id + scope into the dispatch (integration trigger)', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      sort: () => ({ toArray: async () => [eventRule] }),
      toArray: async () => [eventRule],
    } as never);
    cols.rules.findOne.mockResolvedValue(eventRule as never);
    const dispatch = jest.fn(async (_actionsJson: string, _ctx: Record<string, unknown>) => ok);
    const { service, disp } = makeService(cols, { dispatch });

    await service.hookEvent(
      PROJECT,
      'anything',
      'event_hook',
      JSON.stringify({ deal_id: 'foreign-deal' }),
      'u-att',
      CALLER_SCOPE,
    );

    expect(disp.dispatch).toHaveBeenCalledTimes(1);
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.actor).toBe('user');
    expect(ctx.userId).toBe('u-att');
    expect(ctx.visibilityScope).toBe(CALLER_SCOPE);
  });

  it('HookEvent WITHOUT a forwarded scope stays fail-closed (no system fallback)', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      sort: () => ({ toArray: async () => [eventRule] }),
      toArray: async () => [eventRule],
    } as never);
    cols.rules.findOne.mockResolvedValue(eventRule as never);
    const dispatch = jest.fn(async (_actionsJson: string, _ctx: Record<string, unknown>) => ok);
    const { service } = makeService(cols, { dispatch });

    await service.hookEvent(PROJECT, 'anything', 'event_hook', '{}');

    const ctx = dispatch.mock.calls[0][1];
    // actor:'user' + no scope ⇒ buildServiceActorMetadata sends NO scope header
    // ⇒ every domain read answers NOT_FOUND. Never `mode:'all'`.
    expect(ctx.actor).toBe('user');
    expect(ctx.visibilityScope).toBeFalsy();
  });

  it('ManualRun forwards the caller id + scope into the dispatch', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(eventRule as never);
    const dispatch = jest.fn(async (_actionsJson: string, _ctx: Record<string, unknown>) => ok);
    const { service } = makeService(cols, { dispatch });

    await service.manualRun(PROJECT, 'r1', 'deal', 'foreign-deal', 'u-att', CALLER_SCOPE);

    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.actor).toBe('user');
    expect(ctx.userId).toBe('u-att');
    expect(ctx.visibilityScope).toBe(CALLER_SCOPE);
  });
});

describe('cursor-automation wave regressions', () => {
  it('TODO-128: updateRule rejects enabled toggle on frozen rules', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      name: 'r',
      enabled: true,
      state: 'frozen',
      trigger_type: 'event',
      trigger_config_json: '{}',
      conditions_json: '[]',
      actions_json: '[]',
    });
    const { service } = makeService(cols);
    await expect(service.updateRule(PROJECT, 'r1', { enabled: false })).rejects.toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('заморожено') }),
    });
  });

  it('TODO-130: listConnections reports secret_set from stored secret_ref', async () => {
    const cols = makeCollections();
    const mongoConnections = {
      countDocuments: jest.fn(async () => 1),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              toArray: async () => [
                {
                  id: 'c1',
                  project_id: PROJECT,
                  name: 'n',
                  url: 'https://example.com/hook',
                  secret_ref: 'local:abc',
                  headers_json: '{}',
                  enabled: true,
                  breaker_state: 'closed',
                  breaker_failures: 0,
                  created_by: '',
                  created_at: 1,
                  updated_at: 1,
                },
              ],
            }),
          }),
        }),
      })),
    };
    const { service } = makeService(cols);
    (service as unknown as { mongo: { connections: () => typeof mongoConnections } }).mongo = {
      connections: () => mongoConnections,
      rules: () => cols.rules,
      dlq: () => cols.dlq,
      executions: () => ({
        insertOne: jest.fn(),
        updateOne: jest.fn(),
        countDocuments: jest.fn(),
        find: jest.fn(),
        aggregate: jest.fn(),
      }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    } as never;
    const res = await service.listConnections(PROJECT, 0, 25);
    expect(res.list[0].secret_set).toBe(true);
  });

  it('TODO-132 / FR-AUTOM-410: rule create enqueues automation.rule.created via outbox', async () => {
    const { service, outbox } = makeService();
    await service.createRule(PROJECT, {
      name: 'r',
      trigger_type: 'crm.deal.created',
      actions_json: '[]',
    });
    expect(outbox.withOutbox).toHaveBeenCalled();
    const work = (outbox.withOutbox as jest.Mock).mock.calls[0][0] as () => Promise<{
      intents: Array<{ type: string; projectId: string }>;
    }>;
    const captured = await work();
    expect(captured.intents[0]).toEqual(
      expect.objectContaining({
        type: 'automation.rule.created',
        projectId: PROJECT,
      }),
    );
  });

  it('TODO-135: executeRule ignores frozen rules (runnable filter)', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(null);
    const { service } = makeService(cols);
    await expect(
      service.executeRule(PROJECT, 'frozen-rule', 'manual', '{}'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Active rule not found' }),
    });
    expect(cols.rules.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT,
        id: 'frozen-rule',
        enabled: true,
        $and: expect.any(Array),
      }),
    );
  });

  it('TODO-136: listProjectExecutions filters by denormalized action_types', async () => {
    const cols = makeCollections();
    const execCol = {
      countDocuments: jest.fn(async () => 0),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ toArray: async () => [] }),
          }),
        }),
      })),
    };
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => ({ findOne: jest.fn(async () => ({ id: 'r1' })) }),
      dlq: () => cols.dlq,
      executions: () => execCol,
      connections: () => ({ findOne: jest.fn() }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    };
    await service.listProjectExecutions(PROJECT, 0, 25, undefined, 'send_webhook');
    expect(execCol.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT, action_types: 'send_webhook' }),
    );
  });

  it('TODO-340: listDlq returns status counts histogram', async () => {
    const cols = makeCollections();
    const dlqCol = {
      countDocuments: jest.fn(async () => 2),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ toArray: async () => [] }),
          }),
        }),
      })),
      aggregate: jest.fn(() => ({
        toArray: async () => [
          { _id: 'failed', count: 2 },
          { _id: 'resolved', count: 1 },
        ],
      })),
    };
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => cols.rules,
      dlq: () => dlqCol,
      executions: () => ({
        insertOne: jest.fn(),
        updateOne: jest.fn(),
        countDocuments: jest.fn(),
        find: jest.fn(),
        aggregate: jest.fn(),
      }),
      connections: () => ({ findOne: jest.fn() }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    };
    const res = await service.listDlq(PROJECT, 0, 25);
    expect(res.counts).toEqual({ failed: 2, resolved: 1 });
  });

  it('TODO-067: manualRun requires a user actor (no anonymous cross-domain read)', async () => {
    const { service, entitySnapshot } = makeService();
    await expect(service.manualRun(PROJECT, 'r1', 'deal', 'd1', '')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'userId is required' }),
    });
    expect(entitySnapshot.fetchRecord).not.toHaveBeenCalled();
  });

  it('TODO-067: manualRun executes on the fetched entity snapshot, not a synthetic ref', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      name: 'r',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: '{}',
      conditions_json: '[]',
      actions_json: '[]',
    } as never);
    const dispatch = jest.fn(async (_actions: string, _ctx: unknown) => ({
      status: 'success',
      action_results: [] as unknown[],
    }));
    const { service, entitySnapshot } = makeService(cols, { dispatch });
    const res = await service.manualRun(PROJECT, 'r1', 'deal', 'd1', 'u1');
    expect(entitySnapshot.fetchRecord).toHaveBeenCalledWith(
      PROJECT,
      'deal',
      'd1',
      'u1',
      undefined,
    );
    const ctx = dispatch.mock.calls[0][1] as { payload: Record<string, unknown> };
    expect(ctx.payload).toMatchObject({ entity_type: 'deal', entity_id: 'd1', amount: 1 });
    expect(res.entity_type).toBe('deal');
    expect(res.entity_id).toBe('d1');
  });

  it('TODO-067: manualRun maps an out-of-scope entity to NOT_FOUND', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      name: 'r',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: '{}',
      conditions_json: '[]',
      actions_json: '[]',
    } as never);
    const { service, entitySnapshot } = makeService(cols);
    entitySnapshot.fetchRecord.mockRejectedValue(
      Object.assign(new Error('Entity not found'), { code: 5 }),
    );
    await expect(service.manualRun(PROJECT, 'r1', 'deal', 'd-alien', 'u1')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Entity not found' }),
    });
  });

  it('TODO-137: listRules state=enabled matches legacy rows without state field', async () => {
    const rulesCol = {
      countDocuments: jest.fn(async () => 0),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ toArray: async () => [] }),
          }),
        }),
      })),
    };
    const cols = makeCollections();
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => rulesCol,
      dlq: () => cols.dlq,
      executions: () => ({
        insertOne: jest.fn(),
        updateOne: jest.fn(),
        countDocuments: jest.fn(async () => 0),
        find: jest.fn(() => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({ toArray: async () => [] }),
            }),
          }),
        })),
        aggregate: jest.fn(() => ({ toArray: async () => [] })),
      }),
      connections: () => ({ findOne: jest.fn() }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    };
    await service.listRules(PROJECT, 0, 25, undefined, false, 'enabled');
    expect(rulesCol.countDocuments).toHaveBeenCalledWith({
      $and: [
        { project_id: PROJECT },
        { $or: [{ deleted_at: { $exists: false } }, { deleted_at: 0 }] },
        { $or: [{ state: 'enabled' }, { state: { $exists: false }, enabled: true }] },
      ],
    });
  });

  it('FR-AUTOM-260: owner may disable own rule without manage', async () => {
    const cols = makeCollections();
    const rule = {
      id: 'r1',
      project_id: PROJECT,
      name: 'mine',
      created_by: 'u1',
      enabled: true,
      state: 'enabled',
      actions_json: '[]',
      trigger_type: 'event',
      trigger_config_json: '{}',
      conditions_json: '[]',
    };
    cols.rules.findOne.mockResolvedValueOnce(rule).mockResolvedValueOnce({
      ...rule,
      enabled: false,
      state: 'disabled',
    });
    cols.rules.updateOne.mockResolvedValue({});
    const { service } = makeService(cols);
    await service.setRuleEnabled(PROJECT, 'r1', false, 'u1', false);
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'r1' },
      expect.objectContaining({ $set: expect.objectContaining({ enabled: false }) }),
    );
  });

  it('FR-AUTOM-260: external-effect enable requires manage even for author', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      created_by: 'u1',
      enabled: false,
      state: 'disabled',
      actions_json: JSON.stringify([{ type: 'send_webhook' }]),
    });
    const { service } = makeService(cols);
    await expect(service.setRuleEnabled(PROJECT, 'r1', true, 'u1', false)).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'EXTERNAL_EFFECT_REQUIRES_MANAGE' }),
    });
  });

  it('FR-AUTOM-530: toExecution maps graph_path_json', async () => {
    const cols = makeCollections();
    const execCol = {
      countDocuments: jest.fn(async () => 1),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              toArray: async () => [
                {
                  execution_id: 'e1',
                  rule_id: 'r1',
                  project_id: PROJECT,
                  status: 'success',
                  source: 'event',
                  graph_path_json: JSON.stringify(['t1', 'a1']),
                  created_at: 1,
                },
              ],
            }),
          }),
        }),
      })),
    };
    cols.rules.findOne.mockResolvedValue({ id: 'r1' });
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => cols.rules,
      dlq: () => cols.dlq,
      executions: () => execCol,
      connections: () => ({ findOne: jest.fn() }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    };
    const res = await service.listExecutions(PROJECT, 'r1', 0, 25);
    expect(res.list[0].graph_path_json).toBe(JSON.stringify(['t1', 'a1']));
  });
});

describe('FR-AUTOM-010 lazy migrate on the live path', () => {
  const legacyRule = {
    id: 'legacy-1',
    project_id: PROJECT,
    name: 'old',
    enabled: true,
    state: 'enabled',
    trigger_type: 'crm.deal.created',
    trigger_config_json: '{}',
    conditions_json: JSON.stringify({ op: 'and', args: [{ field: 'x', op: 'ne', value: 1 }] }),
    actions_json: JSON.stringify([{ type: 'create_activity', config: { title: 't' } }]),
    created_by: 'author-1',
    stats_json: '{}',
  };

  it('consumeEvent finds a catalog-id trigger and persists the canonical patch', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      sort: () => ({ toArray: async () => [legacyRule] }),
      toArray: async () => [legacyRule],
    } as never);
    const dispatch = jest.fn(async () => ({ status: 'success', action_results: [] }));
    const { service } = makeService(cols, { dispatch });
    await service.consumeEvent({
      type: 'crm.deal.created',
      version: 1,
      messageId: 'm1',
      timestamp: new Date().toISOString(),
      source: 'pipe',
      projectId: PROJECT,
      payload: { deal_id: 'd1' },
    });
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'legacy-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          trigger_type: 'event',
          trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
          conditions_json: JSON.stringify({ and: [{ field: 'x', op: 'neq', value: 1 }] }),
        }),
      }),
    );
    expect(dispatch).toHaveBeenCalled();
  });

  it('getRule migrates before returning (form must not wipe legacy conditions)', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(legacyRule as never);
    const { service } = makeService(cols);
    const rule = await service.getRule(PROJECT, 'legacy-1');
    expect(rule.trigger_type).toBe('event');
    expect(JSON.parse(rule.trigger_config_json)).toMatchObject({ event_name: 'crm.deal.created' });
    expect(JSON.parse(rule.conditions_json)).toEqual({
      and: [{ field: 'x', op: 'neq', value: 1 }],
    });
  });
});

describe('FR-AUTOM-290 module_disabled writes skipped executions', () => {
  it('HookEvent journals execution{skipped,module_disabled} for matched rules', async () => {
    const cols = makeCollections();
    const rule = {
      id: 'r1',
      project_id: PROJECT,
      name: 'A',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '{}',
      actions_json: '[]',
    };
    cols.rules.find.mockReturnValue({
      sort: () => ({ toArray: async () => [rule] }),
      toArray: async () => [rule],
    } as never);
    const { service, gate } = makeService(cols);
    gate.isAutomationRuntimeActive.mockResolvedValue(false);
    const res = await service.hookEvent(PROJECT, 'crm.deal.created', 'event_hook', '{}');
    expect(res).toMatchObject({
      accepted: false,
      reason: 'module_disabled',
      matched_rules: 1,
    });
    expect(res.executions).toHaveLength(1);
    expect(res.executions[0]).toMatchObject({
      status: 'skipped',
      skip_reason: 'module_disabled',
      rule_id: 'r1',
    });
  });
});

describe('AutomationService lifecycle and admin RPCs', () => {
  it('deleteRule soft-deletes an existing rule and emits outbox intent', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      name: 'r',
      enabled: true,
      state: 'enabled',
    });
    cols.rules.updateOne.mockResolvedValue({ matchedCount: 1 });
    const { service, outbox } = makeService(cols);
    await expect(service.deleteRule(PROJECT, 'r1')).resolves.toEqual({});
    expect(outbox.withOutbox).toHaveBeenCalled();
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT, id: 'r1' }),
      expect.objectContaining({ $set: expect.objectContaining({ state: 'deleted', enabled: false }) }),
      expect.anything(),
    );
  });

  it('deleteRule rejects a missing rule with NOT_FOUND', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(null);
    const { service } = makeService(cols);
    await expect(service.deleteRule(PROJECT, 'missing')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Rule not found' }),
    });
  });

  it('restoreRule clears deleted_at and returns the migrated rule', async () => {
    const cols = makeCollections();
    const deleted = {
      id: 'r1',
      project_id: PROJECT,
      name: 'r',
      enabled: true,
      deleted_at: Date.now(),
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '[]',
      actions_json: '[]',
    };
    cols.rules.findOne
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce({ ...deleted, deleted_at: undefined, state: 'enabled' });
    cols.rules.updateOne.mockResolvedValue({ matchedCount: 1 });
    const { service } = makeService(cols);
    const rule = await service.restoreRule(PROJECT, 'r1');
    expect(rule.state).toBe('enabled');
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'r1' },
      expect.objectContaining({ $unset: { deleted_at: '' } }),
    );
  });

  it('restoreRule rejects when the rule is not soft-deleted', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({ id: 'r1', project_id: PROJECT, name: 'r' });
    const { service } = makeService(cols);
    await expect(service.restoreRule(PROJECT, 'r1')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Deleted rule not found' }),
    });
  });

  it('listExecutions rejects an unknown rule id', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(null);
    const { service } = makeService(cols);
    await expect(service.listExecutions(PROJECT, 'missing', 0, 25)).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Rule not found' }),
    });
  });

  it('listProjectExecutions rejects inverted time range', async () => {
    const { service } = makeService();
    await expect(service.listProjectExecutions(PROJECT, 0, 25, undefined, undefined, 200, 100)).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'from must be <= to' }),
    });
  });

  it('dryRun rejects sample_json and last_n together', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '[]',
      actions_json: '[]',
    });
    const { service } = makeService(cols);
    await expect(service.dryRun(PROJECT, 'r1', '{"a":1}', 5)).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'sample and lastN are mutually exclusive' }),
    });
  });

  it('dryRun evaluates conditions against a sample payload without dispatching', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: JSON.stringify({ and: [{ field: 'amount', op: 'gt', value: 10 }] }),
      actions_json: JSON.stringify([{ type: 'create_activity', config: { title: 't' } }]),
    });
    const { service, disp } = makeService(cols);
    const res = await service.dryRun(PROJECT, 'r1', JSON.stringify({ amount: 20 }), 0);
    expect(res.results[0]).toMatchObject({
      matched: true,
      conditions_passed: true,
      dry_run: true,
    });
    expect(disp.dispatch).not.toHaveBeenCalled();
  });

  it('validateGraph returns NO_NODES for an empty graph', () => {
    const { service } = makeService();
    const res = service.validateGraph(PROJECT, null, true, []);
    expect(res.valid).toBe(false);
    expect(res.issues[0]).toMatchObject({ code: 'NO_NODES', severity: 'error' });
  });

  it('getNodeRegistry hides nodes for disabled modules', () => {
    const { service } = makeService();
    const all = service.getNodeRegistry(PROJECT, []);
    const filtered = service.getNodeRegistry(PROJECT, ['deals']);
    expect(filtered.triggers.length).toBeLessThan(all.triggers.length);
    expect(filtered.triggers.every((t) => t.required_module === 'deals')).toBe(true);
    expect(filtered.actions.every((a) => a.required_module === 'deals')).toBe(true);
  });

  it('createConnection rejects private webhook targets (anti-SSRF)', async () => {
    const connections = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(),
    };
    const cols = makeCollections();
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => cols.rules,
      dlq: () => cols.dlq,
      executions: () => ({ insertOne: jest.fn(), updateOne: jest.fn(), countDocuments: jest.fn(), find: jest.fn(), aggregate: jest.fn() }),
      connections: () => connections,
      eventHooks: () => ({ insertOne: jest.fn(), find: jest.fn() }),
    };
    await expect(
      service.createConnection(PROJECT, { name: 'n', url: 'http://127.0.0.1/hook' }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'WEBHOOK_TARGET_INVALID' }),
    });
    expect(connections.insertOne).not.toHaveBeenCalled();
  });

  it('deleteConnection blocks when a rule still references the connection', async () => {
    const connections = {
      findOne: jest.fn(async () => ({ id: 'c1', project_id: PROJECT })),
      deleteOne: jest.fn(),
    };
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      toArray: async () => [
        {
          id: 'r1',
          project_id: PROJECT,
          actions_json: JSON.stringify([{ type: 'send_webhook', connectionId: 'c1' }]),
        },
      ],
    } as never);
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => cols.rules,
      dlq: () => cols.dlq,
      executions: () => ({ insertOne: jest.fn(), updateOne: jest.fn(), countDocuments: jest.fn(), find: jest.fn(), aggregate: jest.fn() }),
      connections: () => connections,
      eventHooks: () => ({ insertOne: jest.fn(), find: jest.fn() }),
    };
    await expect(service.deleteConnection(PROJECT, 'c1')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'CONNECTION_IN_USE' }),
    });
    expect(connections.deleteOne).not.toHaveBeenCalled();
  });

  it('dismissDlq marks a pending row as dismissed', async () => {
    const cols = makeCollections();
    cols.dlq.findOne.mockResolvedValue({
      id: 'd1',
      project_id: PROJECT,
      status: 'failed',
      last_error: 'timeout',
      created_at: 1,
      updated_at: 1,
    });
    cols.dlq.updateOne.mockResolvedValue({ matchedCount: 1 });
    const { service } = makeService(cols);
    const row = await service.dismissDlq(PROJECT, 'd1', 'operator dismissed');
    expect(row.status).toBe('dismissed');
    expect(cols.dlq.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'd1' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'dismissed' }) }),
    );
  });

  it('dismissDlq rejects already resolved rows', async () => {
    const cols = makeCollections();
    cols.dlq.findOne.mockResolvedValue({
      id: 'd1',
      project_id: PROJECT,
      status: 'resolved',
      created_at: 1,
      updated_at: 1,
    });
    const { service } = makeService(cols);
    await expect(service.dismissDlq(PROJECT, 'd1', 'late')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'Already processed' }),
    });
  });

  it('freezeRules pauses in-flight DLQ rows for module disable', async () => {
    const cols = makeCollections();
    cols.rules.updateMany = jest.fn(async () => ({ modifiedCount: 2 }));
    cols.dlq.updateMany = jest.fn(async () => ({ modifiedCount: 3 }));
    const { service } = makeService(cols);
    const res = await service.freezeRules(PROJECT, 'module_disabled');
    expect(res).toEqual({ frozen_rules: 4, paused_dlq: 3 });
    expect(cols.dlq.updateMany).toHaveBeenCalledWith(
      { project_id: PROJECT, status: { $in: ['retrying', 'failed'] } },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'paused_module_disabled' }) }),
    );
  });

  it('freezeRules rejects unknown reason codes', async () => {
    const { service } = makeService();
    await expect(service.freezeRules(PROJECT, 'billing')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'unknown reason' }),
    });
  });

  it('unfreezeRules restores enabled frozen rules to enabled state', async () => {
    const cols = makeCollections();
    cols.rules.updateMany = jest
      .fn()
      .mockResolvedValueOnce({ modifiedCount: 4 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const { service } = makeService(cols);
    const res = await service.unfreezeRules(PROJECT, 'module_enabled');
    expect(res.unfrozen_rules).toBe(4);
    expect(cols.rules.updateMany).toHaveBeenCalledWith(
      { project_id: PROJECT, state: 'frozen', enabled: true },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'enabled' }) }),
    );
  });

  it('disableRulesForInactiveActor disables author rules and notifies operator', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      toArray: async () => [
        {
          id: 'r1',
          project_id: PROJECT,
          name: 'Mine',
          created_by: 'u-off',
          notify_on_failure: 'u-admin',
        },
      ],
    } as never);
    cols.rules.updateMany = jest.fn(async () => ({ modifiedCount: 1 }));
    const { service, operatorNotify } = makeService(cols);
    const res = await service.disableRulesForInactiveActor(PROJECT, 'u-off');
    expect(res.disabled_rules).toBe(1);
    expect(operatorNotify.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-admin',
        projectId: PROJECT,
      }),
    );
  });

  it('disableRulesForInactiveActor requires actor_user_id', async () => {
    const { service } = makeService();
    await expect(service.disableRulesForInactiveActor(PROJECT, '  ')).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'actor_user_id required' }),
    });
  });

  it('reconcileRuleDependencies marks rules unexecutable when modules are missing', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      toArray: async () => [
        {
          id: 'r1',
          project_id: PROJECT,
          state: 'enabled',
          enabled: true,
          trigger_type: 'event',
          trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
          actions_json: JSON.stringify([{ type: 'create_activity', config: {} }]),
          unexecutable: false,
        },
      ],
    } as never);
    cols.rules.updateOne.mockResolvedValue({ matchedCount: 1 });
    const { service } = makeService(cols);
    const res = await service.reconcileRuleDependencies(PROJECT, ['contacts']);
    expect(res.updated_rules).toBe(1);
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      { project_id: PROJECT, id: 'r1' },
      expect.objectContaining({ $set: expect.objectContaining({ unexecutable: true, state: 'unexecutable' }) }),
    );
  });

  it('reclaimStaleRunning closes executions whose rule was deleted', async () => {
    const execCol = {
      find: jest.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [
              {
                execution_id: 'e-stale',
                project_id: PROJECT,
                rule_id: 'gone',
                payload_json: '{}',
              },
            ],
          }),
        }),
      })),
      updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    };
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue(null);
    const { service } = makeService(cols);
    (service as unknown as { mongo: Record<string, unknown> }).mongo = {
      rules: () => cols.rules,
      dlq: () => cols.dlq,
      executions: () => execCol,
      connections: () => ({ findOne: jest.fn() }),
      eventHooks: () => ({ insertOne: jest.fn() }),
    };
    await expect(service.reclaimStaleRunning(60_000)).resolves.toBe(1);
    expect(execCol.updateOne).toHaveBeenCalledWith(
      { execution_id: 'e-stale', status: 'running' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'failed', error: 'rule_deleted' }) }),
    );
  });
});
