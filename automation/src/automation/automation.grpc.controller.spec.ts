import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GW_METADATA } from '@fairflow/shared';
import { AutomationGrpcController } from './automation.grpc.controller';

const PID = 'proj-1';

function metadata(opts: {
  projectId?: string;
  userId?: string;
  visibilityScope?: string;
  actorType?: string;
} = {}): Metadata {
  const m = new Metadata();
  if (opts.projectId) m.set(GW_METADATA.PROJECT_ID, opts.projectId);
  if (opts.userId) m.set(GW_METADATA.USER_ID, opts.userId);
  if (opts.visibilityScope) m.set(GW_METADATA.VISIBILITY_SCOPE, opts.visibilityScope);
  if (opts.actorType) m.set(GW_METADATA.ACTOR_TYPE, opts.actorType);
  return m;
}

function stubAutomation() {
  return {
    listRules: jest.fn(async () => ({ list: [], total: 0 })),
    getRule: jest.fn(async () => ({ id: 'r1' })),
    createRule: jest.fn(async () => ({ id: 'r-new' })),
    updateRule: jest.fn(async () => ({ id: 'r1' })),
    deleteRule: jest.fn(async () => ({})),
    restoreRule: jest.fn(async () => ({ id: 'r1' })),
    executeRule: jest.fn(async () => ({ execution_id: 'e1' })),
    hookEvent: jest.fn(async () => ({ matched_rules: 0, executions: [] })),
    manualRun: jest.fn(async () => ({ execution_id: 'e2' })),
    dryRun: jest.fn(async () => ({ ok: true })),
    listExecutions: jest.fn(async () => ({ list: [], total: 0 })),
    listProjectExecutions: jest.fn(async () => ({ list: [], total: 0 })),
    getRegistry: jest.fn(async () => ({ triggers: [], actions: [] })),
    validateGraph: jest.fn(async () => ({ valid: true, issues: [] })),
    getNodeRegistry: jest.fn(async () => ({ nodes: [] })),
    listConnections: jest.fn(async () => ({ list: [], total: 0 })),
    getConnection: jest.fn(async () => ({ id: 'c1' })),
    createConnection: jest.fn(async () => ({ id: 'c1' })),
    updateConnection: jest.fn(async () => ({ id: 'c1' })),
    deleteConnection: jest.fn(async () => ({})),
    listDlq: jest.fn(async () => ({ list: [], total: 0, counts: {} })),
    retryDlq: jest.fn(async () => ({ id: 'd1' })),
    dismissDlq: jest.fn(async () => ({ id: 'd1' })),
    setRuleEnabled: jest.fn(async () => ({ ok: true })),
    freezeRules: jest.fn(async () => ({ frozen: 1 })),
    unfreezeRules: jest.fn(async () => ({ unfrozen: 1 })),
    disableRulesForInactiveActor: jest.fn(async () => ({ disabled_rules: 2 })),
    resumePausedDlq: jest.fn(async () => ({ processed: 0 })),
    reconcileRuleDependencies: jest.fn(async () => ({ updated_rules: 0 })),
  };
}

