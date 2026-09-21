import { GW_METADATA, RequireModule, readGatewayMetadata, readUserId, resolveProjectId } from '@fairflow/shared';
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { AutomationService } from './automation.service';
import { graphFromWire } from './graph/graph-mapper';

// Trusted x-project-id metadata wins over the body; a conflicting body projectId
// is rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
function projectId(data: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, data.project_id ?? data.projectId);
}

function ruleId(data: { rule_id?: string; ruleId?: string }): string {
  return data.rule_id ?? data.ruleId ?? '';
}

function connectionId(data: { connection_id?: string; connectionId?: string }): string {
  return data.connection_id ?? data.connectionId ?? '';
}

function dlqId(data: { dlq_id?: string; dlqId?: string }): string {
  return data.dlq_id ?? data.dlqId ?? '';
}

/**
 * The caller's own serialized visibility scope, forwarded VERBATIM to the
 * executor domains on every user-initiated run (ExecuteRule / HookEvent /
 * ManualRun). Never widened here: all three carry a client-supplied payload from
 * which the entity-generic executors resolve their target, so the rule must not
 * reach records the caller cannot reach directly (§3.8 IDOR). Only the bus
 * consumer — which has no caller at all — runs with the s2s scope.
 */
function visibilityScope(metadata?: Metadata): string {
  const raw = metadata?.get(GW_METADATA.VISIBILITY_SCOPE)?.[0];
  return typeof raw === 'string' ? raw : '';
}

/** Internal RPCs (control → automation): reject end-user propagation (§3.22/3.23). */
function assertServiceOnly(metadata?: Metadata): void {
  if (readUserId(metadata)) {
    throw new RpcException({ code: status.PERMISSION_DENIED, message: 'SERVICE_ONLY_RPC' });
  }
  const actor = readGatewayMetadata(metadata, GW_METADATA.ACTOR_TYPE).trim();
  if (actor && actor !== 'service') {
    throw new RpcException({ code: status.PERMISSION_DENIED, message: 'SERVICE_ONLY_RPC' });
  }
}

@Controller()
@RequireModule('automation')
export class AutomationGrpcController {
  constructor(private readonly automation: AutomationService) {}

  @GrpcMethod('AutomationGrpc', 'ListRules')
  listRules(data: {
    project_id?: string;
    projectId?: string;
    page_index?: number;
    page_size?: number;
    query?: string;
    enabled_only?: boolean;
    state?: string;
    trigger_type?: string;
    created_by?: string;
    engine_version?: number;
  }, metadata?: Metadata) {
    return this.automation.listRules(
      projectId(data, metadata),
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.query,
      data.enabled_only ?? false,
      data.state,
      data.trigger_type,
      data.created_by,
      data.engine_version,
    );
  }

  @GrpcMethod('AutomationGrpc', 'GetRule')
  getRule(data: { project_id?: string; projectId?: string; rule_id?: string; ruleId?: string }, metadata?: Metadata) {
    return this.automation.getRule(projectId(data, metadata), data.rule_id ?? data.ruleId ?? '');
  }

