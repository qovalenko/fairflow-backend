import { status } from '@grpc/grpc-js';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  getProjectTemplate,
  projectRoleAtLeast,
  rpcInvalidArgument,
  type EmitIntent,
} from '@fairflow/shared';
import { ObjectId } from 'mongodb';
import {
  buildVisibilityFilter,
  buildDocumentVariablesResponse,
  evalGate,
  isRecordVisible,
  type AbacNode,
  type AccessPredicate,
  type DocumentVariablesResult,
  type VisibilityScope,
} from '@fairflow/shared';
import { createHash } from 'node:crypto';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { OrderSourceReaderService, type ProductForOrder } from './order-source-reader.service';
import {
  computeOrderDrift,
  entityDrifted,
  redactHiddenDiffs,
  type DriftResult,
  type SourceRead,
} from './order-drift';
import { OrdersDomainMetricsService } from './orders-domain-metrics.service';
import { OrderTypeSpecValidatorService } from './order-type-spec-validator.service';
import {
  collectFinalActionSpecViolations,
  collectDocumentTemplateSpecViolations,
} from './order-type-spec.validation';

const OWNER_FIELD = 'assigneeId';

/**
 * Sentinel stage id of the kanban "out of schema" column (TODO-413): cards whose
 * `stageId` belongs to a revision of the order type whose stage was later removed.
 * Deliberately not a valid stage id — moving a card INTO it is rejected upstream.
 */
export const KANBAN_ORPHAN_STAGE_ID = '__orphan__';

/**
 * When the kanban board is opened without an explicit `typeId`, pick a sensible
 * default among live order types. Template-provisioned types (e.g. b2b-sales
 * «Стандартная продажа») often appear first in natural Mongo order but stay
 * empty while legacy/demo types hold the real cards — returning `types[0]`
 * alone made the board look broken despite sales existing in the project.
 */
export function pickDefaultKanbanOrderType<T extends { id: string }>(
  types: T[],
  orderCountsByTypeId: ReadonlyMap<string, number>,
): T | undefined {
  if (!types.length) return undefined;
  return types.find((t) => (orderCountsByTypeId.get(String(t.id)) ?? 0) > 0) ?? types[0];
}

/** Order statuses that count as "active" for delete/aggregate guards (contract §1). */
const ACTIVE_STATUSES = ['ACTIVE', 'SENDING', 'SEND_ERROR'];

/**
 * Required document variables the order context always ships (documents §3.9:
 * `order.number`). Blank → `warnings.emptyRequired` on generate.
 */
export const ORDER_REQUIRED_VARIABLES = ['order.number'];

/**
 * Map an order (toOrder proto shape) to the flat document-variable map (documents
 * contract §4). The order owns its links, so it folds the denormalized
 * deal/contact/company names plus its custom order fields (`order.field.<key>`,
 * knows the order-type revision) into one map. Pure/no-IO → unit-testable.
 */
export function buildOrderDocumentVariables(
  order: Record<string, unknown>,
): DocumentVariablesResult {
  const values: Record<string, string> = {
    'order.number': String(order.number ?? ''),
    'order.typeName': String(order.type_name ?? ''),
    'order.stage': String(order.stage_name ?? ''),
    'order.status': String(order.status ?? ''),
    'deal.name': String(order.deal_name ?? ''),
    'contact.name': String(order.contact_name ?? ''),
    'company.name': String(order.company_name ?? ''),
  };
  // Custom order-type fields → `order.field.<key>` (orders knows the type revision).
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(order.fields_json ?? '{}'));
    if (parsed && typeof parsed === 'object') fields = parsed as Record<string, unknown>;
  } catch {
    fields = {};
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    values[`order.field.${k}`] = String(v);
  }
  return buildDocumentVariablesResponse(values, ORDER_REQUIRED_VARIABLES);
}

type FieldSpec = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  defaultValue?: string;
  validation?: { pattern?: string; min?: number; max?: number; minLen?: number; maxLen?: number };
  deprecated?: boolean;
};
type StageSpec = {
  id: string;
  name: string;
  order: number;
  requiredFieldKeys?: string[];
  isTerminal?: boolean;
};

/** Caller context resolved on the gateway and propagated via metadata. */
export interface OrdersActor {
  projectId: string;
  userId?: string;
  roles?: string[];
  scope?: VisibilityScope;
  /** Compiled ABAC predicate from `x-access-predicate` (RFC-ABAC §4, TODO-112). */
  access?: AccessPredicate;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /** Max cards materialised per kanban column (perf #13 — DB-side $limit). */
  private static readonly KANBAN_COLUMN_LIMIT = 50;