describe('AutomationGrpcController — field mapping', () => {
  it('ListRules maps snake_case request fields and trusted project id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.listRules(
      {
        project_id: PID,
        page_index: 2,
        page_size: 50,
        query: 'deal',
        enabled_only: true,
        state: 'active',
        trigger_type: 'event',
        created_by: 'u1',
        engine_version: 2,
      },
      metadata({ projectId: PID }),
    );
    expect(automation.listRules).toHaveBeenCalledWith(
      PID,
      2,
      50,
      'deal',
      true,
      'active',
      'event',
      'u1',
      2,
    );
  });

  it('ExecuteRule forwards caller userId and visibility scope', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const md = metadata({ projectId: PID, userId: 'u-7', visibilityScope: '{"dept":"d1"}' });
    await ctrl.executeRule(
      { projectId: PID, ruleId: 'r1', source: 'manual', payload_json: '{"x":1}' },
      md,
    );
    expect(automation.executeRule).toHaveBeenCalledWith(
      PID,
      'r1',
      'manual',
      '{"x":1}',
      'u-7',
      '{"dept":"d1"}',
    );
  });

  it('HookEvent forwards caller context for IDOR-safe execution', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const md = metadata({ projectId: PID, userId: 'u-2', visibilityScope: 'scope-json' });
    await ctrl.hookEvent(
      { project_id: PID, event_name: 'crm.deal.won', payload_json: '{}' },
      md,
    );
    expect(automation.hookEvent).toHaveBeenCalledWith(
      PID,
      'crm.deal.won',
      'event_hook',
      '{}',
      'u-2',
      'scope-json',
    );
  });

  it('ManualRun passes metadata through to the service', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const md = metadata({ projectId: PID, userId: 'u-3', visibilityScope: 's1' });
    await ctrl.manualRun(
      { projectId: PID, ruleId: 'r9', entityType: 'deal', entityId: 'd1' },
      md,
    );
    expect(automation.manualRun).toHaveBeenCalledWith(
      PID,
      'r9',
      'deal',
      'd1',
      'u-3',
      's1',
      md,
    );
  });

  it('SetRuleEnabled maps camelCase permission flag', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.setRuleEnabled(
      { projectId: PID, ruleId: 'r1', enabled: false, canManage: true },
      metadata({ projectId: PID, userId: 'u-admin' }),
    );
    expect(automation.setRuleEnabled).toHaveBeenCalledWith(PID, 'r1', false, 'u-admin', true);
  });

  it('rejects conflicting body projectId when metadata carries x-project-id', () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    expect(() =>
      ctrl.getRule({ project_id: 'other', rule_id: 'r1' }, metadata({ projectId: PID })),
    ).toThrow(RpcException);
    expect(automation.getRule).not.toHaveBeenCalled();
  });

  it('DryRun maps snake_case wire fields to the service', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.dryRun(
      { project_id: PID, rule_id: 'r1', sample_json: '{"a":1}', last_n: 5 },
      metadata({ projectId: PID }),
    );
    expect(automation.dryRun).toHaveBeenCalledWith(PID, 'r1', '{"a":1}', 5);
  });

  it('ListExecutions maps pagination and filter fields', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.listExecutions(
      { project_id: PID, rule_id: 'r1', page_index: 1, page_size: 20, status: 'success' },
      metadata({ projectId: PID }),
    );
    expect(automation.listExecutions).toHaveBeenCalledWith(PID, 'r1', 1, 20, 'success');
  });

  it('CreateRule forwards body and trusted project id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const body = { project_id: PID, name: 'rule-a', trigger_type: 'event' };
    await ctrl.createRule(body, metadata({ projectId: PID }));
    expect(automation.createRule).toHaveBeenCalledWith(PID, body);
  });

  it('UpdateRule maps snake_case rule id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const body = { project_id: PID, rule_id: 'r1', name: 'updated' };
    await ctrl.updateRule(body, metadata({ projectId: PID }));
    expect(automation.updateRule).toHaveBeenCalledWith(PID, 'r1', body);
  });

  it('DeleteRule maps camelCase rule id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.deleteRule({ projectId: PID, ruleId: 'r-del' }, metadata({ projectId: PID }));
    expect(automation.deleteRule).toHaveBeenCalledWith(PID, 'r-del');
  });

  it('RestoreRule maps snake_case rule id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.restoreRule({ project_id: PID, rule_id: 'r1' }, metadata({ projectId: PID }));
    expect(automation.restoreRule).toHaveBeenCalledWith(PID, 'r1');
  });

  it('ListProjectExecutions maps filter fields', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.listProjectExecutions(
      {
        project_id: PID,
        page_index: 0,
        page_size: 10,
        status: 'success,failed',
        action_type: 'send_webhook',
        from: 100,
        to: 200,
        rule_id: 'r1',
        entity_type: 'deal',
        entity_id: 'd1',
      },
      metadata({ projectId: PID }),
    );
    expect(automation.listProjectExecutions).toHaveBeenCalledWith(
      PID,
      0,
      10,
      'success,failed',
      'send_webhook',
      100,
      200,
      'r1',
      'deal',
      'd1',
    );
  });

  it('GetRegistry passes enabled_modules from snake_case wire', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.getRegistry({ project_id: PID, enabled_modules: ['deals'] }, metadata({ projectId: PID }));
    expect(automation.getRegistry).toHaveBeenCalledWith(PID, ['deals']);
  });

  it('ValidateGraph maps graph and permission flags', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    const graph = { version: 2, nodes: [], edges: [] };
    await ctrl.validateGraph({
      project_id: PID,
      graph,
      can_manage: true,
      enabled_modules: ['deals'],
    });
    expect(automation.validateGraph).toHaveBeenCalledWith(
      PID,
      expect.objectContaining({ version: 2 }),
      true,
      ['deals'],
    );
  });

  it('ListConnections maps pagination defaults', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.listConnections({ projectId: PID }, metadata({ projectId: PID }));
    expect(automation.listConnections).toHaveBeenCalledWith(PID, 0, 25);
  });

  it('DismissDlq maps dlq id and reason', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.dismissDlq(
      { project_id: PID, dlq_id: 'd1', reason: 'noise' },
      metadata({ projectId: PID }),
    );
    expect(automation.dismissDlq).toHaveBeenCalledWith(PID, 'd1', 'noise');
  });
});