  @GrpcMethod('AutomationGrpc', 'CreateRule')
  createRule(data: Record<string, unknown> & { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.automation.createRule(projectId(data, metadata), data);
  }

  @GrpcMethod('AutomationGrpc', 'UpdateRule')
  updateRule(
    data: Record<string, unknown> & {
      project_id?: string;
      projectId?: string;
      rule_id?: string;
      ruleId?: string;
    },
    metadata?: Metadata,
  ) {
    return this.automation.updateRule(projectId(data, metadata), data.rule_id ?? data.ruleId ?? '', data);
  }

  @GrpcMethod('AutomationGrpc', 'DeleteRule')
  deleteRule(data: { project_id?: string; projectId?: string; rule_id?: string; ruleId?: string }, metadata?: Metadata) {
    return this.automation.deleteRule(projectId(data, metadata), data.rule_id ?? data.ruleId ?? '');
  }

  @GrpcMethod('AutomationGrpc', 'RestoreRule')
  restoreRule(data: { project_id?: string; projectId?: string; rule_id?: string; ruleId?: string }, metadata?: Metadata) {
    return this.automation.restoreRule(projectId(data, metadata), data.rule_id ?? data.ruleId ?? '');
  }

  @GrpcMethod('AutomationGrpc', 'ExecuteRule')
  executeRule(data: {
    project_id?: string;
    projectId?: string;
    rule_id?: string;
    ruleId?: string;
    source?: string;
    payload_json?: string;
  }, metadata?: Metadata) {
    return this.automation.executeRule(
      projectId(data, metadata),
      data.rule_id ?? data.ruleId ?? '',
      data.source ?? 'manual',
      data.payload_json ?? '{}',
      readUserId(metadata),
      visibilityScope(metadata),
    );
  }

  @GrpcMethod('AutomationGrpc', 'HookEvent')
  hookEvent(data: {
    project_id?: string;
    projectId?: string;
    event_name?: string;
    eventName?: string;
    source?: string;
    payload_json?: string;
  }, metadata?: Metadata) {
    // The only caller of this RPC is the gateway BFF
    // (`POST /automation/integration/trigger`), i.e. an authenticated end user
    // with a fully client-supplied payload. The actor + scope travel with the
    // run so the matched rules execute under the CALLER's visibility, not the
    // s2s one (§3.8 IDOR). The bus path never comes through here.
    return this.automation.hookEvent(
      projectId(data, metadata),
      data.event_name ?? data.eventName ?? '',
      data.source ?? 'event_hook',
      data.payload_json ?? '{}',
      readUserId(metadata),
      visibilityScope(metadata),
    );
  }

  @GrpcMethod('AutomationGrpc', 'SetRuleEnabled')
  setRuleEnabled(data: {
    project_id?: string;
    projectId?: string;
    rule_id?: string;
    ruleId?: string;
    enabled?: boolean;
    can_manage?: boolean;
    canManage?: boolean;
  }, metadata?: Metadata) {
    return this.automation.setRuleEnabled(
      projectId(data, metadata),
      ruleId(data),
      Boolean(data.enabled),
      readUserId(metadata),
      (data.can_manage ?? data.canManage) === true,
    );
  }

  @GrpcMethod('AutomationGrpc', 'ManualRun')
  manualRun(data: {
    project_id?: string;
    projectId?: string;
    rule_id?: string;
    ruleId?: string;
    entity_type?: string;
    entityType?: string;
    entity_id?: string;
    entityId?: string;
  }, metadata?: Metadata) {
    // Entity ref comes from the request body → the run executes under the
    // caller's own visibility (§3.8 IDOR), same as ExecuteRule.
    return this.automation.manualRun(
      projectId(data, metadata),
      ruleId(data),
      data.entity_type ?? data.entityType ?? '',
      data.entity_id ?? data.entityId ?? '',
      readUserId(metadata),
      visibilityScope(metadata),
      metadata,
    );
  }

  @GrpcMethod('AutomationGrpc', 'DryRun')
  dryRun(data: {
    project_id?: string;
    projectId?: string;
    rule_id?: string;
    ruleId?: string;
    sample_json?: string;
    sampleJson?: string;
    last_n?: number;
    lastN?: number;
  }, metadata?: Metadata) {
    return this.automation.dryRun(
      projectId(data, metadata),
      ruleId(data),
      data.sample_json ?? data.sampleJson ?? '',
      data.last_n ?? data.lastN ?? 0,
    );
  }

  @GrpcMethod('AutomationGrpc', 'ListExecutions')
  listExecutions(data: {
    project_id?: string;
    projectId?: string;
    rule_id?: string;
    ruleId?: string;
    page_index?: number;
    page_size?: number;
    status?: string;
  }, metadata?: Metadata) {
    return this.automation.listExecutions(
      projectId(data, metadata),
      ruleId(data),
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.status,
    );
  }

  @GrpcMethod('AutomationGrpc', 'ListProjectExecutions')
  listProjectExecutions(data: {
    project_id?: string;
    projectId?: string;
    page_index?: number;
    page_size?: number;
    status?: string;
    action_type?: string;
    from?: number;
    to?: number;
    rule_id?: string;
    entity_type?: string;
    entityType?: string;
    entity_id?: string;
    entityId?: string;
  }, metadata?: Metadata) {
    return this.automation.listProjectExecutions(
      projectId(data, metadata),
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.status,
      data.action_type,
      data.from,
      data.to,
      data.rule_id,
      data.entity_type ?? data.entityType,
      data.entity_id ?? data.entityId,
    );
  }

  @GrpcMethod('AutomationGrpc', 'GetRegistry')
  getRegistry(data: {
    project_id?: string;
    projectId?: string;
    enabled_modules?: string[];
    enabledModules?: string[];
  }, metadata?: Metadata) {
    return this.automation.getRegistry(
      projectId(data, metadata),
      data.enabled_modules ?? data.enabledModules ?? [],
    );
  }

  // ── automation-v2 (contract §2.3) ───────────────────────────────────────
  @GrpcMethod('AutomationGrpc', 'ValidateGraph')
  validateGraph(data: {
    project_id?: string;
    projectId?: string;
    graph?: unknown;
    can_manage?: boolean;
    canManage?: boolean;
    enabled_modules?: string[];
    enabledModules?: string[];
  }) {
    const graph = graphFromWire(data.graph as Parameters<typeof graphFromWire>[0]);
    return this.automation.validateGraph(
      projectId(data),
      graph,
      (data.can_manage ?? data.canManage) === true,
      data.enabled_modules ?? data.enabledModules ?? [],
    );
  }

  @GrpcMethod('AutomationGrpc', 'GetNodeRegistry')
  getNodeRegistry(data: {
    project_id?: string;
    projectId?: string;
    enabled_modules?: string[];
    enabledModules?: string[];
  }) {
    return this.automation.getNodeRegistry(
      projectId(data),
      data.enabled_modules ?? data.enabledModules ?? [],
    );
  }

  @GrpcMethod('AutomationGrpc', 'ListConnections')
  listConnections(data: {
    project_id?: string;
    projectId?: string;
    page_index?: number;
    page_size?: number;
  }, metadata?: Metadata) {
    return this.automation.listConnections(
      projectId(data, metadata),
      data.page_index ?? 0,
      data.page_size ?? 25,
    );
  }

  @GrpcMethod('AutomationGrpc', 'GetConnection')
  getConnection(data: {
    project_id?: string;
    projectId?: string;
    connection_id?: string;
    connectionId?: string;
  }, metadata?: Metadata) {
    return this.automation.getConnection(projectId(data, metadata), connectionId(data));
  }

  @GrpcMethod('AutomationGrpc', 'CreateConnection')
  createConnection(data: Record<string, unknown> & { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.automation.createConnection(projectId(data, metadata), data);
  }

  @GrpcMethod('AutomationGrpc', 'UpdateConnection')
  updateConnection(
    data: Record<string, unknown> & {
      project_id?: string;
      projectId?: string;
      connection_id?: string;
      connectionId?: string;
    },
    metadata?: Metadata,
  ) {
    return this.automation.updateConnection(projectId(data, metadata), connectionId(data), data);
  }

  @GrpcMethod('AutomationGrpc', 'DeleteConnection')
  deleteConnection(data: {
    project_id?: string;
    projectId?: string;
    connection_id?: string;
    connectionId?: string;
  }, metadata?: Metadata) {
    return this.automation.deleteConnection(projectId(data, metadata), connectionId(data));
  }

  @GrpcMethod('AutomationGrpc', 'ListDlq')
  listDlq(data: {
    project_id?: string;
    projectId?: string;
    page_index?: number;
    page_size?: number;
    status?: string;
  }, metadata?: Metadata) {
    return this.automation.listDlq(
      projectId(data, metadata),
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.status,
    );
  }

  @GrpcMethod('AutomationGrpc', 'RetryDlq')
  retryDlq(data: {
    project_id?: string;
    projectId?: string;
    dlq_id?: string;
    dlqId?: string;
  }, metadata?: Metadata) {
    return this.automation.retryDlq(projectId(data, metadata), dlqId(data));
  }

  @GrpcMethod('AutomationGrpc', 'DismissDlq')
  dismissDlq(data: {
    project_id?: string;
    projectId?: string;
    dlq_id?: string;
    dlqId?: string;
    reason?: string;
  }, metadata?: Metadata) {
    return this.automation.dismissDlq(projectId(data, metadata), dlqId(data), data.reason ?? '');
  }

  // Internal: control → automation. SECURITY (§3.22/3.23): these have NO public
  // REST facade and must only be invoked by a service actor (no end-user
  // context). The shared inbound API-key guard authenticates the s2s caller;
  // service-vs-user actor enforcement is a follow-up PEP check — TODO(PRE-2,
  // control wiring): reject when x-user-id is present.
  @GrpcMethod('AutomationGrpc', 'FreezeRules')
  freezeRules(data: { project_id?: string; projectId?: string; reason?: string }, metadata?: Metadata) {
    assertServiceOnly(metadata);
    return this.automation.freezeRules(projectId(data, metadata), data.reason ?? '');
  }

  @GrpcMethod('AutomationGrpc', 'UnfreezeRules')
  unfreezeRules(data: { project_id?: string; projectId?: string; reason?: string }, metadata?: Metadata) {
    assertServiceOnly(metadata);
    return this.automation.unfreezeRules(projectId(data, metadata), data.reason ?? '');
  }

  @GrpcMethod('AutomationGrpc', 'ReconcileRuleDependencies')
  reconcileRuleDependencies(
    data: {
      project_id?: string;
      projectId?: string;
      enabled_modules?: string[];
      enabledModules?: string[];
    },
    metadata?: Metadata,
  ) {
    assertServiceOnly(metadata);
    return this.automation.reconcileRuleDependencies(
      projectId(data, metadata),
      data.enabled_modules ?? data.enabledModules ?? [],
    );
  }

  @GrpcMethod('AutomationGrpc', 'DisableRulesForInactiveActor')
  disableRulesForInactiveActor(
    data: { project_id?: string; projectId?: string; actor_user_id?: string; actorUserId?: string },
    metadata?: Metadata,
  ) {
    assertServiceOnly(metadata);
    return this.automation.disableRulesForInactiveActor(
      projectId(data, metadata),
      data.actor_user_id ?? data.actorUserId ?? '',
    );
  }

  @GrpcMethod('AutomationGrpc', 'ResumePausedDlq')
  resumePausedDlq(
    data: { project_id?: string; projectId?: string; dlq_fate?: string },
    metadata?: Metadata,
  ) {
    assertServiceOnly(metadata);
    const fate = data.dlq_fate === 'deliver' ? 'deliver' : 'discard';
    return this.automation.resumePausedDlq(projectId(data, metadata), fate);
  }
}
