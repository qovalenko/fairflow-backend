import { RpcException } from '@nestjs/microservices';
import { AutomationService } from './automation.service';

function makeCollections() {
  return {
    rules: {
      insertOne: jest.fn(async () => ({})),
      findOne: jest.fn(async () => null),
      find: jest.fn(() => ({ toArray: async () => [] as unknown[] })),
      updateOne: jest.fn(async () => ({ matchedCount: 1 })),
      updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
      deleteOne: jest.fn(),
    },
    executions: {
      insertOne: jest.fn(async () => ({})),
      updateOne: jest.fn(),
      countDocuments: jest.fn(async () => 0),
    },
    dlq: { findOne: jest.fn(), updateOne: jest.fn() },
    eventHooks: { insertOne: jest.fn() },
    connections: { findOne: jest.fn() },
  };
}

function makeService(cols = makeCollections()) {
  const throttle = { isThrottled: jest.fn(async () => false) };
  const operatorNotify = { notify: jest.fn(async () => true) };
  const outbox = {
    withOutbox: jest.fn(async (work: (session?: unknown) => Promise<{ result: unknown; intents?: unknown[] }>) => {
      const captured = await work(undefined);
      return captured.result;
    }),
  };
  const service = new AutomationService(
    {
      rules: () => cols.rules,
      executions: () => cols.executions,
      dlq: () => cols.dlq,
      eventHooks: () => cols.eventHooks,
      connections: () => cols.connections,
    } as never,
    { publishEnvelope: jest.fn() } as never,
    { isAutomationRuntimeActive: jest.fn(async () => true) } as never,
    { dispatch: jest.fn(), dispatchOne: jest.fn() } as never,
    { sealer: jest.fn(), reveal: jest.fn() } as never,
    { forAction: () => null } as never,
    { retryDlq: jest.fn() } as never,
    { fetchRecord: jest.fn() } as never,
    throttle as never,
    operatorNotify as never,
    outbox as never,
  );
  return { service, cols, throttle };
}

const PROJECT = 'p1';

describe('AutomationService REAL-GAP-M', () => {
  it('FR-AUTOM-055: rejects flat rule when dependency module disabled', async () => {
    const { service } = makeService();
    await expect(
      service.createRule(PROJECT, {
        name: 'x',
        trigger_type: 'crm.deal.created',
        trigger_config_json: '{}',
        actions_json: '[]',
        enabled_modules: ['automation'],
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('FR-AUTOM-325: deleteRule soft-deletes', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      name: 'x',
      state: 'enabled',
      enabled: true,
    });
    cols.rules.updateOne.mockResolvedValue({ matchedCount: 1 });
    const { service } = makeService(cols);
    await service.deleteRule(PROJECT, 'r1');
    expect(cols.rules.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT, id: 'r1' }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'deleted' }),
      }),
      expect.anything(),
    );
    expect(cols.rules.deleteOne).not.toHaveBeenCalled();
  });

  it('FR-AUTOM-325: setRuleEnabled refuses a soft-deleted rule', async () => {
    const cols = makeCollections();
    cols.rules.findOne.mockResolvedValue({
      id: 'r1',
      project_id: PROJECT,
      created_by: 'u1',
      state: 'deleted',
      deleted_at: 1,
      enabled: false,
    });
    const { service } = makeService(cols);
    await expect(service.setRuleEnabled(PROJECT, 'r1', true, 'u1', true)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(cols.rules.updateOne).not.toHaveBeenCalled();
  });

  it('FR-AUTOM-105: disableRulesForInactiveActor updates rules and emits', async () => {
    const cols = makeCollections();
    cols.rules.find.mockReturnValue({
      toArray: async () => [{ id: 'r1', name: 'A', created_by: 'u1', notify_on_failure: 'u2' }],
    });
    const { service } = makeService(cols);
    const res = await service.disableRulesForInactiveActor(PROJECT, 'u1');
    expect(res.disabled_rules).toBe(1);
    expect(cols.rules.updateMany).toHaveBeenCalled();
  });
});