describe('AutomationGrpcController — service-only RPCs', () => {
  it('FreezeRules rejects end-user propagation', () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    expect(() =>
      ctrl.freezeRules({ projectId: PID, reason: 'billing' }, metadata({ projectId: PID, userId: 'u1' })),
    ).toThrow(RpcException);
    expect(automation.freezeRules).not.toHaveBeenCalled();
  });

  it('DisableRulesForInactiveActor allows service actor without user id', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.disableRulesForInactiveActor(
      { projectId: PID, actorUserId: 'u-off' },
      metadata({ projectId: PID, actorType: 'service' }),
    );
    expect(automation.disableRulesForInactiveActor).toHaveBeenCalledWith(PID, 'u-off');
  });

  it('ResumePausedDlq defaults dlq fate to discard', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.resumePausedDlq({ projectId: PID }, metadata({ projectId: PID, actorType: 'service' }));
    expect(automation.resumePausedDlq).toHaveBeenCalledWith(PID, 'discard');
  });

  it('ResumePausedDlq accepts deliver fate', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.resumePausedDlq(
      { projectId: PID, dlq_fate: 'deliver' },
      metadata({ projectId: PID, actorType: 'service' }),
    );
    expect(automation.resumePausedDlq).toHaveBeenCalledWith(PID, 'deliver');
  });

  it('ReconcileRuleDependencies passes enabled module list', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.reconcileRuleDependencies(
      { projectId: PID, enabledModules: ['deals', 'contacts'] },
      metadata({ projectId: PID, actorType: 'service' }),
    );
    expect(automation.reconcileRuleDependencies).toHaveBeenCalledWith(PID, ['deals', 'contacts']);
  });

  it('UnfreezeRules rejects end-user propagation', () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    expect(() =>
      ctrl.unfreezeRules({ projectId: PID, reason: 'module_enabled' }, metadata({ projectId: PID, userId: 'u1' })),
    ).toThrow(RpcException);
    expect(automation.unfreezeRules).not.toHaveBeenCalled();
  });

  it('RetryDlq maps connection id aliases', async () => {
    const automation = stubAutomation();
    const ctrl = new AutomationGrpcController(automation as never);
    await ctrl.retryDlq({ project_id: PID, dlqId: 'd1' }, metadata({ projectId: PID }));
    expect(automation.retryDlq).toHaveBeenCalledWith(PID, 'd1');
  });
});