  /** Keyset page size of the reactive source-drift scan (bounded memory/event). */
  private static readonly SOURCE_DRIFT_BATCH = 200;

  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    private readonly sourceReader: OrderSourceReaderService,
    private readonly specValidator: OrderTypeSpecValidatorService,
    @Optional() private readonly domainMetrics?: OrdersDomainMetricsService,
  ) {}

  /**
   * Cross-domain read-only count of orders linked to a product (product.md §3.10,
   * product delete-guard / counter reconciliation). The `{projectId}` scope is the
   * unbreakable isolation boundary — a foreign projectId can never count another
   * tenant's orders (S7). Cancelled orders are excluded (not an active reference).
   */
  async countOrdersByProduct(projectId: string, productId: string): Promise<{ count: number }> {
    if (!projectId || !productId) return { count: 0 };
    const count = await this.mongo
      .orders()
      .countDocuments({ projectId, productId, status: { $ne: 'CANCELLED' } });
    return { count };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Provisioning
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Инстанцирует типы продаж проекта по шаблону (спека §6.2 / contract 3.19).
   * Идемпотентно: если у проекта уже есть типы продаж — ничего не делает.
   * TO-BE (WM2): создаёт неизменяемую ревизию v1 для каждого типа.
   */
  async provisionDefaults(projectId: string, templateId?: string) {
    if (!projectId) return { created: false, order_types: 0 };
    const count = await this.mongo.orderTypes().countDocuments({ projectId });
    if (count > 0) return { created: false, order_types: 0 };

    const template = getProjectTemplate(templateId);
    if (template.orderTypes.length === 0) return { created: false, order_types: 0 };

    const now = Date.now();
    for (const ot of template.orderTypes) {
      const typeId = new ObjectId().toString();
      const stages: StageSpec[] = ot.stages.map((s, order) => ({
        id: s.id,
        name: s.name,
        order,
        requiredFieldKeys: [],
        isTerminal: order === ot.stages.length - 1,
      }));
      const fields: FieldSpec[] = ot.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options,
      }));
      // Type + revision v1 + `crm.order_type.created` per type in one tx
      // (system provisioning; RFC-4 §Р-3 — listened by product/audit).
      await this.outbox.withOutbox(async (session) => {
        await this.mongo.orderTypes().insertOne(
          {
            _id: new ObjectId(),
            id: typeId,
            projectId,
            name: ot.name,
            description: '',
            currentVersion: 1,
            deletedAt: null,
            // AS-IS-compat fields (still read by toOrderType / legacy paths).
            schemaVersion: 1,
            webhookEnabled: false,
            fields,
            stages,
            createdAt: now,
            updatedAt: now,
          },
          session ? { session } : {},
        );
        await this.insertRevision(
          projectId,
          typeId,
          1,
          {
            name: ot.name,
            fields,
            stages,
            finalActionSpec: { type: 'none', config: {} },
            retryPolicy: {
              maxAttempts: 3,
              strategy: 'exponential',
              baseIntervalSec: 30,
              maxWaitSec: 3600,
            },
            documentTemplates: [],
          },
          undefined,
          session,
        );
        const intents: EmitIntent[] = [
          {
            type: 'crm.order_type.created',
            source: 'orders',
            projectId,
            subject: `order_type/${typeId}`,
            idempotencyKey: `order_type.created:${typeId}`,
            actorType: 'service',
            payload: { orderTypeId: typeId, name: ot.name, version: 1 },
          },
        ];
        return { result: undefined, intents };
      });
    }
    return { created: true, order_types: template.orderTypes.length };
  }

  /** Record ids shared with the viewer (resolved upstream), as ObjectIds. */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Order-type revisions (TO-BE)
  // ────────────────────────────────────────────────────────────────────────

  private async insertRevision(
    projectId: string,
    orderTypeId: string,
    version: number,
    spec: {
      name: string;
      description?: string;
      fields: FieldSpec[];
      stages: StageSpec[];
      finalActionSpec: unknown;
      retryPolicy: unknown;
      documentTemplates: unknown[];
    },
    createdBy?: string,
    session?: import('mongodb').ClientSession,
  ) {
    const terminal = spec.stages.find((s) => s.isTerminal);
    await this.mongo.orderTypeRevisions().insertOne(
      {
        _id: new ObjectId(),
        id: new ObjectId().toString(),
        projectId,
        orderTypeId,
        version,
        // TODO-418 / FR-ORDERS-050: черновиков ревизий (`status:'DRAFT'` + явная
        // публикация) НЕТ — каждое сохранение типа публикует новую версию. Это
        // не забытая ветка кода, а незакрытый продуктовый вопрос OQ-ORDERS-040
        // («нужны ли черновики или „сохранение = публикация“ и есть канон»).
        // Вводить DRAFT в домене до ответа владельца нельзя: без публикации в
        // gateway/UI это ровно тот класс дефекта, ради которого шла волна —
        // домен умеет, а до пользователя не доходит.
        status: 'PUBLISHED',
        fields: spec.fields,
        stages: spec.stages,
        finalActionSpec: spec.finalActionSpec,
        retryPolicy: spec.retryPolicy,
        documentTemplates: spec.documentTemplates,
        terminalStageId: terminal?.id ?? spec.stages[spec.stages.length - 1]?.id ?? '',
        createdAt: Date.now(),
        createdBy: createdBy ?? '',
      },
      session ? { session } : {},
    );
  }

  /** Validate a type spec against V1 invariants (contract 3.3 errors). */
  private async validateSpec(
    projectId: string,
    spec: {
      fields: FieldSpec[];
      stages: StageSpec[];
      finalActionSpec?: unknown;
      documentTemplates?: unknown;
    },
  ) {
    const violations: { field: string; reason: string }[] = [];
    const fields = spec.fields ?? [];
    const stages = spec.stages ?? [];
    const keys = new Set<string>();
    fields.forEach((f, i) => {
      if (keys.has(f.key)) violations.push({ field: `fields[${i}].key`, reason: 'duplicate_key' });
      keys.add(f.key);
    });
    if (stages.length === 0) {
      violations.push({ field: 'stages', reason: 'no_stages' });
    } else {
      const terminals = stages.filter((s) => s.isTerminal);
      if (terminals.length !== 1) {
        violations.push({ field: 'stages', reason: 'no_terminal_stage' });
      } else {
        const maxOrder = Math.max(...stages.map((s) => s.order));
        if (terminals[0].order !== maxOrder) {
          violations.push({ field: 'stages', reason: 'terminal_not_last' });
        }
      }
      stages.forEach((s, i) => {
        for (const k of s.requiredFieldKeys ?? []) {
          if (!keys.has(k)) {
            violations.push({ field: `stages[${i}].requiredFieldKeys`, reason: 'unknown_key' });
          }
        }
      });
    }
    collectFinalActionSpecViolations(spec.finalActionSpec, violations);
    collectDocumentTemplateSpecViolations(spec.documentTemplates, violations);
    if (violations.length) {
      throw rpcInvalidArgument('Некорректная спецификация типа продажи', {
        code: 'INVALID_ARGUMENT',
        violations,
      });
    }
    await this.specValidator.assertValid(projectId, spec);
  }

  private toRevisionResp(rev: Record<string, unknown> | null) {
    if (!rev) return undefined;
    return {
      version: Number(rev.version ?? 1),
      status: String(rev.status ?? 'PUBLISHED'),
      fields: this.fieldsResp((rev.fields as FieldSpec[]) ?? []),
      stages: this.stagesResp((rev.stages as StageSpec[]) ?? []),
      final_action_spec_json: JSON.stringify(rev.finalActionSpec ?? { type: 'none', config: {} }),
      retry_policy_json: JSON.stringify(rev.retryPolicy ?? {}),
      document_templates_json: JSON.stringify(rev.documentTemplates ?? []),
      terminal_stage_id: String(rev.terminalStageId ?? ''),
      created_at: Number(rev.createdAt ?? 0),
      created_by: String(rev.createdBy ?? ''),
    };
  }

  private fieldsResp(fields: FieldSpec[]) {
    return fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      options: f.options ?? [],
      default_value: f.defaultValue ?? '',
      validation_json: f.validation ? JSON.stringify(f.validation) : '',
      deprecated: !!f.deprecated,
    }));
  }

  private stagesResp(stages: StageSpec[]) {
    return stages.map((s) => ({
      id: s.id,
      name: s.name,
      order: s.order,
      required_field_keys: s.requiredFieldKeys ?? [],
      is_terminal: !!s.isTerminal,
    }));
  }

  private toOrderType(doc: Record<string, unknown>) {
    const stages = (doc.stages as StageSpec[]) ?? [];
    return {
      id: String(doc.id),
      name: String(doc.name),
      description: String(doc.description ?? ''),
      fields: this.fieldsResp((doc.fields as FieldSpec[]) ?? []),
      stages: this.stagesResp(stages),
      schema_version: Number(doc.schemaVersion ?? 1),
      webhook_enabled: !!doc.webhookEnabled,
      active_orders: 0,
      current_version: Number(doc.currentVersion ?? doc.schemaVersion ?? 1),
      deleted_at: Number(doc.deletedAt ?? 0),
    };
  }

  private async typeDetail(projectId: string, typeDoc: Record<string, unknown>, version?: number) {
    const v = version && version > 0 ? version : Number(typeDoc.currentVersion ?? 1);
    const found = await this.mongo
      .orderTypeRevisions()
      .findOne({ projectId, orderTypeId: String(typeDoc.id), version: v });
    let rev: Record<string, unknown> | null = found as Record<string, unknown> | null;
    if (!rev) {
      // Legacy type without revisions: synthesize from inline spec.
      rev = {
        version: v,
        status: 'PUBLISHED',
        fields: typeDoc.fields ?? [],
        stages: typeDoc.stages ?? [],
        finalActionSpec: { type: 'none', config: {} },
        retryPolicy: {},
        documentTemplates: [],
        terminalStageId: ((typeDoc.stages as StageSpec[]) ?? []).slice(-1)[0]?.id ?? '',
        createdAt: Number(typeDoc.createdAt ?? 0),
        createdBy: '',
      };
    }
    return {
      id: String(typeDoc.id),
      name: String(typeDoc.name),
      description: String(typeDoc.description ?? ''),
      current_version: Number(typeDoc.currentVersion ?? 1),
      deleted_at: Number(typeDoc.deletedAt ?? 0),
      revision: this.toRevisionResp(rev),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Order projection
  // ────────────────────────────────────────────────────────────────────────

  private toOrder(doc: Record<string, unknown>, typeName?: string, stageName?: string) {
    const fas = (doc.finalActionState as Record<string, unknown>) ?? {};
    return {
      id: (doc._id as ObjectId).toString(),
      number: String(doc.number ?? ''),
      type_id: String(doc.typeId),
      type_name: typeName ?? '',
      product_id: String(doc.productId ?? ''),
      product_name: String(doc.productName ?? ''),
      product_price: Number(doc.productPrice ?? 0),
      product_currency: String(doc.productCurrency ?? ''),
      product_unit: String(doc.productUnit ?? ''),
      product_category: String(doc.productCategory ?? ''),
      deal_id: String(doc.dealId ?? ''),
      deal_name: String(doc.dealName ?? ''),
      contact_id: String(doc.contactId ?? ''),
      contact_name: String(doc.contactName ?? ''),
      company_id: String(doc.companyId ?? ''),
      company_name: String(doc.companyName ?? ''),
      stage_id: String(doc.stageId),
      stage_name: stageName ?? '',
      assignee_id: String(doc.assigneeId ?? ''),
      assignee_name: String(doc.assigneeName ?? ''),
      fields_json: String(doc.fieldsJson ?? '{}'),
      notes: String(doc.notes ?? ''),
      status: String(doc.status ?? 'ACTIVE'),
      dlq_error: String(doc.dlqError ?? ''),
      created_at: Number(doc.createdAt),
      updated_at: Number(doc.updatedAt),
      order_type_version: Number(doc.orderTypeVersion ?? 0),
      stage_changed_at: Number(doc.stageChangedAt ?? doc.updatedAt ?? 0),
      created_by: String(doc.createdBy ?? ''),
      snapshot_json: doc.snapshot ? JSON.stringify(doc.snapshot) : '',
      has_drift: !!doc.hasDrift,
      final_action_state: {
        status: String(fas.status ?? 'IDLE'),
        idempotency_key: String(fas.idempotencyKey ?? ''),
        payload_gen: Number(fas.payloadGen ?? 1),
        attempts: ((fas.attempts as Record<string, unknown>[]) ?? []).map((a) => ({
          at: Number(a.at ?? 0),
          attempt_no: Number(a.attemptNo ?? 0),
          response_code: Number(a.responseCode ?? 0),
          error_body: String(a.errorBody ?? ''),
          duration_ms: Number(a.durationMs ?? 0),
        })),
        last_error: String(fas.lastError ?? ''),
        succeeded_at: Number(fas.succeededAt ?? 0),
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Order types — list / get / CRUD
  // ────────────────────────────────────────────────────────────────────────

  async listOrderTypes(projectId: string, includeDeleted = false) {
    const filter: Record<string, unknown> = { projectId };
    if (!includeDeleted) filter.deletedAt = { $in: [null, 0] };
    const rows = await this.mongo.orderTypes().find(filter).toArray();
    // active_orders = count of orders with active statuses per type (contract 3.1 B3).
    const counts = await this.mongo
      .orders()
      .aggregate([
        { $match: { projectId, status: { $in: ACTIVE_STATUSES } } },
        { $group: { _id: '$typeId', c: { $sum: 1 } } },
      ])
      .toArray();
    const countMap = new Map(counts.map((count) => [count._id, count.c]));
    return {
      list: rows.map((doc) => {
        const orderTypeDoc = doc as Record<string, unknown>;
        const orderType = this.toOrderType(orderTypeDoc);
        orderType.active_orders = Number(countMap.get(String(orderTypeDoc.id))) || 0;
        return orderType;
      }),
    };
  }

  async getOrderType(projectId: string, id: string, version?: number) {
    const doc = await this.mongo.orderTypes().findOne({ projectId, id });
    if (!doc) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Тип продажи не найден' });
    }
    const detail = await this.typeDetail(projectId, doc as Record<string, unknown>, version);
    if (!detail.revision) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Версия типа не найдена' });
    }
    return detail;
  }

  /**
   * Normalize an incoming field descriptor into the canonical camelCase
   * {@link FieldSpec}. The orders gRPC loader runs with `keepCase: true`, so the
   * gateway BFF sends `default_value` / `validation_json`, whereas provisioning
   * and legacy revisions store camelCase (`defaultValue` / `validation`). Accept
   * both so no shape is silently dropped (see be T-027 / T-011).
   */
  private normalizeField(raw: Record<string, unknown>): FieldSpec {
    let validation = raw.validation as FieldSpec['validation'] | undefined;
    if (!validation && typeof raw.validation_json === 'string' && raw.validation_json) {
      try {
        validation = JSON.parse(raw.validation_json) as FieldSpec['validation'];
      } catch {
        /* keep undefined */
      }
    }
    return {
      key: String(raw.key ?? ''),
      label: String(raw.label ?? ''),
      type: String(raw.type ?? ''),
      required: !!raw.required,
      options: Array.isArray(raw.options) ? (raw.options as string[]) : undefined,
      defaultValue:
        raw.defaultValue != null
          ? String(raw.defaultValue)
          : raw.default_value != null
            ? String(raw.default_value)
            : undefined,
      validation,
      deprecated: !!raw.deprecated,
    };
  }

  /**
   * Normalize an incoming stage descriptor into the canonical camelCase
   * {@link StageSpec}, accepting both `is_terminal`/`required_field_keys`
   * (gateway, keepCase) and `isTerminal`/`requiredFieldKeys` (provisioning /
   * legacy). Without this, `validateSpec` reads `undefined` for `isTerminal` and
   * every CreateOrderType fails with `no_terminal_stage` (T-027).
   */
  private normalizeStage(raw: Record<string, unknown>, index: number): StageSpec {
    const requiredFieldKeys = Array.isArray(raw.requiredFieldKeys)
      ? (raw.requiredFieldKeys as string[])
      : Array.isArray(raw.required_field_keys)
        ? (raw.required_field_keys as string[])
        : [];
    const isTerminal = raw.isTerminal !== undefined ? !!raw.isTerminal : !!raw.is_terminal;
    return {
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      order: typeof raw.order === 'number' ? raw.order : index,
      requiredFieldKeys,
      isTerminal,
    };
  }

  private parseSpec(spec: Record<string, unknown>) {
    const fields = (
      Array.isArray(spec.fields) ? (spec.fields as Record<string, unknown>[]) : []
    ).map((f) => this.normalizeField(f));
    const stages = (
      Array.isArray(spec.stages) ? (spec.stages as Record<string, unknown>[]) : []
    ).map((s, i) => this.normalizeStage(s, i));
    let finalActionSpec: unknown = { type: 'none', config: {} };
    let retryPolicy: unknown = {
      maxAttempts: 3,
      strategy: 'exponential',
      baseIntervalSec: 30,
      maxWaitSec: 3600,
    };
    let documentTemplates: unknown[] = [];
    try {
      if (spec.final_action_spec_json)
        finalActionSpec = JSON.parse(String(spec.final_action_spec_json));
    } catch {
      /* keep default */
    }
    try {
      if (spec.retry_policy_json) retryPolicy = JSON.parse(String(spec.retry_policy_json));
    } catch {
      /* keep default */
    }
    try {
      if (spec.document_templates_json)
        documentTemplates = JSON.parse(String(spec.document_templates_json));
    } catch {
      /* keep default */
    }
    return {
      name: String(spec.name ?? ''),
      description: String(spec.description ?? ''),
      fields,
      stages,
      finalActionSpec,
      retryPolicy,
      documentTemplates,
    };
  }

  async createOrderType(projectId: string, rawSpec: Record<string, unknown>, createdBy?: string) {
    const spec = this.parseSpec(rawSpec);
    if (!spec.name) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'name обязателен' });
    }
    await this.validateSpec(projectId, spec);
    const dup = await this.mongo
      .orderTypes()
      .findOne({ projectId, name: spec.name, deletedAt: { $in: [null, 0] } });
    if (dup) {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: JSON.stringify({ code: 'ALREADY_EXISTS', name: spec.name }),
      });
    }
    const now = Date.now();
    const typeId = new ObjectId().toString();
    // Type + revision v1 + `crm.order_type.created` row in one Mongo tx
    // (invariant Д-1; RFC-4 §Р-3 — listened by product/audit).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.orderTypes().insertOne(
        {
          _id: new ObjectId(),
          id: typeId,
          projectId,
          name: spec.name,
          description: spec.description,
          currentVersion: 1,
          deletedAt: null,
          schemaVersion: 1,
          webhookEnabled: spec.finalActionSpec
            ? (spec.finalActionSpec as { type?: string }).type === 'webhook'
            : false,
          // Per-type toggle for auto-creating a sale when a deal linked to this
          // type's product is won (BX-FLOW-2 / BOX-SALES-FLOW §3.5). Box default
          // is ON — the deal-won consumer treats absent/true as enabled and only
          // an explicit `false` opts out.
          autoCreateOnWon: true,
          fields: spec.fields,
          stages: spec.stages,
          createdAt: now,
          updatedAt: now,
        },
        session ? { session } : {},
      );
      await this.insertRevision(projectId, typeId, 1, spec, createdBy, session);
      const intents: EmitIntent[] = [
        {
          type: 'crm.order_type.created',
          source: 'orders',
          projectId,
          subject: `order_type/${typeId}`,
          idempotencyKey: `order_type.created:${typeId}`,
          userId: createdBy || undefined,
          actorType: createdBy ? 'user' : 'service',
          payload: { orderTypeId: typeId, name: spec.name, version: 1 },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrderType(projectId, typeId);
  }

  async updateOrderType(
    projectId: string,
    id: string,
    rawSpec: Record<string, unknown>,
    createdBy?: string,
  ) {
    const existing = await this.mongo.orderTypes().findOne({ projectId, id });
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Тип продажи не найден' });
    }
    const spec = this.parseSpec(rawSpec);
    if (!spec.name) spec.name = String(existing.name);
    await this.validateSpec(projectId, spec);
    const dup = await this.mongo
      .orderTypes()
      .findOne({ projectId, name: spec.name, deletedAt: { $in: [null, 0] }, id: { $ne: id } });
    if (dup) {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: JSON.stringify({ code: 'ALREADY_EXISTS', name: spec.name }),
      });
    }
    const nextVersion = Number(existing.currentVersion ?? 1) + 1;
    // New immutable revision + currentVersion bump + `crm.order_type.updated`
    // in one tx (RFC-4 §Р-3 — listened by product/audit).
    await this.outbox.withOutbox(async (session) => {
      await this.insertRevision(projectId, id, nextVersion, spec, createdBy, session);
      await this.mongo.orderTypes().updateOne(
        { projectId, id },
        {
          $set: {
            currentVersion: nextVersion,
            name: spec.name,
            description: spec.description,
            fields: spec.fields,
            stages: spec.stages,
            updatedAt: Date.now(),
          },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.order_type.updated',
          source: 'orders',
          projectId,
          subject: `order_type/${id}`,
          idempotencyKey: `order_type.updated:${id}:${nextVersion}`,
          userId: createdBy || undefined,
          actorType: createdBy ? 'user' : 'service',
          payload: { orderTypeId: id, version: nextVersion },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrderType(projectId, id);
  }

  async deleteOrderType(projectId: string, id: string) {
    const existing = await this.mongo.orderTypes().findOne({ projectId, id });
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Тип продажи не найден' });
    }
    const active = await this.mongo
      .orders()
      .countDocuments({ projectId, typeId: id, status: { $in: ACTIVE_STATUSES } });
    if (active > 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: JSON.stringify({
          code: 'ORDER_TYPE_HAS_ACTIVE_ORDERS',
          typeId: id,
          activeOrders: active,
        }),
      });
    }
    const now = Date.now();
    // Soft-delete + `crm.order_type.deleted` in one tx → products obnuljaet
    // Product.orderTypeId (FR-MORD-7; RFC-4 §Р-3 — listened by product/audit).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orderTypes()
        .updateOne(
          { projectId, id },
          { $set: { deletedAt: now, updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.order_type.deleted',
          source: 'orders',
          projectId,
          subject: `order_type/${id}`,
          idempotencyKey: `order_type.deleted:${id}`,
          actorType: 'user',
          payload: { orderTypeId: id },
        },
      ];
      return { result: undefined, intents };
    });
    return { id, deleted_at: now };
  }

  async restoreOrderType(projectId: string, id: string) {
    const existing = await this.mongo.orderTypes().findOne({ projectId, id });
    if (!existing) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Тип продажи не найден' });
    }
    // Restore + `crm.order_type.restored` (distinct restore fact, not a plain
    // `updated`) in one tx (RFC-4 §Р-3 — listened by product/audit;
    // be-ordertype-restored-key).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orderTypes()
        .updateOne(
          { projectId, id },
          { $set: { deletedAt: null, updatedAt: Date.now() } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.order_type.restored',
          source: 'orders',
          projectId,
          subject: `order_type/${id}`,
          idempotencyKey: `order_type.restored:${id}`,
          actorType: 'user',
          payload: { orderTypeId: id, restored: true },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrderType(projectId, id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Orders — list / kanban / get
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A malformed `x-access-predicate` is a BROKEN deny-rule → deny everything, never
   * silently widen (RFC-ABAC §4, fail-closed). This id can never equal a real order
   * `_id`, so ANDing it turns any filter into "matches nothing" without leaking
   * whether the record exists.
   */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Push the three-state ABAC predicate onto a read/list `$and` array (TODO-112,
   * mirrors the contact/product reference). The array already carries `{ projectId }`
   * so a deny stays project-scoped:
   *  - absent (`present:false`)     → no ABAC narrowing (project + visibility hold);
   *  - malformed (`malformed:true`) → fail-closed: force match-nothing;
   *  - present with `.mongo`        → AND the compiled fragment IN THE DB (never in
   *    memory — the predicate must be pushed down, invariant 4).
   */
  private applyAccess(and: Record<string, unknown>[], access?: AccessPredicate): void {
    if (access?.present && access.malformed) {
      and.push({ _id: OrdersService.DENY_ALL_ID });
      return;
    }
    if (access?.present && !access.malformed && access.mongo && Object.keys(access.mongo).length) {
      and.push(access.mongo);
    }
  }

  /**
   * Single-record ABAC gate — the `evalGate` half of the contract-equivalent pair
   * (RFC-ABAC §4). Used by `loadVisible`, so the WRITE gate is literally the same
   * gate as the read one (invariant 4): absent → pass; malformed → deny;
   * `.ir` → `evalGate`; a predicate that carries only `.mongo` passes here because
   * the fragment was already applied to the read filter.
   */
  private passesAccessGate(record: Record<string, unknown>, access?: AccessPredicate): boolean {
    if (!access || !access.present) return true;
    if (access.malformed) return false;
    if (!access.ir) return true;
    try {
      return evalGate(access.ir as AbacNode, record);
    } catch {
      return false;
    }
  }

  /** Resolve the order type whose columns the kanban board should render. */
  private async resolveKanbanOrderType(
    projectId: string,
    types: Record<string, unknown>[],
    typeId: string | undefined,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown> | undefined> {
    if (!types.length) return undefined;
    if (typeId) return types.find((t) => t.id === typeId);
    if (types.length === 1) return types[0];

    const typeIds = types.map((t) => String(t.id));
    const counts = await this.mongo
      .orders()
      .aggregate<{ _id: string; c: number }>([
        { $match: this.visAnd(scope, { projectId, typeId: { $in: typeIds } }, access) },
        { $group: { _id: '$typeId', c: { $sum: 1 } } },
      ])
      .toArray();
    const orderCountsByTypeId = new Map(counts.map((row) => [String(row._id), Number(row.c) || 0]));
    return pickDefaultKanbanOrderType(
      types as Array<{ id: string }>,
      orderCountsByTypeId,
    ) as Record<string, unknown>;
  }

  private visAnd(
    scope: VisibilityScope | undefined,
    base: Record<string, unknown>,
    access?: AccessPredicate,
  ) {
    const and: Record<string, unknown>[] = [base];
    const vis = buildVisibilityFilter<ObjectId>(scope, OWNER_FIELD, this.sharedObjectIds(scope));
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    return and.length === 1 ? and[0] : { $and: and };
  }

  async listOrders(
    projectId: string,
    pageIndex: number,
    pageSize: number,
    opts: {
      query?: string;
      dealId?: string;
      typeId?: string;
      statusFilter?: string;
      stageId?: string;
      staleDays?: number;
      contactId?: string;
      companyId?: string;
    } = {},
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const size = Math.min(Math.max(pageSize || 25, 1), 100);
    const base: Record<string, unknown> = { projectId };
    if (opts.dealId) base.dealId = opts.dealId;
    if (opts.contactId) base.contactId = opts.contactId;
    if (opts.companyId) base.companyId = opts.companyId;
    if (opts.typeId) base.typeId = opts.typeId;
    if (opts.statusFilter) base.status = opts.statusFilter;
    if (opts.stageId) base.stageId = opts.stageId;
    if (opts.staleDays && opts.staleDays > 0) {
      base.stageChangedAt = { $lt: Date.now() - opts.staleDays * 86400000 };
    }
    const q = opts.query?.trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      base.$or = [
        { number: rx },
        { 'snapshot.contact.name': rx },
        { 'snapshot.company.name': rx },
        { 'snapshot.company.inn': rx },
      ];
    }

    const filter = this.visAnd(scope, base, access);
    const total = await this.mongo.orders().countDocuments(filter);
    const rows = await this.mongo
      .orders()
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip(pageIndex * size)
      .limit(size)
      .toArray();
    const types = await this.mongo.orderTypes().find({ projectId }).toArray();
    const typesMap = new Map(
      types.map((type) => [type.id as string, type as Record<string, unknown>]),
    );

    return {
      list: rows.map((doc) => {
        const orderDoc = doc as Record<string, unknown>;
        const type = typesMap.get(String(orderDoc.typeId));
        const stage = (type?.stages as StageSpec[])?.find(
          (item) => item.id === String(orderDoc.stageId),
        );
        return this.toOrder(orderDoc, type?.name as string, stage?.name);
      }),
      total,
    };
  }

  async getKanban(
    projectId: string,
    typeId?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const types = await this.mongo
      .orderTypes()
      .find({ projectId, deletedAt: { $in: [null, 0] } })
      .toArray();
    const type = await this.resolveKanbanOrderType(projectId, types, typeId, scope, access);
    if (!type) return { type_id: '', stages: [], columns: [] };

    const stages = (type.stages as StageSpec[]) ?? [];

    // Perf (#13): don't stream every order of the type into memory. One aggregation
    // with a $facet per stage returns only the first N cards per column. The
    // {projectId}+visibility scope lives in $match, so tenant isolation stays
    // DB-enforced (S7). Response shape is unchanged (proto OrderKanbanColumn).
    const facet: Record<string, Record<string, unknown>[]> = {};
    stages.forEach((stage, i) => {
      // Positional facet key: stage ids are arbitrary strings and $facet keys may
      // not contain '.'/'$'; index keys are always valid and unique.
      facet[`c${i}`] = [
        { $match: { stageId: stage.id } },
        { $sort: { updatedAt: -1 } },
        { $limit: OrdersService.KANBAN_COLUMN_LIMIT },
      ];
    });
    // Orphan bucket (TODO-413): orders pinned to a stage of an OLDER type revision
    // that the current spec no longer contains. Without it those sales vanish from
    // the board entirely (they match no column) and there is no way to rescue them.
    facet.orphan = [
      { $match: { stageId: { $nin: stages.map((stage) => stage.id) } } },
      { $sort: { updatedAt: -1 } },
      { $limit: OrdersService.KANBAN_COLUMN_LIMIT },
    ];
    const [agg] = await this.mongo
      .orders()
      .aggregate<Record<string, unknown>>([
        { $match: this.visAnd(scope, { projectId, typeId: type.id }, access) },
        { $facet: facet },
      ])
      .toArray();
    const columns = stages.map((stage, i) => {
      const cards = (agg?.[`c${i}`] as Record<string, unknown>[]) ?? [];
      return {
        stage_id: stage.id,
        stage_name: stage.name,
        orders: cards.map((order) => this.toOrder(order, String(type.name), stage.name)),
      };
    });

    // The orphan column is appended ONLY when it holds something, so a healthy
    // board is byte-identical to before. Its sentinel stage id is not a real stage,
    // so a drop INTO it is refused by MoveOrderToStage ('Этап не найден') while
    // dragging a card OUT of it onto a live stage repairs the order.
    const orphanCards = (agg?.orphan as Record<string, unknown>[]) ?? [];
    if (orphanCards.length) {
      columns.push({
        stage_id: KANBAN_ORPHAN_STAGE_ID,
        stage_name: 'Вне схемы',
        orders: orphanCards.map((order) => this.toOrder(order, String(type.name), '')),
      });
    }

    return {
      type_id: String(type.id),
      stages: this.stagesResp(stages),
      columns,
    };
  }

  /**
   * Load an order document and gate it by visibility scope AND the ABAC predicate
   * (404-masking). Every mutation path goes through here, so the write gate is the
   * read gate (TODO-112 / invariant 4).
   */
  private async loadVisible(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(id)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Продажа не найдена' });
    }
    const and: Record<string, unknown>[] = [{ _id: new ObjectId(id), projectId }];
    this.applyAccess(and, access);
    const doc = await this.mongo.orders().findOne(and.length === 1 ? and[0] : { $and: and });
    if (!doc) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Продажа не найдена' });
    }
    if (
      !isRecordVisible(
        scope,
        (doc as Record<string, unknown>).assigneeId as string | undefined,
        scope?.sharedRecordIds.includes(id) ?? false,
      )
    ) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Продажа не найдена' });
    }
    // Re-check with the single-record gate so get is exactly the contract pair of
    // the list filter. Failing it is NOT_FOUND — never a leak of existence.
    if (!this.passesAccessGate(doc as Record<string, unknown>, access)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Продажа не найдена' });
    }
    return doc as Record<string, unknown>;
  }

  async getOrder(projectId: string, id: string, scope?: VisibilityScope, access?: AccessPredicate) {
    const doc = await this.loadVisible(projectId, id, scope, access);
    return this.projectOrder(projectId, doc);
  }

  /**
   * Document variable provider (documents contract §4). Reads the order scoped to
   * `projectId` AND the caller's visibility (`loadVisible` masks a cross-project or
   * invisible record as NOT_FOUND). Returns the flat `order.*`/`order.field.*`
   * variable map (the order owns its links + custom fields).
   *
   * No `AccessPredicate` parameter on purpose: the caller is the document-generation
   * route, whose gateway-compiled predicate belongs to the `documents` subject, not
   * to `orders` (see orders.grpc.controller.ts ResolveDocumentVariables).
   */
  async resolveDocumentVariables(
    projectId: string,
    recordId: string,
    scope?: VisibilityScope,
  ): Promise<DocumentVariablesResult> {
    const order = await this.getOrder(projectId, recordId, scope);
    const named = await this.withLinkNames(projectId, order as Record<string, unknown>, scope);
    return buildOrderDocumentVariables(named);
  }

  /**
   * FR-ORDERS-255: document generation path — drift-gate (V4) then emit
   * `crm.order.document_requested` with the resolved snapshot variables.
   */
  async requestOrderDocument(
    projectId: string,
    orderId: string,
    templateId: string,
    acceptDrift: boolean,
    scope?: VisibilityScope,
  ): Promise<DocumentVariablesResult> {
    const template = String(templateId ?? '').trim();
    if (!template) {
      throw rpcInvalidArgument('templateId обязателен', { code: 'INVALID_ARGUMENT' });
    }
    const current = await this.loadVisible(projectId, orderId, scope);
    await this.enforceDriftGate(projectId, current, acceptDrift, 'document', orderId);
    const projected = (await this.projectOrder(projectId, current)) as Record<string, unknown>;
    const named = await this.withLinkNames(projectId, projected, scope);
    const vars = buildOrderDocumentVariables(named);
    await this.outbox.withOutbox(async (_session) => {
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.document_requested',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.document_requested:${orderId}:${template}:${vars.source_hash}`,
          actorType: 'user',
          payload: {
            orderId,
            templateId: template,
            snapshotVars: vars.values,
          },
        },
      ];
      return { result: undefined, intents };
    });
    return vars;
  }

  /**
   * FR-ORDERS-135: create N independent sales from one deal (one per product row).
   * Partial success: per-item errors are collected, successful rows are kept.
   */
  async createOrdersBatch(
    data: Record<string, unknown>,
    actor: OrdersActor,
  ): Promise<{
    created: Record<string, unknown>[];
    errors: Array<{ index: number; code: string; message: string }>;
  }> {
    const dealId = String(data.deal_id ?? '').trim();
    if (!dealId) {
      throw rpcInvalidArgument('dealId обязателен для пакетного создания', {
        code: 'INVALID_ARGUMENT',
      });
    }
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (rawItems.length === 0) {
      throw rpcInvalidArgument('items не может быть пустым', { code: 'INVALID_ARGUMENT' });
    }
    const created: Record<string, unknown>[] = [];
    const errors: Array<{ index: number; code: string; message: string }> = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const item = (rawItems[index] ?? {}) as Record<string, unknown>;
      const productId = String(item.product_id ?? '').trim();
      if (!productId) {
        errors.push({ index, code: 'PRODUCT_REQUIRED', message: 'productId обязателен' });
        continue;
      }
      try {
        const order = await this.createOrder(
          {
            deal_id: dealId,
            contact_id: item.contact_id ?? data.contact_id,
            company_id: item.company_id ?? data.company_id,
            assignee_id: item.assignee_id ?? data.assignee_id,
            product_id: productId,
            order_type_id: item.order_type_id,
            fields_json: item.fields_json,
            notes: item.notes,
          },
          actor,
        );
        created.push(order);
      } catch (err) {
        const parsed = this.batchCreateError(err);
        errors.push({ index, ...parsed });
      }
    }
    return { created, errors };
  }

  private batchCreateError(err: unknown): { code: string; message: string } {
    if (err instanceof RpcException) {
      const e = err.getError() as { code?: number; message?: string };
      const raw = String(e.message ?? '');
      try {
        const body = JSON.parse(raw) as { code?: string; message?: string };
        if (body.code) {
          return { code: body.code, message: body.message ?? raw };
        }
      } catch {
        // fall through
      }
      return { code: 'CREATE_FAILED', message: raw || 'Не удалось создать продажу' };
    }
    return { code: 'CREATE_FAILED', message: String(err) };
  }

  /**
   * Shared drift-gate for terminal move and document generation (contract §3.11 / V4).
   */
  private async enforceDriftGate(
    projectId: string,
    current: Record<string, unknown>,
    acceptDrift: boolean,
    gate: 'terminal' | 'document',
    orderId: string,
  ): Promise<void> {
    const drift = await this.refreshDrift(projectId, current);
    const driftBlocks = drift.source_state === 'unknown' ? !!current.hasDrift : drift.has_drift;
    if (driftBlocks && !acceptDrift) {
      this.domainMetrics?.recordDriftGate(gate, 'blocked');
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: JSON.stringify({ code: 'DRIFT_NOT_ACCEPTED', orderId }),
      });
    }
    this.domainMetrics?.recordDriftGate(gate, 'passed');
  }

  /**
   * Fill the blank `deal_name`/`contact_name`/`company_name` of a projected order
   * before it becomes the document-variable map (TODO-207, tail of FR-ORDERS-460:
   * the domain never writes `*Name`, so these three variables always resolved to '').
   *
   * Why in the domain and not on the gateway: the BFF fills these names for the
   * list/kanban/card/CSV responses (`fillOrderNames`), but `ResolveDocumentVariables`
   * is proxied verbatim — the values AND their `source_hash` are built here
   * (`buildDocumentVariablesResponse`). A name injected above this layer would not
   * be covered by that hash, so a renamed contact could never raise document drift
   * (documents compares the stored hash with the freshly resolved one).
   *
   * Where each name comes from, in order:
   *  1. the denormalized `*_name` on the order, if the domain ever starts writing
   *     it — a non-empty value is never overwritten;
   *  2. the order's own pinned snapshot (`snapshot.contact.name` /
   *     `snapshot.company.name`) — the same field `searchOrders` already treats as
   *     the canonical order-side name (FR-ORDERS-420). A document must print
   *     CONFIRMED requisites, and a snapshot gone stale is exactly what `hasDrift` /
   *     «Принять изменения» exist to surface (FR-ORDERS-360/380);
   *  3. a live donor read for what has no snapshot at all (the deal) or whose
   *     snapshot stayed empty (order created while the donor was unreachable).
   *
   * The live read carries the CALLER's visibility scope, not the s2s `mode:'all'`
   * of the drift snapshot: a record the caller may not read stays unnamed, exactly
   * as in the BFF join. Fail-soft everywhere — a donor outage costs a name, never
   * the document.
   */
  private async withLinkNames(
    projectId: string,
    order: Record<string, unknown>,
    scope?: VisibilityScope,
  ): Promise<Record<string, unknown>> {
    const blank = (v: unknown) => !String(v ?? '').trim();
    if (!blank(order.deal_name) && !blank(order.contact_name) && !blank(order.company_name)) {
      return order;
    }
    const out = { ...order };

    // (2) pinned snapshot — no IO, already the "confirmed data" of this order.
    let snapshot: Record<string, { name?: string } | undefined> = {};
    try {
      const parsed = JSON.parse(String(order.snapshot_json ?? '{}')) as unknown;
      if (parsed && typeof parsed === 'object') {
        snapshot = parsed as Record<string, { name?: string } | undefined>;
      }
    } catch {
      snapshot = {};
    }
    if (blank(out.contact_name)) out.contact_name = String(snapshot.contact?.name ?? '').trim();
    if (blank(out.company_name)) out.company_name = String(snapshot.company?.name ?? '').trim();

    // (3) live donor reads for whatever is still unnamed. Parallel, bounded by the
    // reader's own timeout; each helper swallows its own faults.
    const dealId = String(order.deal_id ?? '').trim();
    const contactId = String(order.contact_id ?? '').trim();
    const companyId = String(order.company_id ?? '').trim();
    try {
      const [deal, contact, company] = await Promise.all([
        blank(out.deal_name) && dealId
          ? this.sourceReader.readDealName(projectId, dealId, scope)
          : '',
        blank(out.contact_name) && contactId
          ? this.sourceReader
              .readContact(projectId, contactId, scope)
              .then((r) => (r.state === 'present' ? (r.fields.name ?? '') : ''))
          : '',
        blank(out.company_name) && companyId
          ? this.sourceReader
              .readCompany(projectId, companyId, scope)
              .then((r) => (r.state === 'present' ? (r.fields.name ?? '') : ''))
          : '',
      ]);
      if (deal) out.deal_name = deal;
      if (contact) out.contact_name = contact;
      if (company) out.company_name = company;
    } catch (err) {
      // Defensive: the readers already fail-soft, so this only guards a wiring
      // fault (missing client). The document still gets every other variable.
      this.logger.warn(`document variables: link-name resolve failed: ${String(err)}`);
    }
    return out;
  }

  private async projectOrder(projectId: string, doc: Record<string, unknown>) {
    const type = await this.mongo.orderTypes().findOne({ projectId, id: String(doc.typeId) });
    const stage = (type?.stages as StageSpec[])?.find((item) => item.id === String(doc.stageId));
    return this.toOrder(doc, type?.name as string, stage?.name);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Orders — mutations
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Validate customFields against a revision's field specs (contract 3.9/3.10).
   * Returns the normalized object. Throws INVALID_ARGUMENT on failure.
   */
  private validateCustomFields(fields: FieldSpec[], values: Record<string, unknown>) {
    const errors: { field: string; reason: string }[] = [];
    for (const f of fields) {
      const v = values[f.key];
      const empty = v == null || v === '';
      if (f.required && empty) {
        errors.push({ field: f.key, reason: 'required' });
        continue;
      }
      if (empty) continue;
      if (f.validation?.pattern && typeof v === 'string') {
        try {
          if (!new RegExp(f.validation.pattern).test(v))
            errors.push({ field: f.key, reason: 'pattern' });
        } catch {
          /* invalid pattern in spec — ignore at value-validation time */
        }
      }
      if (f.type === 'SELECT' && f.options && f.options.length && typeof v === 'string') {
        if (!f.options.includes(v)) errors.push({ field: f.key, reason: 'option' });
      }
    }
    if (errors.length) {
      // Structured field errors ride in trailing metadata (штатный channel), not as
      // a JSON blob inside the status message (see rpcInvalidArgument).
      throw rpcInvalidArgument('Значения полей не прошли валидацию', {
        code: 'INVALID_ARGUMENT',
        errors,
      });
    }
  }

  private parseFields(json: unknown): Record<string, unknown> {
    if (json == null) return {};
    if (typeof json === 'object') return json as Record<string, unknown>;
    try {
      return JSON.parse(String(json)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Coerce product prefill scalars to the string form stored in `fieldsJson`. */
  private static prefillScalarsToStrings(
    prefill: Record<string, string | number | boolean>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(prefill)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
    return out;
  }

  async createOrder(data: Record<string, unknown>, actor: OrdersActor) {
    const projectId = actor.projectId;
    // Resolve type: explicit orderTypeId, else product's sale-type (FR-ORDERS-110),
    // else first non-deleted type.
    const types = await this.mongo
      .orderTypes()
      .find({ projectId, deletedAt: { $in: [null, 0] } })
      .toArray();
    let explicitTypeId = data.order_type_id ? String(data.order_type_id) : undefined;
    const productId = String(data.product_id ?? '').trim();
    let productCtx: ProductForOrder | null = null;
    if (productId) {
      productCtx = await this.sourceReader.readProductForOrder(projectId, productId);
      // FR-PRODUCTS-150: manual «create sale from product» must fail when the
      // catalog link is dangling or missing — no silent fallback to another type.
      if (!productCtx?.orderTypeId || productCtx.dangling) {
        // FR-PRODUCTS-150: ABORTED → HTTP 409. Message MUST be the bare machine
        // code: AppErrorFilter promotes /^[A-Z][A-Z0-9_]+$/ to envelope.code.
        // A JSON blob would fall through to statusToCode(409)=ALREADY_EXISTS
        // (auth copy: «email уже используется»).
        throw new RpcException({
          code: status.ABORTED,
          message: 'PRODUCT_ORDER_TYPE_DANGLING',
        });
      }
      if (!explicitTypeId) {
        explicitTypeId = productCtx.orderTypeId;
      }
    }
    const type = (explicitTypeId ? types.find((t) => t.id === explicitTypeId) : types[0]) as
      | Record<string, unknown>
      | undefined;
    if (explicitTypeId && !type) {
      // Could be soft-deleted — distinguish for a clearer error (V10).
      const deleted = await this.mongo.orderTypes().findOne({ projectId, id: explicitTypeId });
      if (deleted) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: JSON.stringify({ code: 'ORDER_TYPE_DELETED', typeId: explicitTypeId }),
        });
      }
      throw new RpcException({ code: status.NOT_FOUND, message: 'Тип продажи не найден' });
    }
    if (!type) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: JSON.stringify({ code: 'ORDER_TYPE_REQUIRED' }),
      });
    }

    const orderTypeVersion = Number(type.currentVersion ?? 1);
    const stages = (type.stages as StageSpec[]) ?? [];
    const firstStage = [...stages].sort((a, b) => a.order - b.order)[0];
    const stageId = firstStage?.id ?? 'os1';

    const customFieldsFromBody = this.parseFields(data.fields_json);
    // FR-PRODUCTS-170: product `prefill` seeds custom fields; explicit body values win
    // (BR-PRODUCTS-070 — order-type validation still applies to the merged set).
    const customFields = productCtx?.prefill
      ? {
          ...OrdersService.prefillScalarsToStrings(productCtx.prefill),
          ...customFieldsFromBody,
        }
      : customFieldsFromBody;
    const notes = data.notes != null ? String(data.notes) : '';
    // Validate against the pinned revision's spec.
    const rev = await this.mongo
      .orderTypeRevisions()
      .findOne({ projectId, orderTypeId: String(type.id), version: orderTypeVersion });
    const specFields = ((rev?.fields ?? type.fields) as FieldSpec[]) ?? [];
    this.validateCustomFields(specFields, customFields);

    const now = Date.now();
    // Atomic per-project sequence (A4): replaces `ORD-${Date.now()}`, which
    // collided under concurrency. Backed by the unique (projectId, number) index.
    const seq = await this.mongo.nextOrderNumber(projectId);
    const number = `ORD-${String(seq).padStart(5, '0')}`;
    const assigneeId = String(data.assignee_id ?? actor.userId ?? '');
    // Assignee-hierarchy gate (V11/FR-MORD-37, contract 3.9): the new owner must
    // be inside the actor's scope — else ASSIGNEE_OUT_OF_SCOPE (403). Checked
    // before any write so a cross-branch assignment never persists.
    this.assertAssigneeInScope(assigneeId, actor);
    // Snapshot capture (§3.9.3): pin the linked contact/company field values +
    // hashes into the order at create time, so the very first drift check of a
    // fresh order diffs against a real baseline (previously the empty snapshot
    // showed old='' for every field). Semantics are 1:1 with acceptDrift's
    // re-capture: `present` → fields, `deleted`/`unknown` → {}.
    //
    // Fail-soft: the order matters more than its snapshot. A source-reader
    // failure (readOrderSources reads over gRPC by projectId only) never blocks
    // the create — we fall back to the empty snapshot exactly as before and warn.
    //
    // IDOR §3.9.3 note: this reads the same fields drift already re-reads on
    // schedule, by projectId only (no visibility expansion). The actor-visibility
    // gate on the linked records is a SEPARATE concern not introduced here.
    const contactId = String(data.contact_id ?? '');
    const companyId = String(data.company_id ?? '');
    let contactFields: Record<string, string> = {};
    let companyFields: Record<string, string> = {};
    try {
      const { contactRead, companyRead } = await this.readOrderSources(projectId, {
        contactId,
        companyId,
      });
      contactFields = contactRead?.state === 'present' ? contactRead.fields : {};
      companyFields = companyRead?.state === 'present' ? companyRead.fields : {};
    } catch (err) {
      this.logger.warn(`createOrder snapshot capture failed (fail-soft to empty): ${String(err)}`);
    }
    const snapshot = {
      contact: contactFields,
      company: companyFields,
      capturedAt: now,
      contactSourceHash: this.hashFields(contactFields),
      companySourceHash: this.hashFields(companyFields),
    };

    const doc = {
      _id: new ObjectId(),
      projectId,
      typeId: String(type.id),
      orderTypeVersion,
      number,
      dealId: String(data.deal_id ?? ''),
      contactId: String(data.contact_id ?? ''),
      companyId: String(data.company_id ?? ''),
      // Catalog linkage (product.md §3.10 / §5.2): order → product so the product
      // domain can count orders per product and the delete-guard can scope by it.
      productId: String(data.product_id ?? ''),
      productName: productCtx?.name ?? '',
      productPrice: productCtx?.price ?? 0,
      productCurrency: productCtx?.currency ?? '',
      productUnit: productCtx?.unit ?? '',
      productCategory: productCtx?.category ?? '',
      assigneeId,
      stageId,
      stageChangedAt: now,
      snapshot,
      fieldsJson: JSON.stringify(customFields),
      notes,
      status: 'ACTIVE',
      hasDrift: false,
      finalActionState: { status: 'IDLE', payloadGen: 1, sendGen: 1, attempts: [] },
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId ?? '',
    };
    // Order insert + `crm.order.created` row in one Mongo tx — no order without
    // an event, no event without an order (invariant Д-1; RFC-4 §Р-3 — listened
    // by audit/search/automation/statistics).
    const created = await this.outbox.withOutbox(async (session) => {
      const result = await this.mongo.orders().insertOne(doc, session ? { session } : {});
      const orderId = result.insertedId.toString();
      const saved = await this.mongo
        .orders()
        .findOne({ _id: result.insertedId }, session ? { session } : {});
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.created',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.created:${orderId}`,
          userId: actor.userId || undefined,
          actorType: actor.userId ? 'user' : 'service',
          payload: {
            orderId,
            ownerId: assigneeId,
            productId: doc.productId,
            // TODO-051: flat denormalized number — the search projection reads
            // human-readable fields from the top level of the payload (FR-SEARCH-010).
            number: doc.number,
            after: {
              number: doc.number,
              typeId: doc.typeId,
              orderTypeVersion,
              dealId: doc.dealId,
              contactId: doc.contactId,
              companyId: doc.companyId,
              productId: doc.productId,
              assigneeId,
              stageId,
              status: doc.status,
            },
          },
        },
      ];
      return { result: saved, intents };
    });
    return this.projectOrder(projectId, created as Record<string, unknown>);
  }

  async updateOrder(
    projectId: string,
    id: string,
    data: Record<string, unknown>,
    actor: OrdersActor,
  ) {
    const scope = actor.scope;
    const current = await this.loadVisible(projectId, id, scope, actor.access);
    const updateSet: Record<string, unknown> = { updatedAt: Date.now() };

    if (data.fields_json != null) {
      const customFields = this.parseFields(data.fields_json);
      const rev = await this.mongo.orderTypeRevisions().findOne({
        projectId,
        orderTypeId: String(current.typeId),
        version: Number(current.orderTypeVersion ?? 1),
      });
      const type = await this.mongo.orderTypes().findOne({ projectId, id: String(current.typeId) });
      const specFields = ((rev?.fields ?? type?.fields) as FieldSpec[]) ?? [];
      this.validateCustomFields(specFields, customFields);
      updateSet.fieldsJson = JSON.stringify(customFields);
    }
    if (data.assignee_id != null) {
      // Assignee-hierarchy gate (V11, contract 3.10): re-owning an order is only
      // allowed within the actor's scope — else ASSIGNEE_OUT_OF_SCOPE (403).
      const nextAssignee = String(data.assignee_id);
      this.assertAssigneeInScope(nextAssignee, actor);
      updateSet.assigneeId = nextAssignee;
    }
    if (data.notes != null) {
      updateSet.notes = String(data.notes);
    }

    const update: Record<string, unknown> = { $set: updateSet };
    // In SEND_ERROR a field edit bumps payloadGen (contract 3.10 / FR-MORD-26).
    if (String(current.status) === 'SEND_ERROR' && data.fields_json != null) {
      update.$inc = { 'finalActionState.payloadGen': 1 };
    }
    // Update + `crm.order.updated {orderId, before?, after}` in one tx
    // (RFC-4 §Р-3 — listened by audit/search/automation).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orders()
        .updateOne({ _id: new ObjectId(id), projectId }, update, session ? { session } : {});
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (data.fields_json != null) {
        before.customFields = this.parseFields(current.fieldsJson);
        after.customFields = this.parseFields(updateSet.fieldsJson);
      }
      if (data.assignee_id != null) {
        before.assigneeId = String(current.assigneeId ?? '');
        after.assigneeId = String(updateSet.assigneeId);
      }
      if (data.notes != null) {
        before.notes = String(current.notes ?? '');
        after.notes = String(updateSet.notes);
      }
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.updated',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey: `order.updated:${id}:${updateSet.updatedAt}`,
          actorType: 'user',
          payload: { orderId: id, before, after },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrder(projectId, id, scope, actor.access);
  }

  async moveOrder(
    projectId: string,
    orderId: string,
    stageId: string,
    acceptDrift: boolean,
    scope?: VisibilityScope,
    enabledModules?: string[],
    access?: AccessPredicate,
  ) {
    const current = await this.loadVisible(projectId, orderId, scope, access);
    const type = await this.mongo.orderTypes().findOne({ projectId, id: String(current.typeId) });
    const rev = await this.mongo.orderTypeRevisions().findOne({
      projectId,
      orderTypeId: String(current.typeId),
      version: Number(current.orderTypeVersion ?? 1),
    });
    const stages = ((rev?.stages ?? type?.stages) as StageSpec[]) ?? [];
    const fromStage = stages.find((s) => s.id === String(current.stageId));
    const toStage = stages.find((s) => s.id === stageId);
    if (!toStage) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Этап не найден' });
    }

    // Required-field gate on the stage we are leaving (contract 3.11 / V3).
    const customFields = this.parseFields(current.fieldsJson);
    const missing = (fromStage?.requiredFieldKeys ?? []).filter(
      (k) => customFields[k] == null || customFields[k] === '',
    );
    if (missing.length) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: JSON.stringify({ code: 'REQUIRED_FIELDS_MISSING', missing }),
      });
    }

    const now = Date.now();
    const fromStatus = String(current.status);
    const set: Record<string, unknown> = {
      stageId,
      stageChangedAt: now,
      updatedAt: now,
    };

    const finalActionSpec = (rev?.finalActionSpec as { type?: string; config?: unknown }) ?? {
      type: 'none',
    };
    const retryPolicy = rev?.retryPolicy ?? null;
    const hasAction = !!finalActionSpec.type && finalActionSpec.type !== 'none';

    // Events to emit alongside the stage move (RFC-4 §Р-3). The stage_changed
    // emit is always present; terminal transitions add status_changed and (when
    // there is a final action) final_action_requested.
    const intents: EmitIntent[] = [];

    if (toStage.isTerminal) {
      if (!hasAction) {
        set.status = 'DONE';
        intents.push({
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.status_changed:${orderId}:${fromStatus}:DONE`,
          actorType: 'user',
          payload: { orderId, from: fromStatus, to: 'DONE' },
        });
      } else {
        // Repeat-terminal-entry guard (review MINOR): once the final-action
        // pipeline has been engaged (SENDING / SEND_ERROR / DONE) the current
        // sendGen key is — or is about to be — terminally claimed on the
        // automation side, so republishing it from here would be silently
        // dedupped and the order would sit in a FALSE SENDING until the
        // watchdog stamps a misleading "final_action_timeout". Bumping the
        // generation here instead is NOT an option: from SENDING a fresh key
        // would orphan the real in-flight answer (exact-key filter skips it)
        // and could execute the action twice; from DONE it would re-run an
        // already-executed business action off a stage-move gesture; and
        // SEND_ERROR already has the dedicated manager-gated resend with a
        // fresh sendGen — RetryFinalAction. So MoveOrder refuses and points
        // the caller at the one legitimate resend path.
        if (fromStatus === 'SENDING' || fromStatus === 'SEND_ERROR' || fromStatus === 'DONE') {
          throw new RpcException({
            code: status.FAILED_PRECONDITION,
            message: JSON.stringify({
              code: 'FINAL_ACTION_ALREADY_TRIGGERED',
              status: fromStatus,
              orderId,
              ...(fromStatus === 'SEND_ERROR' ? { retry: 'RetryFinalAction' } : {}),
            }),
          });
        }
        // Executor-availability gate (FR-ORDERS-270/330): the final action is
        // executed by the `automation` domain. When the gateway-resolved
        // effective module set says `automation` is DISABLED for this project,
        // the transition is REFUSED with an explicit error instead of parking
        // the order in SENDING (nobody would ever answer) or silently skipping
        // a configured business action (an ERP never notified but the sale
        // marked DONE). Metadata absent (trusted s2s caller) → fail-open; the
        // automation-side freeze then still answers with `_failed`, so the
        // order lands in SEND_ERROR with a readable lastError, never stuck.
        if (enabledModules && !enabledModules.includes('automation')) {
          throw new RpcException({
            code: status.FAILED_PRECONDITION,
            message: JSON.stringify({
              code: 'FINAL_ACTION_EXECUTOR_UNAVAILABLE',
              reason: 'automation_module_disabled',
              orderId,
            }),
          });
        }
        // Drift gate before terminal with an action (contract 3.11 / V4).
        await this.enforceDriftGate(projectId, current, acceptDrift, 'terminal', orderId);
        set.status = 'SENDING';
        const fas = (current.finalActionState as Record<string, unknown>) ?? {};
        const payloadGen = Number(fas.payloadGen ?? 1);
        // sendGen = "send attempt generation": bumped on every RetryFinalAction so
        // each user-initiated (re)send is a NEW attempt for the automation-side
        // claim, while a broker redelivery of the SAME send keeps the same key
        // and is still dedupped (review BLOCKER: a reused key wedged retries).
        const sendGen = Number(fas.sendGen ?? 1);
        const idempotencyKey = `${orderId}:${Number(current.orderTypeVersion ?? 1)}:${
          finalActionSpec.type
        }:${payloadGen}:${sendGen}`;
        set['finalActionState.status'] = 'PENDING';
        set['finalActionState.idempotencyKey'] = idempotencyKey;
        set['finalActionState.sendGen'] = sendGen;
        // final_action_requested carries the snapshot (PII egress; §3.11 SECURITY)
        // — its idempotencyKey dedups duplicate terminal sends (RFC-4 §Р-4).
        intents.push({
          type: 'crm.order.final_action_requested',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey,
          actorType: 'user',
          payload: {
            orderId,
            actionId: finalActionSpec.type,
            idempotencyKey,
            retryPolicy,
            // Full spec (type + config): the automation executor resolves the
            // webhook connection / task template from it (FR-ORDERS-270).
            spec: finalActionSpec,
            assigneeId: String(current.assigneeId ?? ''),
            payload: { snapshot: current.snapshot ?? {} },
          },
        });
        this.domainMetrics?.recordFinalAction('requested');
        intents.push({
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.status_changed:${orderId}:${fromStatus}:SENDING`,
          actorType: 'user',
          payload: { orderId, from: fromStatus, to: 'SENDING' },
        });
      }
    }

    // stage_changed is always emitted (FR-MORD-16; RFC-4 §Р-3).
    intents.push({
      type: 'crm.order.stage_changed',
      source: 'orders',
      projectId,
      subject: `order/${orderId}`,
      idempotencyKey: `order.stage_changed:${orderId}:${stageId}:${now}`,
      actorType: 'user',
      payload: {
        orderId,
        fromStageId: String(current.stageId ?? ''),
        toStageId: stageId,
        enteredAt: now,
        assigneeId: String(current.assigneeId ?? ''),
        typeId: String(current.typeId ?? ''),
        orderTypeVersion: Number(current.orderTypeVersion ?? 1),
      },
    });

    // Move + all events in one Mongo tx — the terminal final-action send and its
    // stage/status events commit together with the order update (invariant Д-1).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orders()
        .updateOne(
          { _id: new ObjectId(orderId), projectId },
          { $set: set },
          session ? { session } : {},
        );
      return { result: undefined, intents };
    });
    return this.getOrder(projectId, orderId, scope);
  }

  async cancelOrder(
    projectId: string,
    id: string,
    reason: string | undefined,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const current = await this.loadVisible(projectId, id, scope, access);
    const st = String(current.status);
    // SENDING is NOT cancellable (FR-MORD-29): the final-action worker
    // (automation `crm.order.final_action_requested` consumer) is live, so an
    // in-flight delivery must never be cancelled under it — the saga always
    // resolves SENDING → DONE | SEND_ERROR, and SEND_ERROR is cancellable.
    // (The TODO-048 interim escape hatch that allowed cancelling SENDING is
    // removed together with the worker landing.)
    if (!['ACTIVE', 'SEND_ERROR'].includes(st)) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: JSON.stringify({ code: 'ORDER_NOT_CANCELLABLE', status: st }),
      });
    }
    // Cancel + `crm.order.cancelled` + `crm.order.status_changed` in one tx
    // (RFC-4 §Р-3 — listened by notification/audit/statistics/automation).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orders()
        .updateOne(
          { _id: new ObjectId(id), projectId },
          { $set: { status: 'CANCELLED', cancelReason: reason ?? '', updatedAt: Date.now() } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.cancelled',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey: `order.cancelled:${id}`,
          actorType: 'user',
          // productId is the counter fact of this event, not decoration: the
          // authoritative order-per-product number is `countOrdersByProduct`,
          // which counts `status != CANCELLED`. So a cancel IS a decrement of
          // product.ordersCount, and the consumer can only apply it if the
          // envelope names the product (crm.order.created carries it symmetrically).
          // Without it the incremental counter can never converge with the
          // RecountProductUsage reconciliation. (TODO-446, product-side consumer.)
          payload: {
            orderId: id,
            productId: String(current.productId ?? '') || undefined,
            reason: reason ?? undefined,
          },
        },
        {
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey: `order.status_changed:${id}:${st}:CANCELLED`,
          actorType: 'user',
          payload: { orderId: id, from: st, to: 'CANCELLED' },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrder(projectId, id, scope);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Drift
  // ────────────────────────────────────────────────────────────────────────

  /** One donor read (system scope) — entity-agnostic wrapper over the reader. */
  private readSource(
    entity: 'contact' | 'company',
    projectId: string,
    id: string,
    scope?: VisibilityScope,
  ): Promise<SourceRead> {
    return entity === 'contact'
      ? this.sourceReader.readContact(projectId, id, scope)
      : this.sourceReader.readCompany(projectId, id, scope);
  }

  /**
   * Read one donor AND decide whether the CALLER may see it (review: PII egress).
   *
   * Without a `viewer` this is the plain system read: the drift snapshot is a
   * system job (create-time capture, reactive marking, the terminal gate) with no
   * end-user actor, and it must observe the FULL picture — a donor hidden from
   * some user has still really drifted.
   *
   * With a `viewer` we additionally need to know whether that user may read the
   * donor, and a single scoped read cannot tell us: the donor answers NOT_FOUND
   * both for a deleted record and for one the viewer may not see (donors mask,
   * they do not distinguish). So:
   *  1. read as the VIEWER — `present` means visible, and it is the same record
   *     the system read would return, so no second call in the common case;
   *  2. only when that read is NOT_FOUND, re-read as the SYSTEM to disambiguate:
   *     the record still exists → it is alive but invisible to this caller
   *     (`visible:false`, its live values must not leave the domain); the system
   *     also sees nothing → genuinely deleted (`visible:true` — the diffs then
   *     carry only the order's own snapshot values with `new:''`).
   * A viewer read that times out (`unknown`) is left alone: the whole check
   * collapses to `unknown` anyway and there is nothing to redact.
   *
   * Invariant: the returned `read` always carries the SYSTEM view of the donor —
   * a scoped read is reused only when it returned the record itself (donors mask
   * whole records, never individual fields, so its content is identical). The
   * drift VERDICT therefore never depends on who asked; only the payload does.
   */
  private async readSourceFor(
    entity: 'contact' | 'company',
    projectId: string,
    id: string,
    viewer?: VisibilityScope,
  ): Promise<{ read: SourceRead; visible: boolean }> {
    if (!viewer) return { read: await this.readSource(entity, projectId, id), visible: true };
    const seen = await this.readSource(entity, projectId, id, viewer);
    if (seen.state !== 'deleted') return { read: seen, visible: true };
    const system = await this.readSource(entity, projectId, id);
    return { read: system, visible: system.state !== 'present' };
  }

  /**
   * Read the current contact/company requisites for an order in parallel (only
   * for the entities the order actually links). Fail-soft: a linked-but-absent
   * read is `unknown`; an unlinked entity yields `undefined` (not compared).
   *
   * `viewer` — the scope of the END USER on whose behalf the values will be
   * RETURNED (CheckDrift). It never changes what is compared, only which donors
   * end up in `hidden`, i.e. whose live values must be stripped from the response
   * (see {@link readSourceFor} and `redactHiddenDiffs`). System callers
   * (create-time capture, accept re-capture, the terminal gate, the reactive
   * marker) pass nothing and get the full picture, as before.
   */
  private async readOrderSources(
    projectId: string,
    doc: Record<string, unknown>,
    viewer?: VisibilityScope,
  ): Promise<{
    contactId: string;
    companyId: string;
    contactRead?: SourceRead;
    companyRead?: SourceRead;
    hidden: Array<'contact' | 'company'>;
  }> {
    const contactId = String(doc.contactId ?? '');
    const companyId = String(doc.companyId ?? '');
    const [contact, company] = await Promise.all([
      contactId
        ? this.readSourceFor('contact', projectId, contactId, viewer)
        : Promise.resolve(undefined),
      companyId
        ? this.readSourceFor('company', projectId, companyId, viewer)
        : Promise.resolve(undefined),
    ]);
    const hidden: Array<'contact' | 'company'> = [];
    if (contact && !contact.visible) hidden.push('contact');
    if (company && !company.visible) hidden.push('company');
    return {
      contactId,
      companyId,
      contactRead: contact?.read,
      companyRead: company?.read,
      hidden,
    };
  }

  /** Deterministic hash of a snapshot field set (stored for quick source-equality). */
  private hashFields(fields: Record<string, string>): string {
    const keys = Object.keys(fields).sort();
    const canonical = keys.map((k) => `${k}=${fields[k] ?? ''}`).join('\n');
    return canonical ? createHash('sha256').update(canonical).digest('hex') : '';
  }

  /**
   * Recompute the drift of a loaded order against the CURRENT source values and
   * persist the resulting `hasDrift` flag (TODO-213).
   *
   * Before this, `hasDrift` was only ever written as `false` (create / accept), so
   * the terminal-transition gate and the card banner — both driven by the stored
   * flag — were dead. Persisting here is what makes the stored flag true.
   *
   * Fail-soft is preserved verbatim: `source_state:'unknown'` (a donor was
   * unreachable) NEVER writes the flag in either direction — we neither raise a
   * banner the user cannot resolve nor clear a drift we could not re-verify. A
   * read that blows up unexpectedly degrades to the stored flag.
   * `updatedAt` is deliberately untouched: a read must not reorder the list.
   *
   * `viewer` (review: PII egress) — set ONLY when the result is handed back to an
   * end user (`checkDrift`). The verdict stays system-wide either way; what the
   * viewer controls is the payload: the live requisites of a donor this caller may
   * not read are stripped from `diffs`, so a user who sees the order but not its
   * contact gets `has_drift:true` and no phone/e-mail. Passing the viewer's scope
   * into the COMPARISON instead would have been the bug it looks like a fix for:
   * an invisible-but-alive donor answers NOT_FOUND, which reads as «source
   * deleted» → a false `hasDrift:true` persisted for everyone and an order wedged
   * out of its terminal transition (the gate below reads the very same flag).
   */
  private async refreshDrift(
    projectId: string,
    doc: Record<string, unknown>,
    viewer?: VisibilityScope,
  ): Promise<DriftResult> {
    let result: DriftResult;
    let hidden: Array<'contact' | 'company'>;
    try {
      const sources = await this.readOrderSources(projectId, doc, viewer);
      const { contactId, companyId, contactRead, companyRead } = sources;
      hidden = sources.hidden;
      result = computeOrderDrift({
        contactId,
        companyId,
        snapshot: doc.snapshot as {
          contact?: Record<string, unknown>;
          company?: Record<string, unknown>;
        } | null,
        contactRead,
        companyRead,
      });
    } catch (err) {
      this.logger.warn(`drift recompute failed (fail-soft to stored flag): ${String(err)}`);
      return { has_drift: !!doc.hasDrift, source_state: 'unknown', diffs: [] };
    }
    if (result.source_state !== 'unknown' && !!doc.hasDrift !== result.has_drift) {
      await this.mongo
        .orders()
        .updateOne(
          { _id: doc._id as ObjectId, projectId },
          { $set: { hasDrift: result.has_drift } },
        )
        .catch((err: unknown) => {
          this.logger.warn(`hasDrift persist failed: ${String(err)}`);
          return undefined;
        });
      doc.hasDrift = result.has_drift;
    }
    // Persist first, redact after: the stored flag is the honest system verdict,
    // the RESPONSE is what gets trimmed to the caller's visibility.
    return redactHiddenDiffs(result, hidden);
  }

  /**
   * Reactive drift marking (FR-ORDERS-390 / TODO-213): a linked contact or company
   * changed (or was deleted) → raise `hasDrift` on every OPEN order of that project
   * whose snapshot now diverges from it. Driven by the bus consumer, so the card
   * banner and the terminal-transition gate light up without anyone first opening
   * the order and calling CheckDrift.
   *
   * Properties that matter:
   *  - the donor is re-read ONCE per event, then compared against many snapshots
   *    (orders created at different times hold different snapshots);
   *  - monotone: this path only ever RAISES the flag. Clearing stays with
   *    AcceptDrift (re-capture) and the determinate CheckDrift recompute, so a
   *    racing event can never wipe a real drift;
   *  - a donor we could not read throws → bounded retry ladder, never a guess;
   *  - the scan is keyset-paginated (`_id` ascending) so memory is bounded no
   *    matter how many orders link the entity;
   *  - `projectId` is always part of the filter (isolation S7).
   */
  async markSourceDrift(
    projectId: string,
    entity: 'contact' | 'company',
    entityId: string,
  ): Promise<{ scanned: number; marked: number }> {
    if (!projectId || !entityId) return { scanned: 0, marked: 0 };
    const read =
      entity === 'contact'
        ? await this.sourceReader.readContact(projectId, entityId)
        : await this.sourceReader.readCompany(projectId, entityId);
    if (read.state === 'unknown') {
      // The donor did not answer: we cannot tell whether anything drifted. Dropping
      // the event would lose the signal for good, so hand it to the retry ladder.
      throw new Error(`drift source ${entity}/${entityId} unreadable — retrying`);
    }
    const ownerField = entity === 'contact' ? 'contactId' : 'companyId';
    const drifted: ObjectId[] = [];
    let scanned = 0;
    let after: ObjectId | undefined;
    for (;;) {
      const batch = (await this.mongo
        .orders()
        .find({
          projectId,
          [ownerField]: entityId,
          status: { $in: ACTIVE_STATUSES },
          hasDrift: { $ne: true },
          ...(after ? { _id: { $gt: after } } : {}),
        })
        .sort({ _id: 1 })
        .limit(OrdersService.SOURCE_DRIFT_BATCH)
        .toArray()) as Record<string, unknown>[];
      if (!batch.length) break;
      scanned += batch.length;
      for (const doc of batch) {
        const snapshot = doc.snapshot as {
          contact?: Record<string, unknown>;
          company?: Record<string, unknown>;
        } | null;
        if (entityDrifted(entity, snapshot, read)) drifted.push(doc._id as ObjectId);
      }
      after = batch[batch.length - 1]._id as ObjectId;
      if (batch.length < OrdersService.SOURCE_DRIFT_BATCH) break;
    }
    if (drifted.length) {
      await this.mongo
        .orders()
        .updateMany({ projectId, _id: { $in: drifted } }, { $set: { hasDrift: true } });
    }
    return { scanned, marked: drifted.length };
  }

  async checkDrift(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const doc = await this.loadVisible(projectId, id, scope, access);
    // Read current source values over gRPC (fail-soft) and diff per field against
    // the order snapshot (OQ-MORD-3, contract 3.14). A donor that is unreachable
    // makes the whole check `unknown` (has_drift:false) — never a false banner.
    // The determinate outcome is persisted so the stored `hasDrift` (card banner +
    // terminal gate) stops lying (TODO-213).
    //
    // `scope` is passed as the VIEWER of the answer, not as the scope of the
    // comparison: `diffs` carry the donor's CURRENT phone/e-mail/ИНН, so a donor
    // this caller may not read comes back without values (review: PII egress via
    // GET /v1/orders/:id/drift). The verdict itself stays system-wide — same
    // `has_drift` for every caller, same stored flag.
    return this.refreshDrift(projectId, doc, scope);
  }

  async acceptDrift(projectId: string, id: string, actor: OrdersActor) {
    const current = await this.loadVisible(projectId, id, actor.scope, actor.access);
    // Ownership OR Manager+ (contract 3.15 / V12).
    this.requireOwnerOrManager(
      current,
      actor,
      'Принять изменения может только владелец или руководитель',
    );
    // Re-capture: re-read the linked sources and rewrite the snapshot values+hashes
    // (contract 3.15). A linked source that could not be re-read (`unknown`) blocks
    // the accept — one must not "accept" a state that was not observed.
    //
    // System scope, like the create-time capture and unlike CheckDrift's response:
    // the snapshot is the ORDER's own confirmed requisites (owner/manager-gated by
    // the check above), and re-capturing under the actor's scope would read an
    // alive-but-invisible donor as deleted — blanking real requisites, or refusing
    // the accept outright and leaving the order permanently un-closable.
    const { contactId, companyId, contactRead, companyRead } = await this.readOrderSources(
      projectId,
      current,
    );
    if (
      (contactId && contactRead?.state === 'unknown') ||
      (companyId && companyRead?.state === 'unknown')
    ) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: JSON.stringify({
          code: 'SOURCE_UNAVAILABLE',
          message: 'Источник реквизитов недоступен — не удалось перечитать. Повторите позже.',
          orderId: id,
        }),
      });
    }
    const now = Date.now();
    // A `present` read supplies fresh values; a `deleted` source is honestly
    // captured as empty (the record is gone).
    const contactFields = contactRead?.state === 'present' ? contactRead.fields : {};
    const companyFields = companyRead?.state === 'present' ? companyRead.fields : {};
    const snapshot = {
      contact: contactFields,
      company: companyFields,
      capturedAt: now,
      contactSourceHash: this.hashFields(contactFields),
      companySourceHash: this.hashFields(companyFields),
    };
    // Snapshot re-capture + `crm.order.drift_accepted` in one tx
    // (legally significant; RFC-4 §Р-3 — listened by audit).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .orders()
        .updateOne(
          { _id: new ObjectId(id), projectId },
          { $set: { snapshot, hasDrift: false, updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.drift_accepted',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey: `order.drift_accepted:${id}:${now}`,
          userId: actor.userId || undefined,
          actorType: actor.userId ? 'user' : 'service',
          payload: { orderId: id, acceptedBy: actor.userId ?? '' },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getOrder(projectId, id, actor.scope);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Final action retry / reassign (Manager+)
  // ────────────────────────────────────────────────────────────────────────

  private requireManager(actor: OrdersActor, message: string) {
    const ok = (actor.roles ?? []).some((r) => projectRoleAtLeast(r, 'manager'));
    if (!ok) {
      throw new RpcException({ code: status.PERMISSION_DENIED, message });
    }
  }

  private requireOwnerOrManager(doc: Record<string, unknown>, actor: OrdersActor, message: string) {
    const isOwner = actor.userId && String(doc.assigneeId) === actor.userId;
    const isManager = (actor.roles ?? []).some((r) => projectRoleAtLeast(r, 'manager'));
    if (!isOwner && !isManager) {
      throw new RpcException({ code: status.PERMISSION_DENIED, message });
    }
  }

  /**
   * Assignee-hierarchy gate (V11 / FR-MORD-37): an actor may only (re)assign an
   * order to someone inside their own scope — `{self} ∪ subordinates ∪ shared`.
   *
   * The gateway already resolves that set into `VisibilityScope.ownerIds` (the
   * owner ids the actor may see/manage, control-resolved hierarchy). So we reuse
   * it as the assignment scope — no extra RPC:
   *  - `mode='all'`        → manager+/personal project → any assignee allowed.
   *  - `mode='restricted'` → assignee MUST be in `ownerIds` (always incl. self).
   *  - scope absent        → fail-closed: only self may be assigned (Д-3).
   *
   * @param code  error code to surface (`ASSIGNEE_OUT_OF_SCOPE`) — caller maps it
   *              to 403 (create/update) or 422 (reassign) per contract 3.9/3.17.
   */
  private assertAssigneeInScope(
    assigneeId: string,
    actor: OrdersActor,
    grpcStatus: number = status.PERMISSION_DENIED,
  ) {
    if (!assigneeId) return; // empty → falls back to self upstream, nothing to check.
    const scope = actor.scope;
    // Self is always in scope.
    if (assigneeId === actor.userId) return;
    // mode='all' (manager+/personal) → no record-level narrowing → any assignee.
    if (scope?.mode === 'all') return;
    // restricted → must be one of the owner ids the actor may manage.
    const allowed = new Set<string>([
      ...(scope?.ownerIds ?? []),
      ...(actor.userId ? [actor.userId] : []),
    ]);
    if (!scope || !allowed.has(assigneeId)) {
      throw new RpcException({
        code: grpcStatus,
        message: JSON.stringify({ code: 'ASSIGNEE_OUT_OF_SCOPE', assigneeId }),
      });
    }
  }

  async retryFinalAction(projectId: string, id: string, actor: OrdersActor) {
    this.requireManager(actor, 'Повтор отправки доступен руководителю');
    const current = await this.loadVisible(projectId, id, actor.scope, actor.access);
    if (String(current.status) !== 'SEND_ERROR') {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: JSON.stringify({ code: 'RETRY_NOT_ALLOWED', status: String(current.status) }),
      });
    }
    const rev = await this.mongo.orderTypeRevisions().findOne({
      projectId,
      orderTypeId: String(current.typeId),
      version: Number(current.orderTypeVersion ?? 1),
    });
    const actionType = ((rev?.finalActionSpec as { type?: string }) ?? {}).type ?? 'webhook';
    const fas = (current.finalActionState as Record<string, unknown>) ?? {};
    const payloadGen = Number(fas.payloadGen ?? 1);
    // Every retry is a NEW send generation → a NEW idempotencyKey (review
    // BLOCKER): the previous send already claimed the old key terminally in
    // `automation_final_actions`, so republishing it would be swallowed as a
    // duplicate and the order would hang in SENDING forever. Bumping `sendGen`
    // makes the retry a fresh attempt for the automation-side claim, while a
    // broker redelivery of THIS retry still carries the same key and is dedupped.
    // Explicit `$set` (not `$inc`): a legacy doc without `sendGen` must land on
    // 2, never collide with the initial send's implicit generation 1.
    const sendGen = Number(fas.sendGen ?? 1) + 1;
    const idempotencyKey = `${id}:${Number(current.orderTypeVersion ?? 1)}:${actionType}:${payloadGen}:${sendGen}`;
    const retryPolicy = rev?.retryPolicy ?? null;
    const fromStatus = String(current.status);
    // Retry transition + `crm.order.final_action_requested` + `crm.order.status_changed`
    // in one tx; the idempotencyKey (payloadGen + fresh sendGen) dedups redelivery
    // of THIS resend only (RFC-4 §Р-3/§Р-4 — listened by automation/audit/notification).
    await this.outbox.withOutbox(async (session) => {
      // Conditional on SEND_ERROR: two concurrent retries both read the same
      // sendGen — only the one that wins this transition publishes; the loser
      // matches nothing and aborts (no second SENDING, no second key).
      const res = await this.mongo.orders().updateOne(
        { _id: new ObjectId(id), projectId, status: 'SEND_ERROR' },
        {
          $set: {
            status: 'SENDING',
            'finalActionState.status': 'PENDING',
            'finalActionState.idempotencyKey': idempotencyKey,
            'finalActionState.sendGen': sendGen,
            updatedAt: Date.now(),
          },
        },
        session ? { session } : {},
      );
      if ((res.matchedCount ?? 0) === 0) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: JSON.stringify({ code: 'RETRY_NOT_ALLOWED', status: 'CONCURRENT_TRANSITION' }),
        });
      }
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.final_action_requested',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey,
          userId: actor.userId || undefined,
          actorType: actor.userId ? 'user' : 'service',
          payload: {
            orderId: id,
            actionId: actionType,
            idempotencyKey,
            retryPolicy,
            // Full spec (type + config) for the automation executor (FR-ORDERS-270).
            spec: (rev?.finalActionSpec as Record<string, unknown>) ?? { type: actionType },
            assigneeId: String(current.assigneeId ?? ''),
            payload: { snapshot: current.snapshot ?? {} },
          },
        },
        {
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${id}`,
          idempotencyKey: `order.status_changed:${id}:${fromStatus}:SENDING:${payloadGen}:${sendGen}`,
          userId: actor.userId || undefined,
          actorType: actor.userId ? 'user' : 'service',
          payload: { orderId: id, from: fromStatus, to: 'SENDING' },
        },
      ];
      this.domainMetrics?.recordFinalAction('requested');
      return { result: undefined, intents };
    });
    return this.getOrder(projectId, id, actor.scope);
  }

  /**
   * Apply the automation domain's final-action answer (FR-ORDERS-280/290):
   * `SENDING → DONE` on `crm.order.final_action_succeeded`, `SENDING →
   * SEND_ERROR` on `crm.order.final_action_failed`, appending the attempt to
   * `finalActionState.attempts[]` and setting `lastError` (FR-ORDERS-320).
   *
   * Idempotent by construction: the conditional filter matches ONLY the
   * in-flight send carrying the SAME business `idempotencyKey`. A duplicate
   * delivery, a stale answer for an older `payloadGen`, or an order that
   * already left SENDING matches nothing → `skipped`, no double transition and
   * no duplicate `status_changed` event.
   */
  async applyFinalActionResult(
    projectId: string,
    orderId: string,
    idempotencyKey: string,
    ok: boolean,
    info: { error?: string; httpCode?: number; attemptNo?: number; durationMs?: number } = {},
  ): Promise<'applied' | 'skipped'> {
    if (!ObjectId.isValid(orderId)) return 'skipped';
    const now = Date.now();
    const toStatus = ok ? 'DONE' : 'SEND_ERROR';
    const attempt = {
      at: now,
      attemptNo: Number(info.attemptNo ?? 1),
      responseCode: Number(info.httpCode ?? 0),
      errorBody: ok ? '' : String(info.error ?? ''),
      durationMs: Number(info.durationMs ?? 0),
    };
    const outcome = await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo.orders().updateOne(
        {
          _id: new ObjectId(orderId),
          projectId,
          status: 'SENDING',
          // Legacy docs predating `finalActionState.idempotencyKey` have the
          // field MISSING, and in Mongo `{key: ''}` does NOT match a missing
          // field — so an empty expected key must match "missing OR empty",
          // otherwise such docs could never leave SENDING and would occupy
          // the head of the watchdog's `updatedAt` sort forever, starving
          // every younger stale order (review MINOR). Real automation answers
          // never carry '' (the result consumer drops those as poison), so
          // the $or branch is reachable only from expireStaleSending.
          ...(idempotencyKey === ''
            ? {
                $or: [
                  { 'finalActionState.idempotencyKey': { $exists: false } },
                  { 'finalActionState.idempotencyKey': '' },
                ],
              }
            : { 'finalActionState.idempotencyKey': idempotencyKey }),
        },
        {
          $set: {
            status: toStatus,
            'finalActionState.status': ok ? 'SUCCEEDED' : 'FAILED',
            'finalActionState.lastError': ok ? '' : String(info.error ?? 'final_action_failed'),
            ...(ok ? { 'finalActionState.succeededAt': now } : {}),
            updatedAt: now,
          },
          // Untyped Collection<Document>: $push on a dotted path needs the cast.
          $push: { 'finalActionState.attempts': attempt } as never,
        },
        session ? { session } : {},
      );
      if ((res.matchedCount ?? 0) === 0) {
        return { result: 'skipped' as const, intents: [] };
      }
      // Transition + `crm.order.status_changed` in one tx (RFC-4 §Р-3) — same
      // event the manual transitions emit, so reports/statistics stay in sync.
      const intents: EmitIntent[] = [
        {
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.status_changed:${orderId}:SENDING:${toStatus}:${idempotencyKey}`,
          actorType: 'service',
          payload: { orderId, from: 'SENDING', to: toStatus },
        },
      ];
      return { result: 'applied' as const, intents };
    });
    if (outcome === 'applied') {
      const isTimeout = String(info.error ?? '').includes('final_action_timeout');
      this.domainMetrics?.recordFinalAction(isTimeout ? 'timeout' : ok ? 'succeeded' : 'failed');
    }
    return outcome;
  }

  /**
   * Operational exit from SENDING (review MAJOR): expire every order that has
   * waited in SENDING longer than `olderThanMs` into SEND_ERROR with a readable
   * `lastError` — driven by {@link SendingWatchdogService}.
   *
   * Why the watchdog lives in ORDERS (the state owner) and not as a reclaim in
   * the automation janitor: the automation side can only recover sends it has
   * SEEN (a stuck `running` doc). It can never recover the cases where the
   * request message was lost before a doc existed, the automation process was
   * down for the whole retry window, the transport DLQ ladder was exhausted, or
   * the ANSWER (not the request) was lost. Guarding at the state owner covers
   * every failure class uniformly: no answer within the budget ⇒ SEND_ERROR,
   * from which the user-facing RetryFinalAction (fresh `sendGen` key) resends.
   *
   * Race-safe by reusing {@link applyFinalActionResult}: the conditional filter
   * (status=SENDING + the EXACT in-flight idempotencyKey) means a real answer
   * that lands between our scan and the write simply wins — we match nothing
   * and skip. A late answer arriving AFTER expiry is skipped by the same filter
   * (the order already left SENDING). Because every send generation has a
   * unique key, an expired order that was retried can never be flipped by a
   * stale answer of a previous generation.
   */
  async expireStaleSending(olderThanMs: number, limit = 50): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const stale = await this.mongo
      .orders()
      .find(
        { status: 'SENDING', updatedAt: { $lt: cutoff } },
        { projection: { _id: 1, projectId: 1, finalActionState: 1 } },
      )
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    let expired = 0;
    const minutes = Math.max(1, Math.round(olderThanMs / 60_000));
    const error = `final_action_timeout: ответ исполнителя финального действия не получен за ${minutes} мин — отправка помечена ошибочной, её можно повторить`;
    for (const doc of stale as Array<Record<string, unknown>>) {
      const orderId = (doc._id as ObjectId).toString();
      const idemKey = String(
        (doc.finalActionState as Record<string, unknown> | undefined)?.idempotencyKey ?? '',
      );
      try {
        const res = await this.applyFinalActionResult(
          String(doc.projectId ?? ''),
          orderId,
          idemKey,
          false,
          { error, attemptNo: 0 },
        );
        if (res === 'applied') {
          expired += 1;
          this.logger.warn(
            `order ${orderId}: SENDING expired after ${minutes}m without a final-action answer (${idemKey}) → SEND_ERROR`,
          );
        }
      } catch (err) {
        // Never let one bad row abort the sweep — the next tick retries it.
        this.logger.warn(`failed to expire stale SENDING order ${orderId}: ${String(err)}`);
      }
    }
    return expired;
  }

  /**
   * TODO-170 / FR-CONTACTS-210: when contacts merge, orders still linked to the
   * source tombstone must be repointed at the surviving contact. Emits one
   * `crm.order.updated` per moved row (same contract as a manual contact edit).
   * Natural idempotency: a redelivery finds nothing still on `sourceId`.
   */
  async rewriteContactOnMerge(
    projectId: string,
    sourceContactIds: string[],
    targetContactId: string,
    mergeIdempotencyKey: string,
  ): Promise<{ rewritten: number }> {
    const target = (targetContactId ?? '').trim();
    const sources = [...new Set(sourceContactIds.map((s) => s.trim()).filter(Boolean))].filter(
      (s) => s !== target,
    );
    if (!projectId || !target || sources.length === 0) return { rewritten: 0 };

    const now = Date.now();
    const rewritten = await this.outbox.withOutbox(async (session) => {
      // Accumulate INSIDE `work`: `withTransaction` may re-run the callback on a
      // transient error, and an outer accumulator would double-count the rows.
      let moved = 0;
      const intents: EmitIntent[] = [];
      for (const sourceId of sources) {
        const filter = { projectId, contactId: sourceId };
        const affected = await this.mongo
          .orders()
          .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
          .toArray();
        if (affected.length === 0) continue;
        const res = await this.mongo
          .orders()
          .updateMany(
            filter,
            { $set: { contactId: target, updatedAt: now } },
            session ? { session } : {},
          );
        moved += res.modifiedCount;
        for (const doc of affected) {
          const orderId = (doc as { _id: ObjectId })._id.toString();
          intents.push({
            type: 'crm.order.updated',
            source: 'orders',
            projectId,
            subject: `order/${orderId}`,
            idempotencyKey: `order.contact_merged:${orderId}:${mergeIdempotencyKey}`,
            actorType: 'service',
            payload: {
              orderId,
              before: { contactId: sourceId },
              after: { contactId: target },
            },
          });
        }
      }
      return { result: moved, intents };
    });
    return { rewritten };
  }

  /**
   * FR-COMPANIES-140: when companies merge, orders still linked to the loser
   * tombstone must be repointed at the surviving master. Emits one
   * `crm.order.updated` per moved row (same contract as a manual company edit).
   * Natural idempotency: a redelivery finds nothing still on `loserId`.
   */
  async rewriteCompanyOnMerge(
    projectId: string,
    loserId: string,
    masterId: string,
    mergeIdempotencyKey: string,
  ): Promise<{ rewritten: number }> {
    const loser = (loserId ?? '').trim();
    const master = (masterId ?? '').trim();
    if (!projectId || !loser || !master || loser === master) return { rewritten: 0 };

    const now = Date.now();
    const rewritten = await this.outbox.withOutbox(async (session) => {
      let moved = 0;
      const intents: EmitIntent[] = [];
      const filter = { projectId, companyId: loser };
      const affected = await this.mongo
        .orders()
        .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
        .toArray();
      if (affected.length === 0) return { result: 0, intents: [] };
      const res = await this.mongo
        .orders()
        .updateMany(
          filter,
          { $set: { companyId: master, updatedAt: now } },
          session ? { session } : {},
        );
      moved += res.modifiedCount;
      for (const doc of affected) {
        const orderId = (doc as { _id: ObjectId })._id.toString();
        intents.push({
          type: 'crm.order.updated',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.company_merged:${orderId}:${mergeIdempotencyKey}`,
          actorType: 'service',
          payload: {
            orderId,
            before: { companyId: loser },
            after: { companyId: master },
          },
        });
      }
      return { result: moved, intents };
    });
    return { rewritten };
  }

  /**
   * BX-OFFB-2: reassign EVERY order owned by a departing member (in one project) to
   * the new responsible — the service-triggered offboard cascade (no actor / scope;
   * caller is control via the bus). Emits one `crm.order.status_changed` per order
   * (same event the manual bulk `reassignOrders` uses) so reports/statistics stay in
   * sync — never a blunt `updateMany` without events. Natural idempotency: a
   * redelivery finds nothing still owned by `fromUserId` → 0 reassigned.
   * `offboardTs` keeps the per-record event idempotency keys stable across replay.
   */
  async reassignOwnedRecords(
    projectId: string,
    fromUserId: string,
    toUserId: string,
    offboardTs: number,
  ): Promise<{ reassigned: number }> {
    const from = (fromUserId ?? '').trim();
    const to = (toUserId ?? '').trim();
    if (!projectId || !from || !to || from === to) return { reassigned: 0 };
    const filter = { projectId, assigneeId: from };
    const now = Date.now();
    let reassigned = 0;
    await this.outbox.withOutbox(async (session) => {
      // TOCTOU fix (MINOR-13): read the affected ids inside the SAME session/
      // transaction as the update, so a concurrent assigneeId change between the
      // read and the write can't desync the emitted per-record events from the
      // rows actually moved (phantom or missed `crm.order.status_changed`).
      const affected = await this.mongo
        .orders()
        .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
        .toArray();
      if (affected.length === 0) return { result: 0, intents: [] };
      const res = await this.mongo
        .orders()
        .updateMany(
          filter,
          { $set: { assigneeId: to, updatedAt: now } },
          session ? { session } : {},
        );
      reassigned = res.modifiedCount;
      const intents: EmitIntent[] = affected.map((doc) => {
        const orderId = (doc as { _id: ObjectId })._id.toString();
        return {
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.reassigned:${orderId}:${offboardTs}`,
          actorType: 'service',
          payload: { orderId, fromAssigneeId: from, toAssigneeId: to },
        };
      });
      return { result: res.modifiedCount, intents };
    });
    return { reassigned };
  }

  /** FR-PROJ-215 */
  async countOwnedRecords(projectId: string, userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!projectId || !uid) return 0;
    return this.mongo.orders().countDocuments({ projectId, assigneeId: uid });
  }

  async reassignOrders(
    projectId: string,
    fromAssigneeId: string,
    toAssigneeId: string,
    filter: { typeId?: string; status?: string; stageId?: string },
    actor: OrdersActor,
  ) {
    this.requireManager(actor, 'Массовое переназначение доступно руководителю');
    // Assignee-hierarchy gate (V11, contract 3.17): the bulk target must be in the
    // actor's scope — else ASSIGNEE_OUT_OF_SCOPE (422, INVALID_ARGUMENT here).
    this.assertAssigneeInScope(toAssigneeId, actor, status.INVALID_ARGUMENT);
    const base: Record<string, unknown> = { projectId, assigneeId: fromAssigneeId };
    if (filter.typeId) base.typeId = filter.typeId;
    if (filter.status) base.status = filter.status;
    if (filter.stageId) base.stageId = filter.stageId;
    // Bulk $set carries projectId (from metadata) AND visibility scope of the actor.
    const scoped = this.visAnd(actor.scope, base, actor.access);
    // Resolve the affected ids up-front so we can emit a per-order event (RFC-4
    // §Р-3 reassign-semantics); the bulk update + all rows commit in one tx.
    const affected = await this.mongo
      .orders()
      .find(scoped, { projection: { _id: 1 } })
      .toArray();
    if (affected.length === 0) return { reassigned: 0 };
    const now = Date.now();
    const reassigned = await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo
        .orders()
        .updateMany(
          scoped,
          { $set: { assigneeId: toAssigneeId, updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = affected.map((doc) => {
        const orderId = (doc as { _id: ObjectId })._id.toString();
        return {
          type: 'crm.order.status_changed',
          source: 'orders',
          projectId,
          subject: `order/${orderId}`,
          idempotencyKey: `order.reassigned:${orderId}:${fromAssigneeId}:${toAssigneeId}:${now}`,
          userId: actor.userId || undefined,
          actorType: actor.userId ? 'user' : 'service',
          payload: { orderId, fromAssigneeId, toAssigneeId },
        };
      });
      return { result: res.modifiedCount, intents };
    });
    return { reassigned };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Deal summary
  // ────────────────────────────────────────────────────────────────────────

  async getOrdersSummaryForDeal(
    projectId: string,
    dealId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const filter = this.visAnd(scope, { projectId, dealId }, access);
    const rows = await this.mongo.orders().find(filter).toArray();
    // FR-ORDERS-440: the deal-card widget renders type/stage names — resolve them
    // here (same source as the get/list projection) so the aggregate is enough
    // for the screen and the client never falls back to a full list scan.
    const typeIds = [
      ...new Set(rows.map((r) => String((r as Record<string, unknown>).typeId ?? ''))),
    ].filter(Boolean);
    const types = typeIds.length
      ? await this.mongo
          .orderTypes()
          .find({ projectId, id: { $in: typeIds } })
          .toArray()
      : [];
    const typeById = new Map(
      types.map((t) => [String((t as Record<string, unknown>).id), t as Record<string, unknown>]),
    );
    const byStatus = new Map<string, number>();
    const items = rows.map((doc) => {
      const d = doc as Record<string, unknown>;
      const st = String(d.status ?? 'ACTIVE');
      byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
      const type = typeById.get(String(d.typeId ?? ''));
      const stage = ((type?.stages as StageSpec[]) ?? []).find(
        (s) => s.id === String(d.stageId ?? ''),
      );
      return {
        id: (d._id as ObjectId).toString(),
        number: String(d.number ?? ''),
        status: st,
        stage_id: String(d.stageId ?? ''),
        assignee_name: String(d.assigneeName ?? ''),
        stage_name: String(stage?.name ?? ''),
        type_name: String(type?.name ?? ''),
        product_name: String(d.productName ?? ''),
        deal_name: String(d.dealName ?? ''),
      };
    });
    return {
      total: rows.length,
      by_status: [...byStatus.entries()].map(([s, c]) => ({ status: s, count: c })),
      items,
    };
  }
}
