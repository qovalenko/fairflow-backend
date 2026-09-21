import { status } from '@grpc/grpc-js';
import {
  newEntityId,
  dedupKey,
  MAX_EVENT_DEPTH,
  validateWebhookTarget,
  type EventEnvelope,
} from '@fairflow/shared';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { ModuleRuntimeGate } from './module-runtime-gate.service';
import { ActionDispatcher, type ActionResult } from './action-dispatcher.service';
import { createHash } from 'node:crypto';
import { ACTION_CATALOG, EXTERNAL_EFFECT_ACTIONS, TRIGGER_CATALOG } from './registry';
import { ExecutorRegistry } from './executors/executor-registry.service';
import { DlqRetryService, DLQ_MANUAL_RETRYABLE, maxAttempts } from './dlq-retry.service';
import { SecretProviderRegistry } from './secret-provider';
import { compileConditions, validateConditionTree } from './condition-compiler';
import type { GraphSpec } from './graph/graph-types';
import {
  denormalizeTrigger,
  graphFromJson,
  graphFromWire,
  graphToJson,
} from './graph/graph-mapper';
import { isGraphValid, validateGraph } from './graph/graph-validator';
import {
  flatRuleRequiredModules,
  graphRequiredModules,
  missingModules,
  ruleDocRequiredModules,
} from './module-dependency';
import { entityRefFromPayload } from './entity-ref';
import { RuleThrottleService } from './rule-throttle.service';
import { executeGraph, type GraphRunContext } from './graph/graph-executor';
import {
  STRUCTURAL_NODE_TYPES,
  actionNodeTypes,
  triggerNodeTypes,
} from './graph/node-registry';
import { emitAutomationEvent } from './event-emitter';
import { EntitySnapshotService } from './entity-snapshot.service';
import { legacyRulePatch } from './legacy-rule-migrate';
import { bumpRuleStats } from './rule-stats';
import { OperatorNotifyService } from './operator-notify.service';
import { AutomationMongoOutboxStore } from '../outbox/mongo-outbox.store';
import type { EmitIntent } from '@fairflow/shared';

type RuleState = 'enabled' | 'disabled' | 'frozen' | 'unexecutable' | 'deleted';

/** Known trigger ids ('crm.deal.created', …) — the classic-form trigger picker values. */
const TRIGGER_IDS = new Set(TRIGGER_CATALOG.map((t) => t.id));

// Escape user input before building a RegExp — otherwise a crafted query can
// inject regex metacharacters (ReDoS / unintended matches) into the Mongo filter.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type RuleDoc = {
  _id: ObjectId;
  id: string;
  project_id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config_json: string;
  conditions_json: string;
  actions_json: string;
  created_at: number;
  updated_at: number;
  last_executed_at: number;
  // TO-BE fields (contract §5.1) — optional for legacy docs.
  state?: RuleState;
  priority?: number;
  created_by?: string;
  notify_on_failure?: string;
  unexecutable?: boolean;
  disabled_reason?: string;
  deleted_at?: number;
  stats_json?: string;
  // automation-v2 (contract §1.2) — optional; absent ⇒ v1 flat rule.
  engine_version?: number;
  graph_json?: string;
  graph_hash?: string;
};

type ConnectionDoc = {
  _id: ObjectId;
  id: string;
  project_id: string;
  name: string;
  url: string;
  secret_ref?: string;
  /** AES-256-GCM envelope of the connection secret (audit #24.1). Never plaintext. */
  secret_enc?: string;
  headers_json: string;
  enabled: boolean;
  breaker_state: string;
  breaker_failures: number;
  breaker_opened_at?: number;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type DlqDoc = {
  _id: ObjectId;
  id: string;
  project_id: string;
  execution_id: string;
  rule_id: string;
  action_index: number;
  action_type: string;
  action_config_json?: string;
  connection_id?: string;
  payload_json?: string;
  status: string;
  attempts: number;
  last_error?: string;
  last_http_code?: number;
  next_retry_at?: number;
  /** TODO-041: bumped on every re-dispatch — the retry's key generation. */
  retry_generation?: number;
  max_attempts?: number;
  created_at: number;
  updated_at: number;
};

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
    private readonly runtimeGate: ModuleRuntimeGate,
    private readonly dispatcher: ActionDispatcher,
    private readonly secrets: SecretProviderRegistry,
    private readonly executors: ExecutorRegistry,
    private readonly dlqRetry: DlqRetryService,
    private readonly entitySnapshot: EntitySnapshotService,
    private readonly throttle: RuleThrottleService,
    private readonly operatorNotify: OperatorNotifyService,
    private readonly outbox: AutomationMongoOutboxStore,
  ) {}

  private ruleState(doc: RuleDoc): RuleState {
    if (doc.state) return doc.state;
    // Derive for legacy docs that predate the `state` field (§5.6 migration).
    if (doc.unexecutable) return 'unexecutable';
    return doc.enabled ? 'enabled' : 'disabled';
  }

  private toRule(doc: RuleDoc) {
    return {
      id: doc.id,
      project_id: doc.project_id,
      name: doc.name,
      description: doc.description,
      enabled: doc.enabled,
      trigger_type: doc.trigger_type,
      trigger_config_json: doc.trigger_config_json,
      conditions_json: doc.conditions_json,
      actions_json: doc.actions_json,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      last_executed_at: doc.last_executed_at,
      state: this.ruleState(doc),
      priority: doc.priority ?? 100,
      created_by: doc.created_by ?? '',
      notify_on_failure: doc.notify_on_failure ?? (doc.created_by ?? ''),
      unexecutable: doc.unexecutable ?? false,
      disabled_reason: doc.disabled_reason ?? '',
      deleted_at: doc.deleted_at ?? 0,
      stats_json: doc.stats_json ?? '{}',
      // automation-v2: surface the engine discriminator + serialized graph so the
      // canvas can rehydrate. Legacy/v1 docs report engine_version=1, graph_json=''.
      engine_version: doc.engine_version ?? 1,
      graph_json: doc.graph_json ?? '',
      graph_hash: doc.graph_hash ?? '',
    };
  }

  /** sha256 of the canonical graph JSON — dedup / change-detection (§1.2). */
  private graphHash(graphJson: string): string {
    return createHash('sha256').update(graphJson).digest('hex');
  }

  /**
   * Resolve a v2 graph from the request body. The graph travels as a nested proto
   * message (`graph`) or, defensively, as a serialized `graph_json` string. Returns
   * null when the rule is not v2 / no graph supplied.
   */
  private resolveGraphFromInput(data: Record<string, unknown>): GraphSpec | null {
    const fromWire = graphFromWire(data.graph as Parameters<typeof graphFromWire>[0]);
    if (fromWire) return fromWire;
    return graphFromJson(typeof data.graph_json === 'string' ? data.graph_json : undefined);
  }

  /** True when the caller declared `automation:manage` (gateway request flag). Absent = denied. */
  private callerCanManage(data: Record<string, unknown>): boolean {
    return (data.can_manage ?? data.canManage) === true;
  }

  /** Enabled module ids from gateway metadata (never trusted from body alone). */
  private resolveEnabledModules(data: Record<string, unknown>): string[] {
    const raw = data.enabled_modules ?? data.enabledModules;
    if (!Array.isArray(raw)) return [];
    return raw.map((m) => String(m).trim()).filter(Boolean);
  }

  private assertModuleDependencies(
    required: string[],
    enabledModules: string[],
  ): void {
    if (!enabledModules.length) return;
    const missing = missingModules(required, enabledModules);
    if (!missing.length) return;
    throw new RpcException({
      code: status.FAILED_PRECONDITION,
      message: 'missing_dependency',
      ...({ missing_modules: missing } as object),
    });
  }

  /**
   * Validate a v2 graph and throw INVALID_ARGUMENT (with issues) when it is not
   * savable. The same validator backs the `ValidateGraph` RPC (no save) — domain
   * is the single authority (PEP), the gateway never inspects graph contents.
   */
  private assertGraphValid(
    graph: GraphSpec,
    canManage: boolean,
    enabledModules: string[] = [],
  ): void {
    const issues = validateGraph(graph, { canManage, enabledModules });
    if (!isGraphValid(issues)) {
      const missing = issues.some((i) => i.code === 'MISSING_DEPENDENCY');
      throw new RpcException({
        code: missing ? status.FAILED_PRECONDITION : status.INVALID_ARGUMENT,
        message: missing ? 'missing_dependency' : 'GRAPH_INVALID',
        ...({ issues } as object),
      });
    }
  }

  private assertFlatModuleDependencies(
    triggerType: string,
    triggerConfigJson: string,
    actionsJson: string,
    enabledModules: string[],
  ): void {
    this.assertModuleDependencies(
      flatRuleRequiredModules(triggerType, triggerConfigJson, actionsJson),
      enabledModules,
    );
  }

  private computeUnexecutable(
    doc: Pick<
      RuleDoc,
      | 'engine_version'
      | 'graph_json'
      | 'trigger_type'
      | 'trigger_config_json'
      | 'actions_json'
    >,
    enabledModules: string[],
  ): boolean {
    if (!enabledModules.length) return false;
    return (
      missingModules(ruleDocRequiredModules(doc), enabledModules).length > 0
    );
  }

  /** Rules that may execute: not frozen/unexecutable/deleted (§3.22, TODO-135). */
  private runnableRuleFilter(): Record<string, unknown> {
    return {
      $and: [
        { $or: [{ deleted_at: { $exists: false } }, { deleted_at: 0 }] },
        {
          $or: [
            { state: { $exists: false } },
            { state: 'enabled' },
          ],
        },
        { $or: [{ unexecutable: { $exists: false } }, { unexecutable: false }] },
      ],
    };
  }

  private notDeletedFilter(): Record<string, unknown> {
    return { $or: [{ deleted_at: { $exists: false } }, { deleted_at: 0 }] };
  }

  private actionTypesFromResults(results: unknown[]): string[] {
    return [
      ...new Set(
        results
          .map((r) =>
            r && typeof r === 'object' ? String((r as ActionResult).type ?? '') : '',
          )
          .filter(Boolean),
      ),
    ];
  }

  private ruleEventIntent(
    type: string,
    projectId: string,
    ruleId: string,
    payload: Record<string, unknown>,
  ): EmitIntent {
    return {
      type,
      source: 'automation',
      projectId,
      subject: `rule/${ruleId}`,
      payload,
      idempotencyKey: `${type}:${projectId}:${ruleId}:${Date.now()}`,
    };
  }

  /** Lazy migration for pre-normalization v1 rules (FR-AUTOM-010). */
  private async ensureLegacyRuleMigrated(doc: RuleDoc): Promise<RuleDoc> {
    const patch = legacyRulePatch(doc);
    if (!patch) return doc;
    await this.mongo.rules().updateOne(
      { project_id: doc.project_id, id: doc.id },
      { $set: { ...patch, updated_at: Date.now() } },
    );
    return { ...doc, ...patch };
  }

  /**
   * Event-path query: canonical `trigger_type:'event'` PLUS catalog ids left on
   * pre-normalization v1 docs. Matching after lazy migrate (FR-AUTOM-010) —
   * otherwise those rules stay invisible to consumeEvent/hookEvent until someone
   * happens to open the list.
   */
  private eventRuleFindFilter(project_id: string): Record<string, unknown> {
    return {
      project_id,
      enabled: true,
      ...this.runnableRuleFilter(),
      $or: [{ trigger_type: 'event' }, { trigger_type: { $in: [...TRIGGER_IDS] } }],
    };
  }

  private async findMatchingEventRules(
    project_id: string,
    eventName: string,
  ): Promise<RuleDoc[]> {
    const matched = (await this.mongo
      .rules()
      .find(this.eventRuleFindFilter(project_id))
      .sort({ priority: 1, _id: 1 })
      .toArray()) as RuleDoc[];
    const migrated: RuleDoc[] = [];
    for (const rule of matched) {
      migrated.push(await this.ensureLegacyRuleMigrated(rule));
    }
    return migrated.filter((rule) => this.ruleMatchesEvent(rule, eventName));
  }

  private async bumpRuleStatsDoc(
    rule: Pick<RuleDoc, 'project_id' | 'id' | 'stats_json'>,
    update: Parameters<typeof bumpRuleStats>[1],
  ): Promise<void> {
    const stats_json = bumpRuleStats(rule.stats_json, update);
    await this.mongo
      .rules()
      .updateOne({ project_id: rule.project_id, id: rule.id }, { $set: { stats_json } });
  }

  private async emitFact(
    type: string,
    payload: Record<string, unknown>,
    projectId?: string,
    subject?: string,
    userId?: string,
    causation?: { traceId?: string; causationId?: string; parentDepth?: number },
  ): Promise<void> {
    await emitAutomationEvent(this.rabbit, {
      type,
      payload,
      projectId,
      subject,
      userId,
      actorType: userId ? 'user' : 'service',
      causation,
    });
  }


  /** Action ids declared in a rule's actions_json (best-effort parse). */
  private ruleActionTypes(rule: RuleDoc): string[] {
    return this.parseArray(rule.actions_json)
      .map((a) =>
        a && typeof a === 'object'
          ? String((a as Record<string, unknown>).type ?? (a as Record<string, unknown>).id ?? '')
          : '',
      )
      .filter(Boolean);
  }

  /** True if a serialized actions array contains an external-effect action. */
  private actionsHaveExternalEffect(actionsJson: string): boolean {
    return this.parseArray(actionsJson)
      .map((a) =>
        a && typeof a === 'object'
          ? String((a as Record<string, unknown>).type ?? (a as Record<string, unknown>).id ?? '')
          : '',
      )
      .some((t) => EXTERNAL_EFFECT_ACTIONS.has(t));
  }

  /** True if a rule document contains an external-effect action (v1 flat or v2 graph). */
  private ruleHasExternalEffect(doc: RuleDoc): boolean {
    if (this.actionsHaveExternalEffect(doc.actions_json ?? '[]')) return true;
    const graph = graphFromJson(doc.graph_json);
    if (!graph?.nodes) return false;
    for (const n of graph.nodes) {
      if (n.type !== 'action') continue;
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const actionId = String(cfg.action_id ?? cfg.actionId ?? cfg.type ?? '');
      if (EXTERNAL_EFFECT_ACTIONS.has(actionId)) return true;
    }
    return false;
  }

  /**
   * External-effect gate for FLAT (v1) rules — the same privilege the graph
   * validator enforces for v2 (FR-AUTOM-250, §3.3). Saving a rule whose actions
   * contain an external/irreversible effect (send_webhook/send_email) requires
   * `automation:manage`. Fail-closed: an absent `can_manage` flag denies.
   */
  private assertFlatExternalEffectAllowed(
    actionsJson: string,
    data: Record<string, unknown>,
  ): void {
    if (this.actionsHaveExternalEffect(actionsJson) && !this.callerCanManage(data)) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'EXTERNAL_EFFECT_REQUIRES_MANAGE',
      });
    }
  }

  /**
   * Normalize a v1 (classic-form) trigger on write (FR-AUTOM-010/450). The form
   * sends the catalog trigger id ('crm.deal.created', …) as `trigger_type`; the
   * bus consumer only matches `trigger_type='event'` + `trigger_config_json.event_name`.
   * Denormalize exactly like the v2 graph path does: trigger_type='event', the
   * event id goes into the config. An unknown non-'event' trigger id is rejected
   * so a rule can never be saved silently unmatchable.
   */
  private normalizeV1Trigger(
    rawTriggerType: string,
    triggerConfigJson: string,
  ): { trigger_type: string; trigger_config_json: string } {
    const raw = rawTriggerType.trim() || 'event';
    if (raw === 'event') {
      return { trigger_type: 'event', trigger_config_json: triggerConfigJson };
    }
    if (!TRIGGER_IDS.has(raw)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `Unknown trigger "${raw}"`,
      });
    }
    const cfg = this.parseJson(triggerConfigJson);
    cfg.event_name = raw;
    return { trigger_type: 'event', trigger_config_json: JSON.stringify(cfg) };
  }

  /**
   * Reject-on-save validation of a rule's conditions (FR-AUTOM-070): a tree the
   * condition compiler cannot evaluate (unknown op / node shape) must fail the
   * save with INVALID_ARGUMENT instead of silently compiling to `false` at
   * execution time. Execution paths stay fail-closed (skip), unchanged.
   */
  private assertConditionsCompilable(conditionsJson: string): void {
    const problem = validateConditionTree(conditionsJson);
    if (problem) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `CONDITIONS_NOT_COMPILABLE: ${problem}`,
      });
    }
  }

  private parseJson(raw: string): Record<string, unknown> {
    try {
      const value = JSON.parse(raw || '{}');
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {
      // Ignore malformed payloads and fallback to empty object.
    }
    return {};
  }

  private parseArray(raw: string): unknown[] {
    try {
      const value = JSON.parse(raw || '[]');
      if (Array.isArray(value)) return value;
    } catch {
      // Ignore malformed payloads and fallback to empty array.
    }
    return [];
  }

  /**
   * Evaluate a rule's compiled conditions against an event payload (audit
   * #24.2). Empty conditions == pass. A malformed condition tree is fail-closed
   * (does not match) so a broken rule cannot fire external effects on every
   * event; the mis-match is logged (never the payload).
   */
  private evaluateRuleConditions(rule: RuleDoc, payload: Record<string, unknown>): boolean {
    try {
      return compileConditions(rule.conditions_json ?? '[]')(payload);
    } catch (err) {
      this.logger.warn(
        `Rule ${rule.id} condition evaluation errored (${err instanceof Error ? err.name : 'error'}) — treated as non-match`,
      );
      return false;
    }
  }

  async listRules(
    project_id: string,
    page_index: number,
    page_size: number,
    query?: string,
    enabled_only?: boolean,
    state?: string,
    trigger_type?: string,
    created_by?: string,
    engine_version?: number,
  ) {
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const clauses: Record<string, unknown>[] = [{ project_id }, this.notDeletedFilter()];
    if (enabled_only) clauses.push({ enabled: true });
    const engineFilter = Number(engine_version ?? 0) || 0;
    if (engineFilter === 2) clauses.push({ engine_version: 2 });
    else if (engineFilter === 1) {
      clauses.push({
        $or: [{ engine_version: { $exists: false } }, { engine_version: 1 }],
      });
    }
    const stateTrim = state?.trim();
    if (stateTrim === 'enabled') {
      // Align with runnableRuleFilter: legacy rows without `state` count as enabled
      // when `enabled:true` (TODO-137 partial).
      clauses.push({
        $or: [{ state: 'enabled' }, { state: { $exists: false }, enabled: true }],
      });
    } else if (stateTrim) {
      clauses.push({ state: stateTrim });
    }
    if (trigger_type?.trim()) clauses.push({ trigger_type: trigger_type.trim() });
    if (created_by?.trim()) clauses.push({ created_by: created_by.trim() });
    if (query?.trim()) {
      const rx = new RegExp(escapeRegex(query.trim()), 'i');
      clauses.push({ $or: [{ name: rx }, { description: rx }] });
    }
    const filter =
      clauses.length === 1 ? clauses[0] : ({ $and: clauses } as Record<string, unknown>);
    const total = await this.mongo.rules().countDocuments(filter);
    const rows = (await this.mongo
      .rules()
      .find(filter)
      .sort({ updated_at: -1, _id: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray()) as RuleDoc[];
    const migrated: RuleDoc[] = [];
    for (const row of rows) {
      migrated.push(await this.ensureLegacyRuleMigrated(row));
    }
    return { list: migrated.map((row) => this.toRule(row)), total };
  }

  async getRule(project_id: string, rule_id: string) {
    const row = (await this.mongo.rules().findOne({
      project_id,
      id: rule_id,
      ...this.notDeletedFilter(),
    })) as RuleDoc | null;
    if (!row) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
    }
    return this.toRule(await this.ensureLegacyRuleMigrated(row));
  }

  async createRule(project_id: string, data: Record<string, unknown>) {
    const now = Date.now();
    const enabled = data.enabled == null ? true : Boolean(data.enabled);
    const engineVersion = Number(data.engine_version ?? data.engineVersion ?? 1) || 1;
    const enabledModules = this.resolveEnabledModules(data);
    const row: RuleDoc = {
      _id: new ObjectId(),
      id: newEntityId(),
      project_id,
      name: String(data.name ?? '').trim(),
      description: String(data.description ?? ''),
      enabled,
      trigger_type: String(data.trigger_type ?? 'event'),
      trigger_config_json: String(data.trigger_config_json ?? '{}'),
      conditions_json: String(data.conditions_json ?? '[]'),
      actions_json: String(data.actions_json ?? '[]'),
      created_at: now,
      updated_at: now,
      last_executed_at: 0,
      state: enabled ? 'enabled' : 'disabled',
      priority: data.priority == null ? 100 : Number(data.priority),
      created_by: String(data.created_by ?? ''),
      notify_on_failure: String(data.notify_on_failure ?? data.created_by ?? ''),
      unexecutable: false,
      stats_json: '{}',
      engine_version: 1,
    };
    if (!row.name) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Rule name is required' });
    }
    if (engineVersion !== 2) {
      // v1 flat rule: same reject-on-save discipline as the v2 graph validator —
      // trigger normalized to the consumer's shape, conditions must compile, and
      // external-effect actions require `automation:manage` (fail-closed).
      const trigger = this.normalizeV1Trigger(row.trigger_type, row.trigger_config_json);
      row.trigger_type = trigger.trigger_type;
      row.trigger_config_json = trigger.trigger_config_json;
      this.assertConditionsCompilable(row.conditions_json);
      this.assertFlatExternalEffectAllowed(row.actions_json, data);
      this.assertFlatModuleDependencies(
        row.trigger_type,
        row.trigger_config_json,
        row.actions_json,
        enabledModules,
      );
    }
    // automation-v2: when engine_version=2 the graph is the source of truth. We
    // validate it (reject-on-save §4), persist `graph_json`/`graph_hash`, and
    // DENORMALIZE `trigger_type`/`trigger_config_json` from the trigger node so the
    // event consumer matches without reading the graph (§1.2).
    if (engineVersion === 2) {
      const graph = this.resolveGraphFromInput(data);
      if (!graph) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'graph is required for engine_version=2' });
      }
      this.assertGraphValid(graph, this.callerCanManage(data), enabledModules);
      const graphJson = graphToJson(graph);
      const trigger = denormalizeTrigger(graph);
      row.engine_version = 2;
      row.graph_json = graphJson;
      row.graph_hash = this.graphHash(graphJson);
      row.trigger_type = trigger.trigger_type;
      row.trigger_config_json = trigger.trigger_config_json;
    }
    row.unexecutable = this.computeUnexecutable(row, enabledModules);
    if (row.unexecutable) {
      row.enabled = false;
      row.state = 'unexecutable';
    }
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.rules().insertOne(row, session ? { session } : {});
      return {
        result: row,
        intents: [
          this.ruleEventIntent('automation.rule.created', project_id, row.id, {
            rule_id: row.id,
            name: row.name,
          }),
        ],
      };
    });
    return this.toRule(row);
  }

  async updateRule(project_id: string, rule_id: string, data: Record<string, unknown>) {
    const existing = await this.getRule(project_id, rule_id);
    const enabledModules = this.resolveEnabledModules(data);
    if (existing.state === 'frozen' && data.enabled != null) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Правило заморожено (модуль выключен)',
      });
    }
    const set: Record<string, unknown> = { updated_at: Date.now() };
    if (data.name != null) set.name = String(data.name).trim();
    if (data.description != null) set.description = String(data.description);
    if (data.enabled != null && existing.state !== 'frozen') {
      set.enabled = Boolean(data.enabled);
      set.state = Boolean(data.enabled) ? 'enabled' : 'disabled';
    }
    if (data.priority != null) set.priority = Number(data.priority);
    if (data.notify_on_failure != null) set.notify_on_failure = String(data.notify_on_failure);

    // automation-v2: an engine_version=2 update saves the graph as the source of
    // truth (validated, §4) and denormalizes trigger fields from it (§1.2),
    // overriding any flat trigger_type/trigger_config_json in the body.
    const engineVersion = Number(data.engine_version ?? data.engineVersion ?? 0) || 0;
    const graph = engineVersion === 2 ? this.resolveGraphFromInput(data) : null;
    if (engineVersion === 2) {
      if (!graph) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'graph is required for engine_version=2' });
      }
      this.assertGraphValid(graph, this.callerCanManage(data), enabledModules);
      const graphJson = graphToJson(graph);
      const trigger = denormalizeTrigger(graph);
      set.engine_version = 2;
      set.graph_json = graphJson;
      set.graph_hash = this.graphHash(graphJson);
      set.trigger_type = trigger.trigger_type;
      set.trigger_config_json = trigger.trigger_config_json;
    } else {
      // v1 flat rule: normalize the trigger (classic form sends the catalog id),
      // reject non-compilable conditions and gate external-effect actions the
      // same way createRule does — an update must not bypass the save gates.
      if (data.trigger_type != null && String(data.trigger_type).trim()) {
        const trigger = this.normalizeV1Trigger(
          String(data.trigger_type),
          data.trigger_config_json != null
            ? String(data.trigger_config_json)
            : existing.trigger_config_json,
        );
        set.trigger_type = trigger.trigger_type;
        set.trigger_config_json = trigger.trigger_config_json;
      } else if (data.trigger_config_json != null) {
        set.trigger_config_json = String(data.trigger_config_json);
      }
      if (data.conditions_json != null) {
        this.assertConditionsCompilable(String(data.conditions_json));
        set.conditions_json = String(data.conditions_json);
      }
      if (data.actions_json != null) set.actions_json = String(data.actions_json);
      const effectiveActions =
        data.actions_json != null ? String(data.actions_json) : existing.actions_json;
      this.assertFlatExternalEffectAllowed(effectiveActions, data);
      const triggerType =
        data.trigger_type != null && String(data.trigger_type).trim()
          ? String(data.trigger_type)
          : existing.trigger_type;
      const triggerConfig =
        data.trigger_config_json != null
          ? String(data.trigger_config_json)
          : existing.trigger_config_json;
      this.assertFlatModuleDependencies(
        triggerType,
        triggerConfig,
        effectiveActions,
        enabledModules,
      );
    }

    if (typeof set.name === 'string' && !set.name) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Rule name cannot be empty' });
    }
    const merged: RuleDoc = {
      ...(await this.mongo.rules().findOne({ project_id, id: rule_id })) as RuleDoc,
      ...set,
      trigger_type: String(set.trigger_type ?? existing.trigger_type),
      trigger_config_json: String(set.trigger_config_json ?? existing.trigger_config_json),
      actions_json: String(set.actions_json ?? existing.actions_json),
      graph_json: String(set.graph_json ?? existing.graph_json ?? ''),
      engine_version: Number(set.engine_version ?? existing.engine_version ?? 1),
    };
    const unexecutable = this.computeUnexecutable(merged, enabledModules);
    set.unexecutable = unexecutable;
    if (unexecutable) {
      set.enabled = false;
      set.state = 'unexecutable';
      set.disabled_reason = '';
    } else if (merged.state !== 'frozen' && merged.disabled_reason !== 'actor_inactive') {
      if (set.enabled == null) {
        set.state = merged.enabled ? 'enabled' : 'disabled';
      }
    }
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .rules()
        .updateOne({ project_id, id: rule_id }, { $set: set }, session ? { session } : {});
      return {
        result: undefined,
        intents: [
          this.ruleEventIntent('automation.rule.updated', project_id, rule_id, { rule_id }),
        ],
      };
    });
    return this.getRule(project_id, rule_id);
  }

  async deleteRule(project_id: string, rule_id: string) {
    const now = Date.now();
    const existing = (await this.mongo.rules().findOne({
      project_id,
      id: rule_id,
      ...this.notDeletedFilter(),
    })) as RuleDoc | null;
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
    }
    await this.outbox.withOutbox(async (session) => {
      const result = await this.mongo.rules().updateOne(
        { project_id, id: rule_id, ...this.notDeletedFilter() },
        { $set: { state: 'deleted', deleted_at: now, enabled: false, updated_at: now } },
        session ? { session } : {},
      );
      if (result.matchedCount === 0) {
        throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
      }
      return {
        result: undefined,
        intents: [
          this.ruleEventIntent('automation.rule.deleted', project_id, rule_id, { rule_id }),
        ],
      };
    });
    return {};
  }

  /** Restore a soft-deleted rule (FR-AUTOM-325). */
  async restoreRule(project_id: string, rule_id: string) {
    this.requireProjectId(project_id);
    const doc = (await this.mongo.rules().findOne({ project_id, id: rule_id })) as RuleDoc | null;
    if (!doc || !doc.deleted_at) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Deleted rule not found' });
    }
    const now = Date.now();
    const enabled = doc.enabled !== false && !doc.unexecutable;
    await this.mongo.rules().updateOne(
      { project_id, id: rule_id },
      {
        $set: {
          state: enabled ? 'enabled' : doc.unexecutable ? 'unexecutable' : 'disabled',
          updated_at: now,
        },
        $unset: { deleted_at: '' },
      },
    );
    await this.emitFact('automation.rule.updated', { rule_id, restored: true }, project_id, `rule/${rule_id}`);
    return this.getRule(project_id, rule_id);
  }

  /**
   * Engine dispatch fork (TODO-040, FR-AUTOM-490/510): a v2 rule executes its
   * stored graph (trigger → condition/branch → actions) via {@link executeGraph};
   * a v1 rule dispatches its flat `actions_json`. Both run every action through
   * the same {@link ActionDispatcher} pipeline (isolation / anti-SSRF / DLQ),
   * and both report the same aggregate status shape. The v2 result additionally
   * carries `graph_path` (visited node ids) for the canvas trace.
   */
  private async dispatchRule(
    rule: RuleDoc,
    ctx: GraphRunContext,
  ): Promise<{ status: string; action_results: unknown[]; graph_path?: string[] }> {
    if ((rule.engine_version ?? 1) === 2) {
      const graph = graphFromJson(rule.graph_json);
      if (!graph) {
        // Defensive: a v2 rule without a parsable graph has nothing to run.
        return { status: 'skipped', action_results: [], graph_path: [] };
      }
      return executeGraph(graph, ctx, (type, action, c) =>
        this.dispatcher.dispatchOne(type, action, c),
      );
    }
    return this.dispatcher.dispatch(rule.actions_json, ctx);
  }

  /**
   * Run one rule ON BEHALF OF A CALLER.
   *
   * Every entry point that lands here is gateway-facing — `ExecuteRule`,
   * `HookEvent` (`POST /automation/integration/trigger`) and `ManualRun` — and
   * all three carry a CLIENT-SUPPLIED payload from which the entity-generic
   * executors resolve their target record. The run therefore executes strictly
   * under the CALLER's visibility (`user_id` + `visibility_scope` from the
   * gateway metadata); when the caller's scope was not forwarded the run stays
   * fail-closed (targets answer NOT_FOUND). The system `mode:'all'` scope belongs
   * to {@link executeRuleForEvent} — the bus path, where there is no end user —
   * and must never be reachable from here (§3.8 IDOR).
   */
  private async recordTerminalExecution(
    rule: RuleDoc,
    source: string,
    payload_json: string,
    status: string,
    skip_reason: string,
    user_id?: string,
    extra: Record<string, unknown> = {},
  ) {
    const executionId = newEntityId();
    const createdAt = Date.now();
    const entityRef = entityRefFromPayload(
      this.parseJson(payload_json),
      this.triggerEntityType(rule),
    );
    const skipped = {
      _id: new ObjectId(),
      execution_id: executionId,
      project_id: rule.project_id,
      rule_id: rule.id,
      source,
      payload_json,
      status,
      skip_reason,
      result_json: JSON.stringify({
        action_count: this.parseArray(rule.actions_json).length,
        trigger_type: rule.trigger_type,
      }),
      action_results_json: '[]',
      finished_at: createdAt,
      created_at: createdAt,
      created_dt: new Date(createdAt),
      entity_type: entityRef.entity_type,
      entity_id: entityRef.entity_id,
      ...extra,
    };
    await this.mongo.executions().insertOne(skipped);
    await this.mongo
      .rules()
      .updateOne(
        { project_id: rule.project_id, id: rule.id },
        { $set: { last_executed_at: createdAt, updated_at: Date.now() } },
      );
    await this.bumpRuleStatsDoc(rule, {
      matched: true,
      executed: status !== 'skipped',
      error: skip_reason && status !== 'success' ? skip_reason : undefined,
      at: createdAt,
    });
    await this.emitFact(
      'automation.rule.executed',
      {
        rule_id: rule.id,
        execution_id: executionId,
        source,
        status,
        skip_reason,
      },
      rule.project_id,
      `rule/${rule.id}`,
      user_id,
    );
    return {
      execution_id: executionId,
      rule_id: rule.id,
      project_id: rule.project_id,
      status,
      skip_reason,
      source,
      payload_json,
      result_json: skipped.result_json,
      action_results_json: '[]',
      created_at: createdAt,
    };
  }

  async executeRule(
    project_id: string,
    rule_id: string,
    source: string,
    payload_json: string,
    user_id?: string,
    visibility_scope?: string,
  ) {
    let rule = (await this.mongo.rules().findOne({
      project_id,
      id: rule_id,
      enabled: true,
      ...this.runnableRuleFilter(),
    })) as RuleDoc | null;
    if (!rule) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Active rule not found' });
    }
    rule = await this.ensureLegacyRuleMigrated(rule);
    if (rule.unexecutable) {
      return this.recordTerminalExecution(
        rule,
        source,
        payload_json,
        'skipped',
        'missing_dependency',
        user_id,
      );
    }
    if (await this.throttle.isThrottled(project_id, rule.id)) {
      return this.recordTerminalExecution(
        rule,
        source,
        payload_json,
        'throttled',
        'throttled',
        user_id,
      );
    }

    const executionId = newEntityId();
    const createdAt = Date.now();
    const parsedPayload = this.parseJson(payload_json);
    const entityRef = entityRefFromPayload(parsedPayload, this.triggerEntityType(rule));

    // Conditions gate (audit #24.2): compile rule.conditions into a safe
    // predicate and evaluate it against the event payload BEFORE dispatch. When
    // the conditions do not hold, record a `skipped` execution and produce no
    // action effects. No conditions == pass (matches legacy behaviour).
    if (!this.evaluateRuleConditions(rule, parsedPayload)) {
      const skipped = {
        _id: new ObjectId(),
        execution_id: executionId,
        project_id,
        rule_id: rule.id,
        source,
        payload_json,
        status: 'skipped',
        skip_reason: 'conditions_not_met',
        result_json: JSON.stringify({
          action_count: this.parseArray(rule.actions_json).length,
          trigger_type: rule.trigger_type,
        }),
        action_results_json: '[]',
        finished_at: Date.now(),
        created_at: createdAt,
        created_dt: new Date(createdAt),
        entity_type: entityRef.entity_type,
        entity_id: entityRef.entity_id,
      };
      await this.mongo.executions().insertOne(skipped);
      await this.mongo
        .rules()
        .updateOne({ project_id, id: rule.id }, { $set: { last_executed_at: createdAt, updated_at: Date.now() } });
      await this.emitFact(
        'automation.rule.executed',
        {
          rule_id: rule.id,
          execution_id: executionId,
          source,
          status: 'skipped',
        },
        project_id,
        `rule/${rule.id}`,
        user_id,
      );
      return {
        execution_id: executionId,
        rule_id: rule.id,
        project_id,
        status: 'skipped',
        source,
        payload_json,
        result_json: skipped.result_json,
        action_results_json: '[]',
        created_at: createdAt,
      };
    }
    // Real dispatch of the rule's ordered actions to executor domains /
    // connections (FR-MAUT-8). Produces per-action results + an aggregate status
    // (success|partial_fail|fail|skipped); failed external actions land in DLQ.
    // v2 rules execute their graph instead of the flat list (TODO-040).
    const dispatched = await this.dispatchRule(rule, {
      projectId: project_id,
      ruleId: rule.id,
      ruleName: rule.name,
      executionId,
      source,
      payload: parsedPayload,
      // User-initiated run (ExecuteRule / HookEvent / ManualRun): the CALLER's
      // own visibility scope is forwarded to the executor domains, and the actor
      // is declared explicitly so an absent/omitted scope fails CLOSED instead of
      // falling back to the system `mode:'all'` one. The payload of these runs is
      // client-supplied, so borrowing the system scope would turn "run this rule"
      // into "mutate any record in the project" (§3.8 IDOR).
      actor: 'user',
      userId: user_id,
      visibilityScope: visibility_scope,
      entityType: this.triggerEntityType(rule),
    });
    const execution = {
      _id: new ObjectId(),
      execution_id: executionId,
      project_id,
      rule_id: rule.id,
      source,
      payload_json,
      status: dispatched.status,
      ...(dispatched.graph_path ? { graph_path_json: JSON.stringify(dispatched.graph_path) } : {}),
      result_json: JSON.stringify({
        action_count: this.parseArray(rule.actions_json).length,
        trigger_type: rule.trigger_type,
      }),
      action_results_json: JSON.stringify(dispatched.action_results),
      action_types: this.actionTypesFromResults(dispatched.action_results),
      finished_at: Date.now(),
      created_at: createdAt,
      created_dt: new Date(createdAt),
      entity_type: entityRef.entity_type,
      entity_id: entityRef.entity_id,
    };
    await this.mongo.executions().insertOne(execution);
    await this.mongo
      .rules()
      .updateOne({ project_id, id: rule.id }, { $set: { last_executed_at: execution.created_at, updated_at: Date.now() } });
    await this.emitFact(
      'automation.rule.executed',
      {
        rule_id: rule.id,
        execution_id: execution.execution_id,
        source,
        status: execution.status,
      },
      project_id,
      `rule/${rule.id}`,
      user_id,
    );

    return {
      execution_id: execution.execution_id,
      rule_id: execution.rule_id,
      project_id,
      status: execution.status,
      source: execution.source,
      payload_json: execution.payload_json,
      result_json: execution.result_json,
      action_results_json: execution.action_results_json,
      created_at: execution.created_at,
    };
  }

  /**
   * Integration hook (`POST /api/v1/automation/integration/trigger`).
   *
   * NOT the bus path, despite the name: the ONLY caller of the `HookEvent` RPC is
   * the gateway BFF, so both the event name and the whole payload come from an
   * authenticated end user. `user_id` / `visibility_scope` are that user's, taken
   * from the gateway metadata, and every rule matched here runs under THEM — a
   * manager whose visibility is `only_own` cannot post `{payload:{deal_id:<foreign
   * deal>}}` and have a rule assign/mutate it on their behalf (§3.8 IDOR). The
   * real bus consumer is {@link consumeEvent} / {@link executeRuleForEvent}, and
   * only there is the actor the system.
   */
  async hookEvent(
    project_id: string,
    event_name: string,
    source: string,
    payload_json: string,
    user_id?: string,
    visibility_scope?: string,
  ) {
    // R4-E1-07: FREEZE automation triggers when the `automation` module is
    // disabled / runtime-suspended for the project. Rule data is preserved in
    // Mongo (untouched) — re-enable resumes execution without loss. Covers the
    // async bus-consumer path that bypasses the @RequireModule gRPC guard.
    const targetRules = await this.findMatchingEventRules(project_id, event_name);

    if (!(await this.runtimeGate.isAutomationRuntimeActive(project_id))) {
      const executions = [];
      for (const rule of targetRules) {
        executions.push(
          await this.recordTerminalExecution(
            rule,
            source,
            payload_json,
            'skipped',
            'module_disabled',
            user_id,
          ),
        );
      }
      return {
        accepted: false,
        frozen: true,
        reason: 'module_disabled',
        matched_rules: targetRules.length,
        executions,
      };
    }

    await this.mongo.eventHooks().insertOne({
      _id: new ObjectId(),
      id: newEntityId(),
      project_id,
      event_name,
      source,
      payload_json,
      matched_rule_ids: targetRules.map((item) => item.id),
      created_at: Date.now(),
      // TTL anchor (TODO-335): Mongo expires only BSON Dates, not number epochs.
      created_dt: new Date(),
    });
    await this.emitFact(
      'automation.event.hooked',
      {
        event_name,
        source,
        matched_rule_ids: targetRules.map((item) => item.id),
      },
      project_id,
    );

    const executions = [];
    for (const rule of targetRules) {
      executions.push(
        await this.executeRule(
          project_id,
          rule.id,
          source,
          payload_json,
          user_id,
          visibility_scope,
        ),
      );
    }

    return {
      accepted: true,
      matched_rules: targetRules.length,
      executions,
    };
  }

  /**
   * Real event-triggered path (contract §5 consumer, FR-MAUT-1..3/9/15).
   *
   * Called by {@link TriggerConsumerService} for every inbound `crm.*`
   * {@link EventEnvelope}. The envelope is the ONLY trusted source of the
   * project scope and lineage — `project_id` is taken from the envelope, never
   * from an arbitrary body (SEC-5, §3.21). Guarantees:
   *  - **isolation**: all reads/writes scope `{project_id}` from the envelope;
   *  - **freeze**: when the `automation` module is disabled/suspended for the
   *    project the event is acknowledged but produces no executions (R4-E1-07);
   *  - **anti-loop**: envelopes at/over {@link MAX_EVENT_DEPTH} are dropped
   *    (FR-MAUT-9 / RFC-4 depth) before any rule runs;
   *  - **dedup / exactly-once**: each (rule, message) pair claims a unique
   *    `idempotency_key = hash(rule_id + dedupKey(envelope))`; a duplicate
   *    delivery or a racing replica re-using the key is skipped, not re-executed
   *    (FR-MAUT-15, SEC-3).
   *
   * Returns a disposition for the broker: `ack` on success/skip, `dead` for a
   * non-retryable envelope (missing project/event), so the consumer can DLX it.
   */
  async consumeEvent(envelope: EventEnvelope): Promise<'ack' | 'dead'> {
    const projectId = String(envelope.projectId ?? '').trim();
    const eventName = String(envelope.type ?? '').trim();
    if (!projectId || !eventName) {
      // Untrusted/unscoped envelope — cannot be processed, must not be requeued.
      this.logger.warn(
        `Dead-lettering trigger without project/type (msg=${envelope.messageId ?? '?'})`,
      );
      return 'dead';
    }

    // Anti-loop (FR-MAUT-9): never fan out from an envelope already at the
    // causation-chain depth limit, otherwise self-triggering rules storm the bus.
    const depth = Number(envelope.depth ?? 0);
    if (depth >= MAX_EVENT_DEPTH) {
      this.logger.warn(
        `Suppressing trigger ${eventName} at depth ${depth} (>= ${MAX_EVENT_DEPTH}) for ${projectId}`,
      );
      return 'ack';
    }

    const targetRules = await this.findMatchingEventRules(projectId, eventName);
    const payloadJson = JSON.stringify(envelope.payload ?? {});

    // Freeze: module disabled / project archived → preserve rules, run nothing.
    if (!(await this.runtimeGate.isAutomationRuntimeActive(projectId))) {
      await this.mongo.eventHooks().insertOne({
        _id: new ObjectId(),
        id: newEntityId(),
        project_id: projectId,
        event_name: eventName,
        source: String(envelope.source ?? 'event'),
        payload_json: payloadJson,
        matched_rule_ids: targetRules.map((r) => r.id),
        skip_reason: 'module_disabled',
        message_id: envelope.messageId ?? '',
        trace_id: envelope.traceId ?? '',
        causation_id: envelope.causationId ?? '',
        depth: Number(envelope.depth ?? 0),
        created_at: Date.now(),
        created_dt: new Date(),
      });
      await this.emitFact(
        'automation.event.hooked',
        {
          event_name: eventName,
          source: String(envelope.source ?? 'event'),
          matched_rule_ids: targetRules.map((r) => r.id),
          reason: 'module_disabled',
        },
        projectId,
      );
      for (const rule of targetRules) {
        await this.recordTerminalExecution(
          rule,
          'event',
          payloadJson,
          'skipped',
          'module_disabled',
          undefined,
          {
            trigger_event_name: eventName,
            trace_id: envelope.traceId ?? envelope.messageId ?? '',
            causation_id: envelope.messageId ?? '',
          },
        );
      }
      return 'ack';
    }

    const dedup = dedupKey({
      idempotencyKey: envelope.idempotencyKey,
      messageId: envelope.messageId ?? '',
    });

    await this.mongo.eventHooks().insertOne({
      _id: new ObjectId(),
      id: newEntityId(),
      project_id: projectId,
      event_name: eventName,
      source: String(envelope.source ?? 'event'),
      payload_json: payloadJson,
      matched_rule_ids: targetRules.map((r) => r.id),
      message_id: envelope.messageId ?? '',
      trace_id: envelope.traceId ?? '',
      causation_id: envelope.causationId ?? '',
      depth,
      created_at: Date.now(),
      // TTL anchor (TODO-335): Mongo expires only BSON Dates, not number epochs.
      created_dt: new Date(),
    });
    await this.emitFact(
      'automation.event.hooked',
      {
        event_name: eventName,
        source: String(envelope.source ?? 'event'),
        matched_rule_ids: targetRules.map((r) => r.id),
      },
      projectId,
      undefined,
      envelope.userId,
      {
        traceId: envelope.traceId,
        causationId: envelope.messageId,
        parentDepth: depth,
      },
    );

    for (const rule of targetRules) {
      await this.executeRuleForEvent(
        projectId,
        await this.ensureLegacyRuleMigrated(rule),
        eventName,
        payloadJson,
        dedup,
        envelope,
      );
    }
    return 'ack';
  }

  /**
   * Entity type the rule's trigger fires on (`deal`, `contact`, …), from the
   * in-code trigger catalog. The entity-generic actions (`assign_user`,
   * `update_field`, `change_stage`) use it to know WHICH record they target when
   * the action config does not name one — without it a deal rule would have to
   * guess between the deal, its contact and its company.
   */
  private triggerEntityType(rule: RuleDoc, eventName?: string): string {
    const trigger = this.parseJson(rule.trigger_config_json);
    const name =
      (eventName ?? '').trim() ||
      String(trigger.event_name ?? trigger.eventName ?? '').trim() ||
      String(rule.trigger_type ?? '').trim();
    return TRIGGER_CATALOG.find((t) => t.eventName === name || t.id === name)?.entityType ?? '';
  }

  /** Does the rule's configured trigger event match the inbound event name. */
  private ruleMatchesEvent(rule: RuleDoc, eventName: string): boolean {
    const trigger = this.parseJson(rule.trigger_config_json);
    const fromConfig = String(trigger.event_name ?? trigger.eventName ?? '').trim();
    if (fromConfig) return fromConfig === eventName;
    const tt = String(rule.trigger_type ?? '').trim();
    if (tt && tt !== 'event') return tt === eventName;
    return !fromConfig;
  }

  /**
   * Execute one matched rule for an inbound event with an exactly-once claim
   * (FR-MAUT-15). Inserts the execution row under the unique `idempotency_key`
   * index BEFORE any dispatch; a `DuplicateKey` error means another delivery /
   * replica already claimed this (rule, message) pair → skip silently (no double
   * external effect, SEC-3). The enriched `automation.rule.executed` carries the
   * lineage (`trace_id`/`causation_id` = the triggering envelope's id).
   *
   * NOTE: real action dispatch (gRPC to executor domains / webhook send) lands
   * with the action executor + ABAC condition compiler (E3-02 / draft); for now
   * the claimed execution records the action summary, exactly as ExecuteRule,
   * so the dedup/lineage/anti-loop infrastructure is real and testable.
   */
  private async executeRuleForEvent(
    project_id: string,
    rule: RuleDoc,
    event_name: string,
    payload_json: string,
    dedup: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    const eventPayload = (envelope.payload as Record<string, unknown>) ?? {};
    const entityRef = entityRefFromPayload(eventPayload, this.triggerEntityType(rule, event_name));

    if (rule.unexecutable) {
      await this.recordTerminalExecution(
        rule,
        'event',
        payload_json,
        'skipped',
        'missing_dependency',
        undefined,
        {
          trigger_event_name: event_name,
          trace_id: envelope.traceId ?? envelope.messageId ?? '',
          causation_id: envelope.messageId ?? '',
        },
      );
      return;
    }
    if (await this.throttle.isThrottled(project_id, rule.id)) {
      await this.recordTerminalExecution(
        rule,
        'event',
        payload_json,
        'throttled',
        'throttled',
        undefined,
        {
          trigger_event_name: event_name,
          trace_id: envelope.traceId ?? envelope.messageId ?? '',
          causation_id: envelope.messageId ?? '',
        },
      );
      return;
    }

    const idempotencyKey = `${rule.id}:${dedup}`;
    const now = Date.now();
    const executionId = newEntityId();
    const execution = {
      _id: new ObjectId(),
      execution_id: executionId,
      project_id,
      rule_id: rule.id,
      source: 'event',
      payload_json,
      // Claimed in `running` first; the dispatch outcome is written below. The
      // claim happens BEFORE any external effect so a duplicate delivery / racing
      // replica is rejected by the unique index and produces no second dispatch.
      status: 'running',
      result_json: JSON.stringify({
        action_count: this.parseArray(rule.actions_json).length,
        trigger_type: rule.trigger_type,
      }),
      trigger_event_name: event_name,
      idempotency_key: idempotencyKey,
      trace_id: envelope.traceId ?? envelope.messageId ?? '',
      causation_id: envelope.messageId ?? '',
      entity_type: entityRef.entity_type,
      entity_id: entityRef.entity_id,
      created_at: now,
      created_dt: new Date(now),
    };
    try {
      await this.mongo.executions().insertOne(execution);
    } catch (err) {
      // Duplicate idempotency_key (Mongo error 11000) → already claimed by a
      // concurrent delivery/replica; this is the exactly-once guard, not a fault.
      if (this.isDuplicateKeyError(err)) {
        this.logger.debug(
          `Skipping duplicate execution for rule ${rule.id} key ${idempotencyKey}`,
        );
        return;
      }
      throw err;
    }

    // Conditions gate (audit #24.2): evaluate the compiled predicate against the
    // event payload AFTER the exactly-once claim (so a skip is still recorded
    // once) but BEFORE any dispatch. Non-matching conditions → `skipped`, no
    // external effect. No conditions == pass.
    if (!this.evaluateRuleConditions(rule, eventPayload)) {
      await this.mongo.executions().updateOne(
        { execution_id: executionId },
        {
          $set: {
            status: 'skipped',
            skip_reason: 'conditions_not_met',
            action_results_json: '[]',
            finished_at: Date.now(),
          },
        },
      );
      await this.emitFact(
        'automation.rule.executed',
        {
          rule_id: rule.id,
          execution_id: executionId,
          source: 'event',
          status: 'skipped',
          trigger_event_name: event_name,
          trace_id: execution.trace_id,
          causation_id: execution.causation_id,
        },
        project_id,
        `rule/${rule.id}`,
        undefined,
        {
          traceId: execution.trace_id,
          causationId: execution.causation_id,
          parentDepth: envelope.depth,
        },
      );
      return;
    }

    // Real dispatch — only reached by the single delivery that won the claim, so
    // each external effect runs exactly once (SEC-3). The triggering envelope's
    // depth/causation propagate via the executor metadata (anti-loop lineage).
    // v2 rules execute their graph instead of the flat list (TODO-040).
    const dispatched = await this.dispatchRule(rule, {
      projectId: project_id,
      ruleId: rule.id,
      ruleName: rule.name,
      executionId,
      source: 'event',
      payload: eventPayload,
      actor: 'system',
      userId: String(rule.created_by ?? '').trim(),
      ruleAuthorId: String(rule.created_by ?? '').trim(),
      entityType: this.triggerEntityType(rule, event_name),
    });
    await this.mongo.executions().updateOne(
      { execution_id: executionId },
      {
        $set: {
          status: dispatched.status,
          action_results_json: JSON.stringify(dispatched.action_results),
          action_types: this.actionTypesFromResults(dispatched.action_results),
          finished_at: Date.now(),
          ...(dispatched.graph_path
            ? { graph_path_json: JSON.stringify(dispatched.graph_path) }
            : {}),
        },
      },
    );
    await this.mongo
      .rules()
      .updateOne(
        { project_id, id: rule.id },
        { $set: { last_executed_at: now, updated_at: Date.now() } },
      );
    const lastError =
      dispatched.status === 'fail' || dispatched.status === 'partial_fail'
        ? String(
            (dispatched.action_results as Array<{ error?: string }>).find((r) => r.error)?.error ??
              dispatched.status,
          )
        : undefined;
    await this.bumpRuleStatsDoc(rule, {
      matched: true,
      executed: true,
      error: lastError,
      at: Date.now(),
    });
    await this.emitFact(
      'automation.rule.executed',
      {
        rule_id: rule.id,
        execution_id: execution.execution_id,
        source: 'event',
        status: dispatched.status,
        trigger_event_name: event_name,
        trace_id: execution.trace_id,
        causation_id: execution.causation_id,
      },
      project_id,
      `rule/${rule.id}`,
      undefined,
      {
        traceId: execution.trace_id,
        causationId: execution.causation_id,
        parentDepth: envelope.depth,
      },
    );
  }

  /**
   * Reclaim executions stuck in `running` (FR-MAUT-15 recovery).
   *
   * The exactly-once claim inserts the execution row as `running` BEFORE
   * {@link ActionDispatcher.dispatch}. If the process dies (or the broker message
   * is lost) between the claim and the dispatch, the row stays `running` forever:
   * a redelivery hits the unique `idempotency_key` and skips (looks like a dup),
   * so the rule never actually runs and the DLQ retry — which only covers `failed`
   * — never sees it. This janitor pass finds `running` rows older than
   * `olderThanMs` and re-drives their dispatch so the claimed execution completes
   * exactly once (the claim already exists, so no second claim/effect race), then
   * records the real outcome. Returns the number of executions reclaimed.
   *
   * A stale row whose rule no longer exists (deleted) is closed out as `failed`
   * so it can no longer wedge — nothing to dispatch.
   */
  async reclaimStaleRunning(olderThanMs: number, limit = 50): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const stale = (await this.mongo
      .executions()
      .find({ status: 'running', created_at: { $lt: cutoff } })
      .sort({ created_at: 1 })
      .limit(limit)
      .toArray()) as unknown as Array<{
      execution_id: string;
      project_id: string;
      rule_id: string;
      payload_json?: string;
      trigger_event_name?: string;
    }>;
    let reclaimed = 0;
    for (const exec of stale) {
      try {
        await this.reclaimOne(exec);
        reclaimed += 1;
      } catch (error) {
        this.logger.warn(
          `Failed to reclaim stale execution ${exec.execution_id}: ${String(error)}`,
        );
      }
    }
    if (reclaimed > 0) {
      this.logger.log(`Reclaimed ${reclaimed} stale running execution(s)`);
    }
    return reclaimed;
  }

  /** Re-drive (or close out) a single stale `running` execution. */
  private async reclaimOne(exec: {
    execution_id: string;
    project_id: string;
    rule_id: string;
    payload_json?: string;
  }): Promise<void> {
    const rule = (await this.mongo
      .rules()
      .findOne({ project_id: exec.project_id, id: exec.rule_id })) as RuleDoc | null;
    if (!rule) {
      // Rule gone — nothing to dispatch; close the row so it stops wedging.
      await this.mongo.executions().updateOne(
        { execution_id: exec.execution_id, status: 'running' },
        { $set: { status: 'failed', finished_at: Date.now(), error: 'rule_deleted' } },
      );
      return;
    }
    const payload = this.parseJson(exec.payload_json ?? '{}');
    // v2 rules re-drive their graph instead of the flat list (TODO-040).
    const dispatched = await this.dispatchRule(rule, {
      projectId: exec.project_id,
      ruleId: exec.rule_id,
      ruleName: rule.name,
      executionId: exec.execution_id,
      source: 'event',
      payload,
      // Only the bus path ever leaves a row in `running` (a user-initiated run
      // inserts its execution already settled), so a re-drive is by construction
      // a re-drive of a SYSTEM run — see the `running`-claim in
      // `executeRuleForEvent`. It therefore keeps the s2s scope.
      actor: 'system',
      userId: '',
      entityType: this.triggerEntityType(rule),
      // Same execution id + generation 0 ⇒ the same effect key as the dispatch
      // that never finished, so a re-drive of an execution whose action DID land
      // before the crash is swallowed by the effect ledger instead of repeated.
    });
    // Only advance rows still `running` — a concurrent worker may have finished it.
    await this.mongo.executions().updateOne(
      { execution_id: exec.execution_id, status: 'running' },
      {
        $set: {
          status: dispatched.status,
          action_results_json: JSON.stringify(dispatched.action_results),
          finished_at: Date.now(),
          reclaimed: true,
          ...(dispatched.graph_path
            ? { graph_path_json: JSON.stringify(dispatched.graph_path) }
            : {}),
        },
      },
    );
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
  }

  private requireProjectId(project_id: string): void {
    if (!project_id?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'projectId is required' });
    }
  }

  // ── 3.6 SetRuleEnabled ──────────────────────────────────────────────────
  async setRuleEnabled(
    project_id: string,
    rule_id: string,
    enabled: boolean,
    actor_user_id?: string,
    can_manage?: boolean,
  ) {
    this.requireProjectId(project_id);
    const doc = (await this.mongo.rules().findOne({ project_id, id: rule_id })) as RuleDoc | null;
    if (!doc || doc.deleted_at || this.ruleState(doc) === 'deleted') {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
    }
    const actorId = (actor_user_id ?? '').trim();
    const isOwner = Boolean(actorId && doc.created_by === actorId);
    const manage = can_manage === true;
    if (!isOwner && !manage) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Rule toggle requires automation:manage or authorship',
      });
    }
    if (this.ruleState(doc) === 'frozen') {
      // A frozen rule (module disabled / project archived) cannot be toggled
      // manually — only Unfreeze re-enables it (§3.6).
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Правило заморожено (модуль выключен)',
      });
    }
    if (enabled) {
      // FR-AUTOM-260: enabling external-effect rules always requires manage,
      // even for the author — prevents create-disabled-under-write then enable bypass.
      if (this.ruleHasExternalEffect(doc) && !manage) {
        throw new RpcException({
          code: status.PERMISSION_DENIED,
          message: 'EXTERNAL_EFFECT_REQUIRES_MANAGE',
        });
      }
    }
    await this.mongo.rules().updateOne(
      { project_id, id: rule_id },
      { $set: { enabled, state: enabled ? 'enabled' : 'disabled', updated_at: Date.now() } },
    );
    await this.emitFact(
      'automation.rule.updated',
      { rule_id, enabled },
      project_id,
      `rule/${rule_id}`,
    );
    return this.getRule(project_id, rule_id);
  }

  // ── 3.8 ManualRun ───────────────────────────────────────────────────────
  async manualRun(
    project_id: string,
    rule_id: string,
    entity_type: string,
    entity_id: string,
    user_id?: string,
    visibility_scope?: string,
    inbound?: Metadata,
  ) {
    this.requireProjectId(project_id);
    if (!entity_id?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'entityId is required' });
    }
    if (!user_id?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'userId is required' });
    }
    const rule = (await this.mongo.rules().findOne({
      project_id,
      id: rule_id,
      enabled: true,
      ...this.runnableRuleFilter(),
    })) as RuleDoc | null;
    if (!rule) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Active rule not found' });
    }
    let snapshot: Record<string, unknown>;
    try {
      snapshot = await this.entitySnapshot.fetchRecord(
        project_id,
        entity_type,
        entity_id,
        user_id,
        inbound,
      );
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === status.NOT_FOUND) {
        throw new RpcException({ code: status.NOT_FOUND, message: 'Entity not found' });
      }
      if (code === status.INVALID_ARGUMENT) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: String((err as Error).message) });
      }
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Entity reader unavailable',
      });
    }
    const payload_json = JSON.stringify(snapshot);
    const exec = await this.executeRule(
      project_id,
      rule.id,
      'manual',
      payload_json,
      user_id,
      visibility_scope,
    );
    await this.mongo
      .executions()
      .updateOne(
        { execution_id: exec.execution_id },
        { $set: { entity_type: snapshot.entity_type ?? entity_type, entity_id } },
      );
    return { ...exec, entity_type: snapshot.entity_type ?? entity_type, entity_id };
  }

  // ── 3.9 DryRun ──────────────────────────────────────────────────────────
  async dryRun(
    project_id: string,
    rule_id: string,
    sample_json: string,
    last_n: number,
  ) {
    this.requireProjectId(project_id);
    const hasSample = !!sample_json && sample_json !== '{}' && sample_json !== '';
    const wantN = Number(last_n) || 0;
    if (hasSample && wantN > 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'sample and lastN are mutually exclusive',
      });
    }
    if (wantN > 50) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'lastN max is 50' });
    }
    const rule = (await this.mongo.rules().findOne({ project_id, id: rule_id })) as RuleDoc | null;
    if (!rule) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
    }

    const trigger = this.parseJson(rule.trigger_config_json);
    const triggerEvent = String(trigger.event_name ?? trigger.eventName ?? '').trim();
    const actionTypes = this.ruleActionTypes(rule);

    // Build the set of sample events to replay. SECURITY (§3.9): event-hooks
    // selection MUST be scoped to {project_id} — never leak other projects'
    // payloads. DryRun has NO external effects (dry_run:true): we never call
    // dispatch / write connections.
    type Sample = { event_name: string; payload: Record<string, unknown> };
    let samples: Sample[] = [];
    if (hasSample) {
      samples = [{ event_name: triggerEvent || 'sample', payload: this.parseJson(sample_json) }];
    } else if (wantN > 0) {
      const hooks = (await this.mongo
        .eventHooks()
        .find({ project_id })
        .sort({ created_at: -1 })
        .limit(wantN)
        .toArray()) as Array<{ event_name?: string; payload_json?: string }>;
      samples = hooks.map((h) => ({
        event_name: String(h.event_name ?? ''),
        payload: this.parseJson(String(h.payload_json ?? '{}')),
      }));
    } else {
      samples = [{ event_name: triggerEvent || 'sample', payload: {} }];
    }

    const conditionPredicate = compileConditions(rule.conditions_json ?? '[]');
    const results = samples.map((s) => {
      const matched = !triggerEvent || triggerEvent === s.event_name;
      // Compile rule.conditions into a safe predicate and evaluate against the
      // sample payload (audit #24.2). Conditions are only meaningful when the
      // trigger matched; no conditions == pass.
      const conditionsPassed = matched && conditionPredicate(s.payload ?? {});
      return {
        event_name: s.event_name,
        matched,
        conditions_passed: conditionsPassed,
        actions: actionTypes.map((type) => ({
          type,
          would_run: matched && conditionsPassed,
          reason: matched && conditionsPassed ? '' : 'conditions_not_met',
        })),
        dry_run: true,
      };
    });
    return { results };
  }

  // ── 3.10 ListExecutions (per rule) ──────────────────────────────────────
  async listExecutions(
    project_id: string,
    rule_id: string,
    page_index: number,
    page_size: number,
    statusFilter?: string,
  ) {
    this.requireProjectId(project_id);
    const rule = await this.mongo.rules().findOne({ project_id, id: rule_id });
    if (!rule) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Rule not found' });
    }
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const filter: Record<string, unknown> = { project_id, rule_id };
    if (statusFilter?.trim()) filter.status = statusFilter.trim();
    const total = await this.mongo.executions().countDocuments(filter);
    const rows = await this.mongo
      .executions()
      .find(filter)
      .sort({ created_at: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray();
    return { list: rows.map((r) => this.toExecution(r as Record<string, unknown>)), total };
  }

  // ── 3.11 ListProjectExecutions ──────────────────────────────────────────
  async listProjectExecutions(
    project_id: string,
    page_index: number,
    page_size: number,
    statusCsv?: string,
    action_type?: string,
    from?: number,
    to?: number,
    rule_id?: string,
    entity_type?: string,
    entity_id?: string,
  ) {
    // SECURITY (§3.11): this method scopes to a SINGLE x-project-id. There is no
    // "all projects" mode in the domain — org-level aggregation must be done by
    // the gateway/reports aggregator calling per-project with membership checks.
    this.requireProjectId(project_id);
    if (from != null && to != null && Number(from) > Number(to)) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'from must be <= to' });
    }
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const filter: Record<string, unknown> = { project_id };
    if (statusCsv?.trim()) {
      const list = statusCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) filter.status = { $in: list };
    }
    if (rule_id?.trim()) filter.rule_id = rule_id.trim();
    if (entity_type?.trim()) filter.entity_type = entity_type.trim();
    if (entity_id?.trim()) filter.entity_id = entity_id.trim();
    if (action_type?.trim()) filter.action_types = action_type.trim();
    if (from != null || to != null) {
      const range: Record<string, number> = {};
      if (from != null) range.$gte = Number(from);
      if (to != null) range.$lte = Number(to);
      filter.created_at = range;
    }
    const total = await this.mongo.executions().countDocuments(filter);
    const rows = await this.mongo
      .executions()
      .find(filter)
      .sort({ created_at: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray();
    return { list: rows.map((r) => this.toExecution(r as Record<string, unknown>)), total };
  }

  private toExecution(doc: Record<string, unknown>) {
    return {
      execution_id: String(doc.execution_id ?? ''),
      rule_id: String(doc.rule_id ?? ''),
      project_id: String(doc.project_id ?? ''),
      status: String(doc.status ?? ''),
      source: String(doc.source ?? ''),
      payload_json: String(doc.payload_json ?? '{}'),
      result_json: String(doc.result_json ?? '{}'),
      created_at: Number(doc.created_at ?? 0),
      skip_reason: String(doc.skip_reason ?? ''),
      trigger_event_name: String(doc.trigger_event_name ?? ''),
      entity_type: String(doc.entity_type ?? ''),
      entity_id: String(doc.entity_id ?? ''),
      idempotency_key: String(doc.idempotency_key ?? ''),
      trace_id: String(doc.trace_id ?? ''),
      causation_id: String(doc.causation_id ?? ''),
      action_results_json: String(doc.action_results_json ?? '[]'),
      dry_run: Boolean(doc.dry_run ?? false),
      finished_at: Number(doc.finished_at ?? 0),
      graph_path_json: String(doc.graph_path_json ?? ''),
    };
  }

  // ── 3.12 GetRegistry ────────────────────────────────────────────────────
  getRegistry(project_id: string, enabled_modules: string[]) {
    this.requireProjectId(project_id);
    // SECURITY (§3.12): the module filter comes from gateway metadata
    // (x-enabled-modules), never trusted from the client body. Items whose
    // requiredModule is outside the effective set are hidden. The registry
    // exposes only schemas — no secrets / URLs.
    const enabled = new Set((enabled_modules ?? []).map((m) => String(m)));
    const filterByModule = enabled.size > 0;
    const triggers = TRIGGER_CATALOG.filter(
      (t) => !filterByModule || enabled.has(t.requiredModule),
    ).map((t) => ({
      id: t.id,
      required_module: t.requiredModule,
      entity_type: t.entityType,
      event_name: t.eventName,
      config_schema_json: JSON.stringify(t.configSchema),
      output_schema_json: JSON.stringify(t.outputSchema),
    }));
    const actions = ACTION_CATALOG.filter(
      (a) => !filterByModule || enabled.has(a.requiredModule),
    )
      // Honesty filter (OQ-AUTOM-010): only offer actions that actually run —
      // ones with a wired executor, plus send_webhook (dispatched directly).
      // An action without an executor would be recorded `deferred` forever.
      .filter((a) => this.isActionAvailable(a.id))
      .map((a) => ({
        id: a.id,
        required_module: a.requiredModule,
        external_effect: a.externalEffect,
        config_schema_json: JSON.stringify(a.configSchema),
      }));
    return { triggers, actions };
  }

  /** True when the action can actually be dispatched (executor wired / webhook). */
  private isActionAvailable(actionId: string): boolean {
    return actionId === 'send_webhook' || this.executors.forAction(actionId) != null;
  }

  // ── automation-v2: ValidateGraph (no save) ──────────────────────────────
  /**
   * Static graph validation for the canvas (contract §2.3/§4). Runs the SAME
   * validator used on save — the domain is the single authority. No persistence,
   * no external effects. `valid=false` iff there is ≥1 error-severity issue.
   */
  validateGraph(
    project_id: string,
    graph: GraphSpec | null,
    canManage: boolean,
    enabledModules: string[] = [],
  ) {
    this.requireProjectId(project_id);
    if (!graph) {
      return {
        valid: false,
        issues: [
          { code: 'NO_NODES', node_id: '', edge_id: '', message: 'graph is empty', severity: 'error' },
        ],
      };
    }
    const raw = validateGraph(graph, { canManage, enabledModules });
    // Map internal {nodeId,edgeId} → wire {node_id,edge_id}.
    const issues = raw.map((i) => ({
      code: i.code,
      node_id: i.nodeId,
      edge_id: i.edgeId,
      message: i.message,
      severity: i.severity,
    }));
    return { valid: isGraphValid(raw), issues };
  }

  // ── automation-v2: GetNodeRegistry (canvas palette) ─────────────────────
  /**
   * Node-type catalog for the canvas palette (contract §2.3). Re-projects the
   * in-code trigger/action catalogs into NodeTypeDefs with derived out-handles +
   * the structural condition/branch types. Module filter comes from gateway-
   * trusted x-enabled-modules (SEC v1 §3.12), never the client body.
   */
  getNodeRegistry(project_id: string, enabled_modules: string[]) {
    this.requireProjectId(project_id);
    const enabled = new Set((enabled_modules ?? []).map((m) => String(m)));
    const filterByModule = enabled.size > 0;
    const toWire = (d: ReturnType<typeof triggerNodeTypes>[number]) => ({
      type: d.type,
      subtype: d.subtype,
      required_module: d.requiredModule,
      external_effect: d.externalEffect,
      entity_type: d.entityType,
      config_schema_json: JSON.stringify(d.configSchema),
      output_schema_json: JSON.stringify(d.outputSchema),
      out_handles: d.outHandles,
    });
    const triggers = triggerNodeTypes()
      .filter((d) => !filterByModule || enabled.has(d.requiredModule))
      .map(toWire);
    const actions = actionNodeTypes()
      .filter((d) => !filterByModule || enabled.has(d.requiredModule))
      // Same honesty filter as GetRegistry: hide executor-less actions (OQ-AUTOM-010).
      .filter((d) => this.isActionAvailable(d.subtype))
      .map(toWire);
    const structural = STRUCTURAL_NODE_TYPES.map(toWire);
    return { triggers, actions, structural };
  }

  // ── Connections (3.13–3.17) ─────────────────────────────────────────────
  /**
   * Seal a connection secret at rest (audit #24.1 / P2.d) via the configured
   * secret provider. Fail-closed: if the provider is unavailable (e.g. no local
   * encryption key) we reject the write with FAILED_PRECONDITION instead of
   * persisting plaintext, and log an error (never the secret). Returns the
   * `secret_ref` (+ optional `secret_enc`) exactly as they must be stored — for
   * the default local provider this is byte-for-byte the previous shape.
   */
  private async sealConnectionSecret(
    plaintext: string,
  ): Promise<{ secret_ref: string; secret_enc?: string }> {
    const provider = this.secrets.sealer();
    if (!provider.isAvailable()) {
      this.logger.error(
        'AUTOMATION_SECRET_KEY is not configured — refusing to store connection secret (fail-closed)',
      );
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'SECRET_ENCRYPTION_UNAVAILABLE',
      });
    }
    const sealed = await provider.seal(plaintext);
    return { secret_ref: sealed.secretRef, secret_enc: sealed.secretEnc };
  }

  private toConnection(doc: ConnectionDoc) {
    // SECURITY (§3.13): NEVER return secret_ref / plaintext secret. Only
    // secret_set: bool. headers values may carry tokens — mask values.
    const headers = this.parseJson(doc.headers_json ?? '{}');
    const maskedHeaders: Record<string, string> = {};
    for (const key of Object.keys(headers)) maskedHeaders[key] = '***';
    return {
      id: doc.id,
      project_id: doc.project_id,
      name: doc.name,
      url: doc.url,
      headers_json: JSON.stringify(maskedHeaders),
      enabled: doc.enabled,
      secret_set: !!doc.secret_ref,
      breaker_state: doc.breaker_state ?? 'closed',
      breaker_failures: doc.breaker_failures ?? 0,
      created_by: doc.created_by ?? '',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    };
  }

  async listConnections(project_id: string, page_index: number, page_size: number) {
    this.requireProjectId(project_id);
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const filter = { project_id };
    const total = await this.mongo.connections().countDocuments(filter);
    const rows = (await this.mongo
      .connections()
      .find(filter, { projection: { secret_enc: 0 } })
      .sort({ created_at: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray()) as ConnectionDoc[];
    return { list: rows.map((r) => this.toConnection(r)), total };
  }

  async getConnection(project_id: string, connection_id: string) {
    this.requireProjectId(project_id);
    const row = (await this.mongo
      .connections()
      .findOne({ project_id, id: connection_id }, { projection: { secret_enc: 0 } })) as
      | ConnectionDoc
      | null;
    if (!row) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Connection not found' });
    }
    return this.toConnection(row);
  }

  async createConnection(project_id: string, data: Record<string, unknown>) {
    this.requireProjectId(project_id);
    const name = String(data.name ?? '').trim();
    const url = String(data.url ?? '').trim();
    if (!name) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'name is required' });
    }
    if (!url) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'url is required' });
    }
    // SECURITY (§3.15): mandatory anti-SSRF gate — block non-https / private /
    // metadata / internal targets.
    const verdict = validateWebhookTarget(url);
    if (!verdict.ok) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'WEBHOOK_TARGET_INVALID',
        // surfaced as 409 WEBHOOK_TARGET_INVALID by gateway error mapping
        ...({ reason: verdict.reason } as object),
      });
    }
    const dup = await this.mongo.connections().findOne({ project_id, name });
    if (dup) {
      throw new RpcException({ code: status.ALREADY_EXISTS, message: 'Connection name already exists' });
    }
    const now = Date.now();
    // SECURITY (audit #24.1): the secret is encrypted at rest with AES-256-GCM
    // (see secret-crypto) and NEVER stored/logged in plaintext. Fail-closed:
    // if no encryption key is configured we refuse to accept a secret rather
    // than silently persisting it in the clear.
    const secretPlain = String(data.secret ?? '').trim();
    const hasSecret = !!secretPlain;
    const sealed = hasSecret ? await this.sealConnectionSecret(secretPlain) : undefined;
    const row: ConnectionDoc = {
      _id: new ObjectId(),
      id: newEntityId(),
      project_id,
      name,
      url,
      secret_ref: sealed?.secret_ref,
      secret_enc: sealed?.secret_enc,
      headers_json:
        data.headers_json != null ? String(data.headers_json) : JSON.stringify(data.headers ?? {}),
      enabled: data.enabled == null ? true : Boolean(data.enabled),
      breaker_state: 'closed',
      breaker_failures: 0,
      created_by: String(data.created_by ?? ''),
      created_at: now,
      updated_at: now,
    };
    await this.mongo.connections().insertOne(row);
    return this.toConnection(row);
  }

  async updateConnection(project_id: string, connection_id: string, data: Record<string, unknown>) {
    this.requireProjectId(project_id);
    const existing = (await this.mongo
      .connections()
      .findOne({ project_id, id: connection_id })) as ConnectionDoc | null;
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Connection not found' });
    }
    const set: Record<string, unknown> = { updated_at: Date.now() };
    if (data.name != null) {
      const name = String(data.name).trim();
      if (!name) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'name cannot be empty' });
      }
      if (name !== existing.name) {
        const dup = await this.mongo.connections().findOne({ project_id, name });
        if (dup) {
          throw new RpcException({ code: status.ALREADY_EXISTS, message: 'Connection name already exists' });
        }
      }
      set.name = name;
    }
    if (data.url != null) {
      const url = String(data.url).trim();
      // SECURITY (§3.16): url change re-runs the deny-list — no SSRF bypass via update.
      const verdict = validateWebhookTarget(url);
      if (!verdict.ok) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'WEBHOOK_TARGET_INVALID',
          ...({ reason: verdict.reason } as object),
        });
      }
      set.url = url;
    }
    if (data.headers_json != null) set.headers_json = String(data.headers_json);
    if (data.enabled != null) set.enabled = Boolean(data.enabled);
    const rotateSecret = String(data.secret ?? '').trim();
    if (rotateSecret) {
      // Rotate secret — re-seal at rest via the secret provider, never plaintext.
      const sealed = await this.sealConnectionSecret(rotateSecret);
      set.secret_enc = sealed.secret_enc;
      set.secret_ref = sealed.secret_ref;
    }
    if (data.reset_breaker === true) {
      set.breaker_state = 'closed';
      set.breaker_failures = 0;
      set.breaker_opened_at = 0;
    }
    await this.mongo.connections().updateOne({ project_id, id: connection_id }, { $set: set });
    return this.getConnection(project_id, connection_id);
  }

  async deleteConnection(project_id: string, connection_id: string) {
    this.requireProjectId(project_id);
    const existing = await this.mongo.connections().findOne({ project_id, id: connection_id });
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Connection not found' });
    }
    // SECURITY (§3.17): reference search scoped to {project_id}. Block deletion
    // when rules still reference this connection (CONNECTION_IN_USE).
    const referencing = (await this.mongo
      .rules()
      .find({ project_id })
      .toArray()) as RuleDoc[];
    const ruleIds = referencing
      .filter((r) => r.actions_json && r.actions_json.includes(connection_id))
      .map((r) => r.id);
    if (ruleIds.length) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'CONNECTION_IN_USE',
        ...({ ruleIds } as object),
      });
    }
    await this.mongo.connections().deleteOne({ project_id, id: connection_id });
    return {};
  }

  // ── DLQ (3.18–3.20) ─────────────────────────────────────────────────────
  private toDlq(doc: DlqDoc) {
    return {
      id: doc.id,
      project_id: doc.project_id,
      execution_id: doc.execution_id,
      rule_id: doc.rule_id,
      action_index: doc.action_index ?? 0,
      action_type: doc.action_type ?? '',
      connection_id: doc.connection_id ?? '',
      status: doc.status,
      attempts: doc.attempts ?? 0,
      last_error: doc.last_error ?? '',
      last_http_code: doc.last_http_code ?? 0,
      next_retry_at: doc.next_retry_at ?? 0,
      max_attempts: maxAttempts(doc),
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    };
  }

  async listDlq(project_id: string, page_index: number, page_size: number, statusFilter?: string) {
    this.requireProjectId(project_id);
    const limit = Math.max(1, Math.min(page_size || 25, 200));
    const filter: Record<string, unknown> = { project_id };
    if (statusFilter?.trim()) filter.status = statusFilter.trim();
    const total = await this.mongo.dlq().countDocuments(filter);
    const rows = (await this.mongo
      .dlq()
      .find(filter)
      .sort({ created_at: -1 })
      .skip(page_index * limit)
      .limit(limit)
      .toArray()) as DlqDoc[];
    const countRows = (await this.mongo
      .dlq()
      .aggregate([
        { $match: { project_id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray()) as Array<{ _id: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of countRows) counts[String(row._id)] = row.count;
    return { list: rows.map((r) => this.toDlq(r)), total, counts };
  }

  /**
   * Manual retry of one DLQ row (§3.19 / FR-AUTOM-175, TODO-041).
   *
   * The re-dispatch itself lives in {@link DlqRetryService} so the operator's
   * button and the background auto-retry sweeper share ONE code path — including
   * the fresh `payloadGen:sendGen` generation, without which the re-sent action
   * is indistinguishable from the delivery it retries and gets silently dropped
   * as a duplicate by the receiver.
   */
  async retryDlq(project_id: string, dlq_id: string) {
    this.requireProjectId(project_id);
    const doc = (await this.mongo.dlq().findOne({ project_id, id: dlq_id })) as DlqDoc | null;
    if (!doc) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'DLQ item not found' });
    }
    if (doc.status === 'dismissed' || doc.status === 'resolved') {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'Already processed' });
    }
    if (doc.status === 'retrying') {
      // A concurrent retry (human or sweeper) already claimed this item.
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'RETRY_IN_PROGRESS' });
    }
    if (doc.status === 'paused_module_disabled' || doc.status === 'paused_project_archived') {
      // §3.19: retry of a paused item is blocked until the module/project is active.
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: doc.status === 'paused_project_archived' ? 'PROJECT_ARCHIVED' : 'MODULE_DISABLED',
      });
    }
    if (!DLQ_MANUAL_RETRYABLE.has(doc.status)) {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'NOT_RETRYABLE' });
    }
    // SECURITY (§3.19): retry re-runs an external action from the service actor.
    // The atomic claim (status→retrying) guards against double external effects;
    // the dispatcher re-validates the connection deny-list + DNS at SEND time.
    const settled = await this.dlqRetry.retry(project_id, dlq_id, doc.status);
    if (!settled) {
      // Lost the claim race to another caller — surface as already-in-progress.
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'RETRY_IN_PROGRESS' });
    }
    return this.toDlq(settled as unknown as DlqDoc);
  }

  async dismissDlq(project_id: string, dlq_id: string, reason: string) {
    this.requireProjectId(project_id);
    const doc = (await this.mongo.dlq().findOne({ project_id, id: dlq_id })) as DlqDoc | null;
    if (!doc) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'DLQ item not found' });
    }
    if (doc.status === 'resolved') {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'Already processed' });
    }
    const now = Date.now();
    await this.mongo.dlq().updateOne(
      { project_id, id: dlq_id },
      { $set: { status: 'dismissed', last_error: reason || doc.last_error, updated_at: now } },
    );
    return this.toDlq({ ...doc, status: 'dismissed', updated_at: now });
  }

  // ── 3.22 FreezeRules (internal, control → automation) ───────────────────
  /**
   * Recompute `unexecutable` for all non-deleted rules after module set changes
   * (FR-AUTOM-060). Called from control when modules are enabled/disabled.
   */
  async reconcileRuleDependencies(project_id: string, enabled_modules: string[]) {
    this.requireProjectId(project_id);
    const now = Date.now();
    const rows = (await this.mongo
      .rules()
      .find({ project_id, ...this.notDeletedFilter() })
      .toArray()) as RuleDoc[];
    let updated = 0;
    for (const doc of rows) {
      if (doc.state === 'frozen' || doc.disabled_reason === 'actor_inactive') continue;
      const unexecutable = this.computeUnexecutable(doc, enabled_modules);
      if (Boolean(doc.unexecutable) === unexecutable) continue;
      const set: Record<string, unknown> = {
        unexecutable,
        updated_at: now,
      };
      if (unexecutable) {
        set.enabled = false;
        set.state = 'unexecutable';
      } else if (doc.state === 'unexecutable') {
        set.state = doc.enabled ? 'enabled' : 'disabled';
      }
      await this.mongo.rules().updateOne({ project_id, id: doc.id }, { $set: set });
      updated += 1;
    }
    return { updated_rules: updated };
  }

  /**
   * FR-AUTOM-105: when `created_by` leaves the project, disable their rules and
   * notify the responsible party (`notify_on_failure`).
   */
  async disableRulesForInactiveActor(project_id: string, actor_user_id: string) {
    this.requireProjectId(project_id);
    const userId = actor_user_id.trim();
    if (!userId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'actor_user_id required' });
    }
    const now = Date.now();
    const rules = (await this.mongo
      .rules()
      .find({
        project_id,
        created_by: userId,
        ...this.notDeletedFilter(),
        disabled_reason: { $ne: 'actor_inactive' },
      })
      .toArray()) as RuleDoc[];
    if (!rules.length) return { disabled_rules: 0 };
    await this.mongo.rules().updateMany(
      {
        project_id,
        created_by: userId,
        ...this.notDeletedFilter(),
      },
      {
        $set: {
          enabled: false,
          state: 'disabled',
          disabled_reason: 'actor_inactive',
          updated_at: now,
        },
      },
    );
    for (const rule of rules) {
      const notifyUser = String(rule.notify_on_failure ?? rule.created_by ?? '').trim();
      await this.emitFact(
        'automation.rule.updated',
        {
          rule_id: rule.id,
          rule_name: rule.name,
          enabled: false,
          disabled_reason: 'actor_inactive',
          created_by: userId,
          notify_user_id: notifyUser,
        },
        project_id,
        `rule/${rule.id}`,
      );
      if (notifyUser) {
        void this.operatorNotify.notify({
          projectId: project_id,
          userId: notifyUser,
          title: 'Правило автоматизации отключено',
          body: `Правило «${rule.name}» отключено: автор (${userId}) больше не активен в проекте.`,
          data: {
            rule_id: rule.id,
            disabled_reason: 'actor_inactive',
            created_by: userId,
          },
          idempotencyKey: `automation.rule.actor_inactive:${project_id}:${rule.id}`,
        });
      }
    }
    return { disabled_rules: rules.length };
  }

  async freezeRules(project_id: string, reason: string) {
    this.requireProjectId(project_id);
    if (reason !== 'module_disabled' && reason !== 'project_archived') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'unknown reason' });
    }
    const now = Date.now();
    // Freeze every non-frozen rule; DLQ retrying/failed → paused_* (§3.22).
    const frozen = await this.mongo.rules().updateMany(
      { project_id, state: { $ne: 'frozen' } },
      { $set: { state: 'frozen', updated_at: now } },
    );
    // Legacy rows without `state` (predate the field) — also freeze them.
    const frozenLegacy = await this.mongo.rules().updateMany(
      { project_id, state: { $exists: false } },
      { $set: { state: 'frozen', updated_at: now } },
    );
    const pausedStatus =
      reason === 'project_archived' ? 'paused_project_archived' : 'paused_module_disabled';
    const paused = await this.mongo.dlq().updateMany(
      { project_id, status: { $in: ['retrying', 'failed'] } },
      { $set: { status: pausedStatus, updated_at: now } },
    );
    await this.emitFact('automation.rule.frozen', { reason }, project_id);
    return {
      frozen_rules: (frozen.modifiedCount ?? 0) + (frozenLegacy.modifiedCount ?? 0),
      paused_dlq: paused.modifiedCount ?? 0,
    };
  }

  // ── 3.23 UnfreezeRules (internal, control → automation) ─────────────────
  async unfreezeRules(project_id: string, reason: string) {
    this.requireProjectId(project_id);
    if (reason !== 'module_enabled' && reason !== 'project_unarchived') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'unknown reason' });
    }
    const now = Date.now();
    // frozen → enabled. DLQ paused_* records are NOT auto-resumed (§3.23,
    // FR-MAUT-21): they remain for manual retry so re-enable does not fire a
    // burst of deferred external effects at once.
    const result = await this.mongo.rules().updateMany(
      { project_id, state: 'frozen', enabled: true },
      { $set: { state: 'enabled', updated_at: now } },
    );
    // Frozen rules that were disabled before freeze go back to `disabled`.
    await this.mongo.rules().updateMany(
      { project_id, state: 'frozen', enabled: false },
      { $set: { state: 'disabled', updated_at: now } },
    );
    await this.emitFact('automation.rule.unfrozen', { reason }, project_id);
    return { unfrozen_rules: result.modifiedCount ?? 0 };
  }

  /** FR-PLATFORM-115: apply DLQ fate after explicit resume-delivery. */
  async resumePausedDlq(project_id: string, dlq_fate: 'discard' | 'deliver') {
    this.requireProjectId(project_id);
    if (dlq_fate !== 'discard' && dlq_fate !== 'deliver') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'dlq_fate must be discard or deliver' });
    }
    const now = Date.now();
    const filter = { project_id, status: 'paused_module_disabled' };
    if (dlq_fate === 'discard') {
      const result = await this.mongo.dlq().updateMany(filter, {
        $set: { status: 'dismissed', dismiss_reason: 'resume_delivery_discard', updated_at: now },
      });
      return { processed: result.modifiedCount ?? 0 };
    }
    const result = await this.mongo.dlq().updateMany(filter, {
      $set: { status: 'failed', next_retry_at: now, updated_at: now },
    });
    return { processed: result.modifiedCount ?? 0 };
  }
}
