import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  OnModuleInit,
  Req,
  Res,
  Header,
  UseGuards,
  UseInterceptors,
  Injectable,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  projectRoleCan,
  projectRoleCanKey,
  projectRoleAtLeast,
  documentContextModuleId,
  isDocumentContextType,
  isDocumentContextTypeOrNone,
  MODULE_REGISTRY,
  enabledDependentsOf,
} from '@fairflow/shared';
import type { ProjectRole, AbacEvalContext } from '@fairflow/shared';
import { compileAccessPredicate, type AbacPolicyRule } from '../guards/access-predicate';
import { grpcBffCall } from './grpc-bff-call';
import { documentVariablesCatalog, isDocVarContextType } from './document-variables-catalog';
import {
  collectOrderHistoryUserIds,
  emptyOrderHistoryContext,
  orderHistoryItemFe,
} from './order-history';
import { ExportBudget, ExportInflightLimiter, ordersExportLimits } from './orders-export-budget';
import { DocumentStorageService } from './document-storage.service';
import { AppConfigService } from '../config/app-config.service';
import { trustedClientPointer } from './trusted-client-pointer';
import { appendPiiEgressAudit } from './pii-egress-audit';
import type { TrustedClientPointer } from './trusted-client-pointer';
import { readMultipart } from './multipart';
import type { MultipartUpload } from './multipart';
import { IMPORT_MAPPABLE_CONTACT_FIELDS, normalizeImportMapping } from './import-mapping';
import type { FastifyRequest, FastifyReply } from 'fastify';

type GrpcReq = FastifyRequest & { user?: { userId?: string }; __projectRole?: string };

/** Default MIME of a template revision (the only format the engine renders). */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function parseQueryTypes(type?: string, types?: string | string[]): string[] {
  const raw = types == null ? [] : Array.isArray(types) ? types : [types];
  const split = raw
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (split.length) return split;
  const single = type?.trim();
  return single ? [single] : [];
}

/** Whether the caller's project role permits acting on others' records (V-12). */
function canManage(req: GrpcReq): boolean {
  return projectRoleCan(req.__projectRole, 'manage');
}

/**
 * FR-DEALS-130 / B1 — reopening a closed deal is a manager+ action.
 *
 * The route ALSO carries `@RequirePermission('deals','write')` (a member may work
 * with deal data), but `write` alone is NOT the gate: the domain enforces
 * `@RequireRoles('manager')` on `PipeGrpc.ReopenDeal` (pipe.grpc.controller.ts),
 * and a gateway PEP that is weaker than the domain PDP is a hole by definition —
 * every member would sail through the gateway and collect a domain-shaped 403
 * instead of a clean PERMISSION_DENIED from the PEP.
 *
 * This guard mirrors the domain predicate EXACTLY — `projectRoleAtLeast(role,
 * 'manager')`, the same helper `GrpcRolesGuard` uses — so the two ends cannot
 * drift apart. It is a route guard (not an in-handler `if`) on purpose: the
 * requirement then shows up in the frozen route-inventory snapshot, so weakening
 * it again cannot pass review silently.
 *
 * Fail-closed: an unresolved/unknown role denies (`projectRoleAtLeast` returns
 * false for `undefined`, `''` and non-project roles).
 */
export const DEAL_REOPEN_MIN_ROLE: ProjectRole = 'manager';

@Injectable()
export class DealReopenRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<GrpcReq>();
    if (!projectRoleAtLeast(req.__projectRole, DEAL_REOPEN_MIN_ROLE)) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        subject: 'deals',
        action: 'write',
        requiredRole: DEAL_REOPEN_MIN_ROLE,
        message: `Role "${req.__projectRole || 'none'}" cannot reopen deals (requires project role >= ${DEAL_REOPEN_MIN_ROLE})`,
      });
    }
    return true;
  }
}

/** Clamp a client-supplied pageSize: NaN/absent → 25, hard cap at 100 (DoS guard). */
function parsePageSize(raw?: string): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(n, 100);
}

/**
 * proto `int64` fields decode as a `Long {low,high}` object under the keepCase
 * proto-loader (no `longs:Number`), which would leak `{low,high,unsigned}` to the
 * FE instead of a JS number (e.g. list `total`, `size_bytes`). Coerce to a plain
 * number; already-number/string values pass through.
 */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || 0;
  const l = v as { low?: number; high?: number };
  if (typeof l.low === 'number' && typeof l.high === 'number') {
    return l.high * 0x1_0000_0000 + (l.low >>> 0);
  }
  return 0;
}

/**
 * A gRPC ServiceError carries a numeric `code`; clients expect a string code
 * (e.g. NOT_FOUND). Map it back to the canonical name, defaulting to INTERNAL.
 */
function grpcCodeToString(code: unknown): string {
  return typeof code === 'number' ? (GrpcStatus[code] ?? 'INTERNAL') : 'INTERNAL';
}
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { GatewayModuleGuard } from '../guards/gateway-module.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { RequireModule } from '../guards/require-module.decorator';
import { RequirePermission } from '../guards/require-permission.decorator';
import { MembershipOnly } from '../guards/membership-only.decorator';
import { AssigneeNameInterceptor } from './assignee-name.interceptor';
import { IdentityResolverService } from './identity-resolver.service';
import { parsePageIndex } from './parse-page-index';
import { ReportRunNamesService } from './report-run-names.service';

function dealFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    name: d.name,
    amount: d.amount,
    currency: d.currency,
    pipelineId: d.pipeline_id,
    stageId: d.stage_id,
    stageName: d.stage_name,
    contactId: d.contact_id || undefined,
    contactName: d.contact_name,
    companyId: d.company_id || undefined,
    companyName: d.company_name,
    productId: d.product_id,
    productName: d.product_name,
    source: d.source,
    assigneeId: d.assignee_id,
    assigneeName: d.assignee_name,
    expectedCloseDate: d.expected_close_date,
    closedAt: d.closed_at,
    result: d.result,
    lostReason: d.lost_reason,
    stageEnteredAt: d.stage_entered_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    status: d.status,
    wonAt: d.won_at,
    lostAt: d.lost_at,
    departmentId: d.department_id || undefined,
    lightName: d.light_name || undefined,
    lightPhone: d.light_phone || undefined,
    lightEmail: d.light_email || undefined,
    lightCompanyName: d.light_company_name || undefined,
    contactSnapshot: d.contact_snapshot,
    companySnapshot: d.company_snapshot,
    driftFlag: d.drift_flag,
    driftFields: d.drift_fields,
    probability: d.probability,
    tags: d.tags,
    lostReasonId: d.lost_reason_id || undefined,
    lostReasonComment: d.lost_reason_comment || undefined,
    deletedAt: d.deleted_at || undefined,
    // `notes` is rendered by DealInfoWidget and posted back by DealEdit; without it
    // in the response the textarea silently reset to empty on every reload.
    notes: d.notes,
    // FR-DEALS-180: pipe computes these on read; dropping them here is the
    // classic "backend does it, user never sees it" hole.
    daysOnStage: d.days_on_stage,
    isStalled: d.is_stalled,
    stageReturnCount: d.stage_return_count,
    totalTimeOnStageDays: d.total_time_on_stage_days,
  };
}

/**
 * Custom-field bag of an order create/update body.
 *
 * The FE has always called it `customFields` (OrderEdit.tsx, EntityCreateDrawer.tsx)
 * while this BFF read `body.fields` — so values never reached `fields_json`. Accept
 * both spellings, `customFields` first; return `undefined` when neither is a plain
 * object so callers can distinguish "not supplied" from "cleared to {}".
 */
function orderCustomFields(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = body.customFields ?? body.fields;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * TODO-207: сколько РАЗНЫХ id одного вида gateway резолвит в имена за один запрос.
 * Значение по умолчанию рассчитано на страницу списка/канбана (домен отдаёт не
 * больше 100 строк за раз): сверх потолка имена остаются пустыми — деградация
 * без шторма вызовов в соседние домены. Выгрузка передаёт свой потолок
 * (`ORDERS_EXPORT_NAME_MAX_IDS`), иначе колонки имён обрывались бы на 200-й строке.
 */
const ORDER_NAME_MAX_IDS = 200;
/** TODO-207: сколько Get*-вызовов резолва имён идёт параллельно. */
const ORDER_NAME_CONCURRENCY = 8;

/**
 * BX-ORD-NAMES-3: есть ли у правила УСЛОВИЕ, применимое к чтению `subject`.
 *
 * Зеркало `ruleApplies` из `gateway/src/guards/access-predicate.ts` (там она
 * приватная): та же тройка (условие непустое, subject совпал, action = `read`
 * или `*`, resource пуст/`*`/равен subject). Нужна ровно для одного решения —
 * «обязан ли этот донор ехать с предикатом»: если применимые условные правила
 * есть, а `compileAccessPredicate` вернул `undefined` (отложил), донора не
 * опрашиваем. Расхождение с оригиналом в сторону «нашли лишнее» безопасно
 * (имя останется пустым), поэтому проверка сознательно грубее компилятора.
 */
function donorRuleApplies(rule: AbacPolicyRule, subject: string): boolean {
  const cond = rule.condition;
  if (cond == null || typeof cond !== 'object' || Object.keys(cond).length === 0) return false;
  return (
    rule.subject === subject &&
    (rule.action === 'read' || rule.action === '*') &&
    (!rule.resource || rule.resource === '*' || rule.resource === subject)
  );
}

/**
 * TODO-207 (хвост): размер страницы, которой gateway листает домен для выгрузки.
 * Ровно доменный максимум — `OrdersService.listOrders` клампит запрошенный размер
 * (`Math.min(Math.max(pageSize || 25, 1), 100)`), поэтому просить больше бесполезно:
 * до правки экспорт слал `page_size: 1000`, получал 100 строк и молча обрезал файл.
 */
const ORDERS_EXPORT_PAGE_SIZE = 100;
/**
 * Жёсткий потолок выгрузки: сколько строк gateway готов вычитать и удержать в памяти
 * за один запрос. Дальше выгрузка объявляется усечённой явно — заголовками, именем
 * файла и маркером внутри самого файла (заголовки браузеру видны не всегда).
 */
const ORDERS_EXPORT_MAX_ROWS = 10000;
/**
 * Потолок УНИКАЛЬНЫХ id на вид имени в выгрузке: имена нужны всем выгруженным
 * строкам, не первым 200. Сам по себе он не ограничивает нагрузку (10 000 строк
 * с разными контактами = 10 000 одиночных RPC), поэтому поверх него работает
 * ОБЩИЙ бюджет запроса (`ExportBudget`: wall-clock + суммарный потолок Get*-вызовов
 * на все четыре вида) — см. `orders-export-budget.ts`. Что не поместилось в бюджет,
 * уезжает пустым и помечается в файле/заголовках, а не молча.
 */
const ORDERS_EXPORT_NAME_MAX_IDS = ORDERS_EXPORT_MAX_ROWS;

function orderFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    number: d.number,
    typeId: d.type_id,
    typeName: d.type_name,
    productId: d.product_id,
    productName: d.product_name,
    productPrice: d.product_price,
    productCurrency: d.product_currency,
    productUnit: d.product_unit,
    productCategory: d.product_category,
    dealId: d.deal_id,
    dealName: d.deal_name,
    contactId: d.contact_id,
    contactName: d.contact_name,
    companyId: d.company_id,
    companyName: d.company_name,
    stageId: d.stage_id,
    stageName: d.stage_name,
    assigneeId: d.assignee_id,
    assigneeName: d.assignee_name,
    fields: JSON.parse(String(d.fields_json || '{}')),
    notes: d.notes ?? '',
    status: d.status,
    dlqError: d.dlq_error,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    orderTypeVersion: d.order_type_version,
    stageChangedAt: d.stage_changed_at,
    createdBy: d.created_by,
    snapshot: d.snapshot_json ? JSON.parse(String(d.snapshot_json)) : null,
    hasDrift: d.has_drift,
    finalActionState: finalActionStateFe(d.final_action_state as Record<string, unknown>),
  };
}

function finalActionStateFe(s?: Record<string, unknown>) {
  if (!s) return null;
  return {
    status: s.status,
    idempotencyKey: s.idempotency_key,
    payloadGen: s.payload_gen,
    lastError: s.last_error,
    // succeeded_at и attempt.at — int64 (orders.proto §FinalActionState/Attempt) и
    // НЕ входят в TS_KEYS grpc-bff-call, т.е. без явного toNum уходили на фронт
    // сырыми. `toOrderDayjs` делает `Number(значение)` → NaN → null, и в блоке
    // «Попытки отправки» время каждой строки рендерилось прочерком, а итог —
    // «Успешно отправлено —». Метки в МС, деление на секунды тут не нужно.
    succeededAt: toNum(s.succeeded_at),
    attempts: (Array.isArray(s.attempts) ? (s.attempts as Record<string, unknown>[]) : []).map(
      (a) => ({
        at: toNum(a.at),
        // attempt_no / response_code / duration_ms — int32, приходят числом.
        attemptNo: a.attempt_no,
        responseCode: a.response_code,
        errorBody: a.error_body,
        durationMs: a.duration_ms,
      }),
    ),
  };
}

function fieldSpecFe(f: Record<string, unknown>) {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    options: f.options,
    defaultValue: f.default_value,
    validation: f.validation_json ? JSON.parse(String(f.validation_json)) : null,
    deprecated: f.deprecated,
  };
}

function stageSpecFe(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name,
    order: s.order,
    requiredFieldKeys: s.required_field_keys ?? [],
    isTerminal: s.is_terminal,
  };
}

/** Map an FE order-type spec body into the gRPC OrderTypeSpec shape. */
function orderTypeSpecToGrpc(body: Record<string, unknown>) {
  const fields = (Array.isArray(body.fields) ? (body.fields as Record<string, unknown>[]) : []).map(
    (f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options : [],
      default_value: f.defaultValue ?? '',
      validation_json: f.validation ? JSON.stringify(f.validation) : '',
      deprecated: !!f.deprecated,
    }),
  );
  const stages = (Array.isArray(body.stages) ? (body.stages as Record<string, unknown>[]) : []).map(
    (s, i) => ({
      id: s.id,
      name: s.name,
      order: typeof s.order === 'number' ? s.order : i,
      required_field_keys: Array.isArray(s.requiredFieldKeys) ? s.requiredFieldKeys : [],
      is_terminal: !!s.isTerminal,
    }),
  );
  return {
    name: body.name ?? '',
    description: body.description ?? '',
    fields,
    stages,
    final_action_spec_json: body.finalActionSpec ? JSON.stringify(body.finalActionSpec) : '',
    retry_policy_json: body.retryPolicy ? JSON.stringify(body.retryPolicy) : '',
    document_templates_json: body.documentTemplates ? JSON.stringify(body.documentTemplates) : '',
  };
}

function orderTypeDetailFe(d: Record<string, unknown>) {
  const rev = d.revision as Record<string, unknown> | undefined;
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    currentVersion: d.current_version,
    deletedAt: d.deleted_at,
    revision: rev
      ? {
          version: rev.version,
          status: rev.status,
          fields: (Array.isArray(rev.fields) ? (rev.fields as Record<string, unknown>[]) : []).map(
            fieldSpecFe,
          ),
          stages: (Array.isArray(rev.stages) ? (rev.stages as Record<string, unknown>[]) : []).map(
            stageSpecFe,
          ),
          terminalStageId: rev.terminal_stage_id,
          finalActionSpec: rev.final_action_spec_json
            ? JSON.parse(String(rev.final_action_spec_json))
            : null,
          retryPolicy: rev.retry_policy_json ? JSON.parse(String(rev.retry_policy_json)) : null,
          documentTemplates: rev.document_templates_json
            ? JSON.parse(String(rev.document_templates_json))
            : [],
          createdAt: rev.created_at,
          createdBy: rev.created_by,
        }
      : null,
  };
}

function activityFe(d: Record<string, unknown>) {
  const links = (Array.isArray(d.links) ? d.links : []) as Record<string, unknown>[];
  const cbr = d.created_by_rule as Record<string, unknown> | undefined;
  return {
    id: d.id,
    type: d.type,
    title: d.title,
    description: d.description,
    status: d.status,
    priority: d.priority,
    dueDate: d.due_date ?? null,
    startDate: d.start_date ?? null,
    endDate: d.end_date ?? null,
    allDay: d.all_day ?? false,
    assigneeId: d.assignee_id,
    assigneeName: d.assignee_name,
    departmentId: d.department_id || null,
    createdBy: d.created_by,
    createdByRule: cbr?.rule_id
      ? { ruleId: cbr.rule_id, name: cbr.name ?? cbr.rule_id }
      : undefined,
    // Bridge: flat ids/names kept until M6 (FE migrating to links[]).
    dealId: d.deal_id || undefined,
    dealName: d.deal_name,
    contactId: d.contact_id || undefined,
    contactName: d.contact_name,
    companyId: d.company_id || undefined,
    companyName: d.company_name,
    orderId: d.order_id || undefined,
    orderName: d.order_name,
    links: links.map((l) => ({
      entityType: l.entity_type,
      entityId: l.entity_id,
      nameSnapshot: l.name_snapshot ?? '',
      orphaned: Boolean(l.orphaned),
    })),
    location: d.location,
    direction: d.direction,
    duration: d.duration ?? null,
    actualDuration: d.actual_duration ?? null,
    participants: Array.isArray(d.participants) ? d.participants : [],
    result: d.result,
    reminderOffset: d.reminder_offset ?? 'none',
    reminderFireAt: d.reminder_fire_at ?? null,
    reminderState: d.reminder_state ?? 'none',
    completedAt: d.completed_at ?? null,
    deletedAt: d.deleted_at ?? null,
    overdue: d.overdue,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Map FE link input ({entityType,entityId}) to proto snake_case. */
function linksToProto(raw: unknown): { entity_type: unknown; entity_id: unknown }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((l) => {
    const o = l as Record<string, unknown>;
    return { entity_type: o.entityType ?? o.entity_type, entity_id: o.entityId ?? o.entity_id };
  });
}

/**
 * GAP-PRODUCTS-160 — `google.protobuf.Struct` codec for `Product.prefill`.
 *
 * The proto declares `prefill` as a Struct, but both ends passed a plain JS map.
 * protobuf.js loads the well-known `struct.proto` from its own bundled (already
 * camelCase) descriptors, so `keepCase: true` does NOT apply to `Value`'s oneof —
 * the wire shape is `{ fields: { key: { stringValue | numberValue | boolValue } } }`.
 * A plain map therefore serialised to ZERO bytes: prefill was lost in BOTH
 * directions (write never reached Mongo, read came back `{}`).
 *
 * Only scalars are produced/consumed — the domain's `sanitizePrefill` rejects
 * anything else anyway (product.service.ts §V6).
 */
type PrefillScalar = string | number | boolean;

function prefillToStruct(
  value: unknown,
): { fields: Record<string, Record<string, unknown>> } | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { numberValue: v };
    else if (typeof v === 'boolean') fields[k] = { boolValue: v };
    // `null` is deliberately NOT encoded: neither decoder (this one, nor the domain's
    // prefill-struct.ts) understands `nullValue`, so a `{k: null}` key encoded as
    // `{nullValue: 0}` came back as a MISSING key — asymmetric round-trip. Dropping
    // it on the way in makes both directions agree: a null-valued key simply is not
    // part of the prefill.
    // non-scalars are dropped here; the domain would reject them with INVALID_ARGUMENT
  }
  return { fields };
}

function prefillFromStruct(value: unknown): Record<string, PrefillScalar> {
  if (value == null || typeof value !== 'object') return {};
  const fields = (value as { fields?: unknown }).fields;
  // Tolerate a legacy/plain map so a mixed-version domain still renders.
  const src = (fields ?? value) as Record<string, unknown>;
  const out: Record<string, PrefillScalar> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (v == null || typeof v !== 'object') continue;
    const w = v as Record<string, unknown>;
    if (typeof w.stringValue === 'string') out[k] = w.stringValue;
    else if (typeof w.numberValue === 'number') out[k] = w.numberValue;
    else if (typeof w.boolValue === 'boolean') out[k] = w.boolValue;
  }
  return out;
}

function productFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    price: d.price,
    effectivePrice: d.effective_price,
    currency: d.currency,
    unit: d.unit,
    orderTypeId: d.order_type_id,
    orderTypeName: d.order_type_name,
    orderTypeDangling: d.order_type_dangling,
    prefill: prefillFromStruct(d.prefill),
    status: d.status,
    archivedAt: d.archived_at ? d.archived_at : null,
    ownerDepartmentId: d.owner_department_id || null,
    dealsCount: d.deals_count,
    activeDealsCount: d.active_deals_count,
    ordersCount: d.orders_count,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function productAffectedFe(a: Record<string, unknown> | undefined) {
  const aff = (a ?? {}) as Record<string, unknown>;
  return {
    deals: aff.deals ?? 0,
    orders: aff.orders ?? 0,
    activeDeals: aff.active_deals ?? 0,
    byUser: (Array.isArray(aff.by_user) ? aff.by_user : []).map((u) => {
      const x = u as Record<string, unknown>;
      return { userId: x.user_id, deals: x.deals, orders: x.orders };
    }),
  };
}

function templateRevisionFe(d: Record<string, unknown>) {
  return {
    version: d.version,
    declaredVariables: d.declared_variables ?? [],
    fileHash: d.file_hash,
    engine: d.engine,
    publishedAt: d.published_at ? d.published_at : null,
    createdBy: d.created_by,
    createdAt: d.created_at,
  };
}

function documentTemplateFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    contextType: d.context_type,
    orderTypeId: d.order_type_id || undefined,
    status: d.status,
    currentRevision: d.current_revision ? d.current_revision : null,
    draftRevision: d.draft_revision ? d.draft_revision : null,
    mimeType: d.mime_type,
    createdBy: d.created_by,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    ...(d.revision ? { revision: templateRevisionFe(d.revision as Record<string, unknown>) } : {}),
  };
}

function documentGroupFe(d: Record<string, unknown>) {
  return {
    groupId: d.group_id,
    projectId: d.project_id,
    contextType: d.context_type,
    contextRecordId: d.context_record_id || undefined,
    templateId: d.template_id || undefined,
    name: d.name,
    // B2: `ownerId` is the CREATOR (the ABAC subject documents gates reads on);
    // `contextOwner*` is the owner of the record the document was made from —
    // reporting only, never a policy input.
    ownerId: d.owner_id,
    ownerDepartmentId: d.owner_department_id || undefined,
    contextOwnerId: d.context_owner_id || undefined,
    contextOwnerDepartmentId: d.context_owner_department_id || undefined,
    currentVersion: d.current_version,
    generatedVia: d.generated_via,
    driftStale: d.drift_stale ?? false,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    emptyRequiredVars: d.empty_required_vars ?? [],
    mimeType: d.mime_type || undefined,
  };
}

function documentVersionFe(d: Record<string, unknown>) {
  return {
    versionId: d.version_id,
    version: d.version,
    mimeType: d.mime_type,
    sizeBytes: toNum(d.size_bytes),
    fileHash: d.file_hash,
    templateId: d.template_id || undefined,
    templateRevision: d.template_revision ? d.template_revision : undefined,
    emptyRequiredVars: d.empty_required_vars ?? [],
    generatedBy: d.generated_by,
    generatedVia: d.generated_via,
    triggerEventId: d.trigger_event_id || undefined,
    createdAt: d.created_at,
  };
}

function driftStatusFe(d: Record<string, unknown>) {
  const changedValuesRaw = d.changed_values;
  const changedValues = Array.isArray(changedValuesRaw)
    ? changedValuesRaw.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          key: String(r.key ?? ''),
          oldValue: String(r.old_value ?? ''),
          newValue: String(r.new_value ?? ''),
        };
      })
    : [];
  return {
    hasDrift: d.has_drift ?? false,
    changedKeys: d.changed_keys ?? [],
    changedValues,
    sourceAvailable: d.source_available ?? true,
  };
}

function generateWarningsFe(d: Record<string, unknown> | undefined) {
  if (!d) return { emptyRequired: [], drift: null };
  return {
    emptyRequired: d.empty_required ?? [],
    drift: d.has_drift ? { changedKeys: d.drift_changed_keys ?? [] } : null,
  };
}

function reportFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    description: d.description,
    kind: d.kind,
    // FR-MREP-8: ключ встроенного пресета — им фронт сопоставляет вкладку с
    // определением отчёта. Без него Reports.tsx падает в индексную эвристику
    // (порядок list() не совпадает с порядком сида → чужой отчёт на вкладке).
    // Пустая строка у пользовательских отчётов нормализуется в null.
    presetKey: d.preset_key || null,
    requiresModules: Array.isArray(d.requires_modules) ? (d.requires_modules as string[]) : [],
    // TODO-466 (FR-REPORTS-390): уровень доступа отчёта отдельным полем. До него
    // фронт хранил выбор радиокнопки в `description` ('Личный'/'Проектный') —
    // то есть уровень доступа не хранился НИГДЕ, и «личный» отчёт возвращался
    // всем участникам проекта. Пустое/неизвестное значение с провода (старая
    // сборка домена) → 'project': это ровно AS-IS-поведение, а не расширение
    // доступа задним числом.
    visibility: reportVisibilityFe(d.visibility),
    spec: parseReportSpecFe(d.spec_json),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Уровни доступа определения отчёта (TODO-466). */
const REPORT_VISIBILITY = ['personal', 'project'] as const;
type ReportVisibility = (typeof REPORT_VISIBILITY)[number];

/** Ответ домена → FE: единственное «личное» значение, всё прочее — 'project'. */
function reportVisibilityFe(v: unknown): ReportVisibility {
  return v === 'personal' ? 'personal' : 'project';
}

/**
 * Тело запроса → домен. `undefined` (клиент поля не прислал) сохраняем как
 * `undefined`, чтобы PATCH без `visibility` не сбрасывал уровень доступа: на
 * проводе это пустая строка, а её домен трактует как «не менять» (та же
 * семантика, что у остальных полей UpdateReportRequest). Значение вне словаря
 * не пропускаем в домен вовсе — не превращаем опечатку клиента в 'personal'
 * (и наоборот): создаётся отчёт с дефолтом 'project'.
 */
function reportVisibilityToGrpc(v: unknown): ReportVisibility | undefined {
  return REPORT_VISIBILITY.includes(v as ReportVisibility) ? (v as ReportVisibility) : undefined;
}

/** spec_json с домена → объект для FE (edit custom в конструкторе, TODO-474). */
function parseReportSpecFe(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function automationRuleFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    description: d.description,
    enabled: d.enabled,
    triggerType: d.trigger_type,
    triggerConfigJson: d.trigger_config_json,
    conditionsJson: d.conditions_json,
    actionsJson: d.actions_json,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    lastExecutedAt: d.last_executed_at,
    state: d.state,
    priority: d.priority,
    createdBy: d.created_by,
    notifyOnFailure: d.notify_on_failure,
    unexecutable: d.unexecutable,
    disabledReason: d.disabled_reason ?? '',
    deletedAt: d.deleted_at ?? 0,
    stats: parseMaybeJson(d.stats_json),
    // automation-v2: engine discriminator + deserialized graph for the canvas.
    engineVersion: d.engine_version ?? 1,
    graph: parseMaybeJson(d.graph_json),
    graphHash: d.graph_hash || undefined,
  };
}

/** Map an FE graph ({nodes,edges,viewport}) to the proto GraphSpec (nested message). */
function automationGraphToGrpc(graph: unknown): Record<string, unknown> | undefined {
  if (!graph || typeof graph !== 'object') return undefined;
  const g = graph as Record<string, unknown>;
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const position = (n: Record<string, unknown>) =>
    (n.position && typeof n.position === 'object' ? n.position : {}) as Record<string, unknown>;
  return {
    version: typeof g.version === 'number' ? g.version : 2,
    nodes: nodes.map((raw) => {
      const n = (raw ?? {}) as Record<string, unknown>;
      const pos = position(n);
      return {
        id: String(n.id ?? ''),
        type: String(n.type ?? ''),
        position_x: Number(pos.x ?? 0),
        position_y: Number(pos.y ?? 0),
        config_json:
          n.config && typeof n.config === 'object'
            ? JSON.stringify(n.config)
            : String(n.config ?? '{}'),
      };
    }),
    edges: edges.map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      return {
        id: String(e.id ?? ''),
        source: String(e.source ?? ''),
        source_handle: String(e.sourceHandle ?? e.source_handle ?? ''),
        target: String(e.target ?? ''),
        target_handle: String(e.targetHandle ?? e.target_handle ?? 'in'),
      };
    }),
    viewport_json: g.viewport ? JSON.stringify(g.viewport) : '',
  };
}

/** Map a domain NodeTypeDef (snake_case wire) to the FE shape. */
function automationNodeTypeFe(d: Record<string, unknown>) {
  return {
    type: d.type,
    subtype: d.subtype || undefined,
    requiredModule: d.required_module,
    externalEffect: d.external_effect,
    entityType: d.entity_type || undefined,
    configSchema: parseMaybeJson(d.config_schema_json) ?? {},
    outputSchema: parseMaybeJson(d.output_schema_json) ?? {},
    outHandles: d.out_handles ?? [],
  };
}

/** Map a domain GraphValidationIssue (snake_case wire) to the FE shape. */
function automationGraphIssueFe(d: Record<string, unknown>) {
  return {
    code: d.code,
    nodeId: d.node_id || undefined,
    edgeId: d.edge_id || undefined,
    message: d.message,
    severity: d.severity,
  };
}

function parseMaybeJson(raw: unknown): unknown {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function automationExecutionFe(d: Record<string, unknown>) {
  return {
    executionId: d.execution_id,
    ruleId: d.rule_id,
    projectId: d.project_id,
    status: d.status,
    skipReason: d.skip_reason || undefined,
    source: d.source,
    triggerEventName: d.trigger_event_name || undefined,
    entityType: d.entity_type || undefined,
    entityId: d.entity_id || undefined,
    payloadJson: d.payload_json,
    resultJson: d.result_json,
    actionResults: parseMaybeJson(d.action_results_json) ?? [],
    traceId: d.trace_id || undefined,
    causationId: d.causation_id || undefined,
    dryRun: d.dry_run,
    createdAt: d.created_at,
    finishedAt: d.finished_at || undefined,
    graphPath: parseMaybeJson(d.graph_path_json) ?? undefined,
  };
}

function automationConnectionFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    url: d.url,
    headers: parseMaybeJson(d.headers_json) ?? {},
    enabled: d.enabled,
    secretSet: d.secret_set,
    breakerState: d.breaker_state,
    breakerFailures: d.breaker_failures,
    createdBy: d.created_by,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function automationDlqFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    projectId: d.project_id,
    executionId: d.execution_id,
    ruleId: d.rule_id,
    actionIndex: d.action_index,
    actionType: d.action_type,
    connectionId: d.connection_id || undefined,
    status: d.status,
    attempts: d.attempts,
    lastError: d.last_error || undefined,
    lastHttpCode: d.last_http_code || undefined,
    nextRetryAt: d.next_retry_at || undefined,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

@ApiBearerAuth()
@UseGuards(GatewayModuleGuard, ProjectAccessGuard)
@UseInterceptors(AssigneeNameInterceptor)
@Controller({ path: '', version: '1' })
export class CrmBffController implements OnModuleInit {
  private readonly logger = new Logger(CrmBffController.name);
  private pipe!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private orders!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private product!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private activity!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private documents!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private reports!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private automation!: Record<string, (x: unknown, m?: unknown) => unknown>;
  /** Только чтение цепочки (TODO-414): запись в audit — internal `AppendEvent`, не отсюда. */
  private audit?: Record<string, (x: unknown, m?: unknown) => unknown>;
  private project!: {
    listMembers: (x: unknown, m?: unknown) => unknown;
    getProject: (x: { id: string }, m?: unknown) => unknown;
  };
  /**
   * Счётчик одновременных выгрузок продаж (`GET /v1/orders/export`). Поле контроллера,
   * а не модульный синглтон: контроллер в Nest и так один на процесс, зато у каждого
   * теста свой экземпляр и лимит не протекает между кейсами.
   */
  private readonly exportInflight = new ExportInflightLimiter();

  constructor(
    @Inject('PIPE_GRPC') private pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private ordersClient: ClientGrpcProxy,
    @Inject('PRODUCT_GRPC') private productClient: ClientGrpcProxy,
    @Inject('ACTIVITY_GRPC') private activityClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private documentsClient: ClientGrpcProxy,
    @Inject('REPORTS_GRPC') private reportsClient: ClientGrpcProxy,
    @Inject('AUTOMATION_GRPC') private automationClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private controlClient: ClientGrpcProxy,
    @Inject('CONTACT_GRPC') private contactClient: ClientGrpcProxy,
    @Inject('COMPANY_GRPC') private companyClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly docStorage: DocumentStorageService,
    // X4: the ONE authoritative name of the documents bucket. It is read here so a
    // storage pointer arriving in a request BODY can be checked against it instead
    // of being trusted (see `trustedClientPointer`).
    private readonly config: AppConfigService,
    // TODO-207: тот же резолвер id→ФИО, что и у `AssigneeNameInterceptor`; нужен
    // выгрузке продаж, которая сериализуется в Buffer ДО интерцептора (см.
    // `fillOrderAssigneeNames`).
    private readonly identity: IdentityResolverService,
    // Подстановка ФИО менеджеров / названий отделов в результат прогона отчёта
    // (см. runReport ниже): домен отдаёт в `data_json` только id.
    private readonly reportRunNames: ReportRunNamesService,
    // TODO-414: клиент audit добавлен ПОСЛЕДНИМ параметром намеренно — позиционные
    // конструкторы в уже существующих спеках контроллера остаются валидными
    // (в них он просто не передаётся), а DI резолвит клиента по токену.
    @Inject('AUDIT_GRPC') private auditClient?: ClientGrpcProxy,
  ) {}

  /**
   * X4 — a storage pointer that arrived in the request BODY is client input, not a
   * fact; it is held to the configured bucket + the project key prefix. The rule
   * itself lives in `./trusted-client-pointer` because the chat BFF feeds the same
   * `documents.uploadDocument` from a body-supplied pointer too — see the file for
   * why an unchecked bucket is an SSRF neighbour.
   */
  private trustedClientPointer(
    projectId: string,
    b: Record<string, unknown>,
    defaultMime: string,
  ): TrustedClientPointer {
    return trustedClientPointer({
      allowedBucket: this.config.s3DocumentsBucket,
      requiredKeyPrefix: `${projectId}/`,
      body: b,
      defaultMime,
    });
  }

  /**
   * m5: сам разбор multipart живёт в `./multipart` — та же реализация используется
   * и в v1-data-bff (импорт компаний), чтобы обработка лимита 20 МБ и текст ошибки
   * существовали в одном экземпляре.
   */
  private async readMultipart(req: GrpcReq): Promise<MultipartUpload | null> {
    return readMultipart(req);
  }

  // BX-FIX-3: the authoritative projectId for an upload is the one the access guards
  // (ProjectAccessGuard / GatewayModuleGuard) enforced on — the query param, else the
  // x-project-id header — NEVER a `projectId` carried in the request body (multipart
  // form field or JSON), which the guards do not read. Trusting the body lets a member
  // of project A write into project B (confused-deputy / cross-project write IDOR). We
  // resolve the guard's projectId, reject an empty one (so it cannot slip past the
  // guards' `if(!projectId) return true` bypass), and 403 on any mismatching body value.
  private authoritativeProjectId(req: GrpcReq, qpid: string | undefined, claimed: unknown): string {
    const headerPid = req.headers?.['x-project-id'];
    const authoritative = String(
      qpid ?? (typeof headerPid === 'string' ? headerPid : '') ?? '',
    ).trim();
    if (!authoritative) {
      throw new BadRequestException('projectId is required');
    }
    const claimedStr = claimed == null ? '' : String(claimed).trim();
    if (claimedStr && claimedStr !== authoritative) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'projectId in the request body does not match the authorized project',
      });
    }
    return authoritative;
  }

  private meta(req: FastifyRequest & { user?: { userId?: string } }, projectId?: string) {
    // TODO-043 / TODO-047: the FE sends the project only as the `x-project-id`
    // header (axios interceptor) — most mutation helpers do not add `?projectId=`.
    // Handlers here used to forward the query value alone, so downstream
    // `x-project-id` metadata went out empty: domains filtered by {projectId: ''}
    // (NOT_FOUND on every deal/order mutation) and create-paths wrote documents
    // outside any project. Resolve exactly like ProjectAccessGuard does
    // (explicit param first, then the header the guard authorized) so the domain
    // always receives the project the request was authorized against.
    const headerPid = req.headers?.['x-project-id'];
    const pid =
      String(projectId ?? '').trim() || (typeof headerPid === 'string' ? headerPid.trim() : '');
    return this.outboundMeta.build(req, pid ? { projectId: pid } : undefined);
  }

  /** NFR-ACT-100: scope one client Idempotency-Key per bulk item. */
  private metaWithScopedIdempotency(
    req: FastifyRequest & { user?: { userId?: string } },
    projectId: string,
    scopeSuffix: string,
  ) {
    const raw = req.headers?.['idempotency-key'];
    const base = typeof raw === 'string' ? raw.trim() : '';
    if (!base) return this.meta(req, projectId);
    const scopedReq = {
      ...req,
      headers: { ...req.headers, 'idempotency-key': `${base}:${scopeSuffix}` },
    };
    return this.outboundMeta.build(scopedReq, { projectId });
  }

  /**
   * Resolve the document variable map from the context donor (documents contract
   * §4). documents is NOT a data source (FR-MDOC-6) — the gateway proxies the
   * donor's `ResolveDocumentVariables` for the record's context and forwards the
   * flat `values`/`source_hash`/`empty_required` to documents.
   *
   * `context_type` → donor: `contact`→contact, `company`→company, `deal`→pipe,
   * `order`→orders. The donor is the PEP: it scopes `project_id`, applies the
   * caller's visibility (invisible/cross-project record → NOT_FOUND/PERMISSION_DENIED)
   * and requires the service-API-key — the same metadata (`this.meta`) is passed.
   *
   * Ошибки ДЕТЕРМИНИРОВАНЫ (TODO-077 / FR-DOCS-115): PERMISSION_DENIED → 403,
   * NOT_FOUND → 404, любой другой отказ донора (UNAVAILABLE/DEADLINE_EXCEEDED/
   * UNIMPLEMENTED/INTERNAL) → 503 + warn-лог. Пустая карта возвращается только
   * там, где донора нет по определению: нет recordId либо contextType без донора
   * ('none', upload-контексты). Значения и хеши не логируются (PII).
   */
  private async resolveDocumentVariables(
    req: GrpcReq,
    projectId: string,
    contextType: string,
    recordId: string,
  ): Promise<{ values_json: string; source_hash: string; empty_required: string[] }> {
    const empty = { values_json: '{}', source_hash: '', empty_required: [] as string[] };
    if (!recordId) return empty;
    type DonorSvc = Record<string, (x: unknown, m?: unknown) => unknown>;
    const donor: DonorSvc | undefined =
      contextType === 'contact'
        ? (this.contactClient.getService('ContactGrpc') as DonorSvc)
        : contextType === 'company'
          ? (this.companyClient.getService('CompanyGrpc') as DonorSvc)
          : contextType === 'deal'
            ? this.pipe
            : contextType === 'order'
              ? this.orders
              : undefined;
    // TODO-077 / FR-DOCS-115: пустая карта переменных — легитимный ответ ТОЛЬКО для
    // контекста, у которого донора нет по определению ('none' и upload-контексты вроде
    // 'chat'). Для настоящего контекста (order/deal/contact/company) отсутствие RPC у
    // клиента-донора — это разрыв проводки, а не «переменных нет»: сгенерировать по
    // такому ответу документ значит выпустить его с молча пустыми полями.
    if (!donor) return empty;
    if (typeof donor.resolveDocumentVariables !== 'function') {
      throw this.donorVariablesUnavailable(contextType, 'UNIMPLEMENTED');
    }
    try {
      const r = (await grpcBffCall(
        donor.resolveDocumentVariables(
          { project_id: projectId, record_id: recordId },
          this.meta(req, projectId),
        ) as never,
      )) as {
        values?: Record<string, string>;
        source_hash?: string;
        empty_required?: string[];
      };
      return {
        values_json: JSON.stringify(r.values ?? {}),
        source_hash: String(r.source_hash ?? ''),
        empty_required: r.empty_required ?? [],
      };
    } catch (e) {
      // GAP-DOCS-115/185: fail-soft must cover TRANSIENT donor faults only. Swallowing
      // PERMISSION_DENIED/NOT_FOUND here meant a document could be issued (with an empty
      // variable map and an empty source_hash) against a record the caller may not read —
      // an authorization bypass dressed up as an empty template. The donor is the PEP, so
      // its verdict has to reach the client.
      const code = grpcCodeToString((e as { code?: unknown })?.code);
      if (code === 'PERMISSION_DENIED') {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Нет доступа к записи-источнику документа',
        });
      }
      if (code === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Запись-источник документа не найдена',
        });
      }
      // TODO-077 (хвост карточки): раньше здесь оставалась пустая карта для ЛЮБОГО
      // прочего кода — донор лежит/таймаут/RPC не реализован → документ всё равно
      // выпускался с `values_json='{}'` и `source_hash=''`, то есть с пустыми полями
      // и без привязки к источнику (и без единой строчки в логе). FR-DOCS-115 требует
      // обратного: при недоступности донора версия НЕ создаётся, клиент получает 503 и
      // может повторить. Пустая карта остаётся только там, где донора нет по
      // определению (ветки выше: нет recordId / contextType без донора).
      // Читающие пути этим не ломаются: `checkDrift` ловит 503 и честно отвечает
      // `source_available: false`, скачивание/просмотр сюда вообще не заходят.
      throw this.donorVariablesUnavailable(contextType, code);
    }
  }

  /**
   * TODO-077 — единая точка отказа донора переменных: warn-лог (причина отказа
   * фиксируется, чего в карточке не хватало) + 503 для клиента.
   *
   * В лог идут только contextType и код gRPC — ни значений переменных, ни
   * идентификаторов записей (PII, документная политика §4).
   */
  private donorVariablesUnavailable(
    contextType: string,
    code: string,
  ): ServiceUnavailableException {
    this.logger.warn(
      `ResolveDocumentVariables: донор контекста "${contextType}" недоступен (${code}) — ` +
        'документ не выпускается (FR-DOCS-115)',
    );
    return new ServiceUnavailableException({
      code: 'UNAVAILABLE',
      message: 'Источник данных документа временно недоступен, попробуйте позже',
    });
  }

  /**
   * TODO-098 — «мягкая» зависимость documents от доноров контекста.
   *
   * Жёсткое ребро documents → orders снято в MODULE_REGISTRY (documents работает и
   * без продаж), но вторая половина карточки — вычисляемая зависимость: контекст,
   * чей модуль-донор в проекте ВЫКЛЮЧЕН, не должен предлагаться при создании
   * шаблона и не должен приниматься при генерации. Иначе выключенный orders даёт
   * шаблон с мёртвым контекстом и генерацию, которая падает на доноре невнятным
   * отказом (домен-донор гейтит себя `@RequireModule('orders')` → PERMISSION_DENIED,
   * т.е. пользователь видит «нет доступа к записи» вместо «модуль выключен»).
   *
   * Гейтим только записи (создание шаблона, генерация). Чтение/скачивание уже
   * выпущенных документов не блокируется — это прямое требование карточки.
   *
   * Источник истины о включённых модулях — `req.__enabledModules`, который кладёт
   * `GatewayModuleGuard` (server-trusted, не из тела запроса). Если массива нет,
   * значит гард не отработал (маршрут без projectId либо прямой вызов контроллера
   * в unit-тесте) — сравнивать не с чем, и выдумывать пустой набор нельзя: он
   * запретил бы ВСЕ контексты. Сам факт, что до хендлера дошли, уже означает, что
   * гейт `@RequireModule('documents')` того же гарда пропустил запрос.
   */
  private assertContextModuleEnabled(req: GrpcReq, contextType: unknown): void {
    const ct = typeof contextType === 'string' ? contextType : '';
    if (!isDocumentContextTypeOrNone(ct)) return;
    const moduleId = documentContextModuleId(ct);
    if (!moduleId) return;
    const modules = (req as unknown as Record<string, unknown>).__enabledModules;
    if (!Array.isArray(modules)) return;
    if (!(modules as unknown[]).includes(moduleId)) {
      throw new ConflictException({
        code: 'CONTEXT_UNAVAILABLE',
        module: moduleId,
        message: `Контекст недоступен: модуль «${moduleId}» выключен в проекте`,
      });
    }
  }

  /** Hide templates whose donor module is disabled for the project (FR-DOCS-325). */
  private filterTemplatesByEnabledModules(
    req: GrpcReq,
    items: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const modules = (req as unknown as Record<string, unknown>).__enabledModules;
    if (!Array.isArray(modules)) return items;
    return items.filter((item) => {
      const ct = String(item.context_type ?? item.contextType ?? '');
      if (!isDocumentContextType(ct)) return true;
      const moduleId = documentContextModuleId(ct);
      return !moduleId || (modules as unknown[]).includes(moduleId);
    });
  }

  /**
   * GAP-DOCS-190 / B2 — CONTEXT-owner snapshot of the record a document documents.
   *
   * History (the bug this shape fixes): the resolved owner used to be sent as
   * `GenerateDocumentRequest.owner_id/owner_department_id`, and documents stores
   * that field as `ownerId` — which is the ABAC field its read gate checks
   * (`isRecordVisible(scope, group.ownerId)`, documents.service.ts). Result: a
   * member with "only own" visibility who generated a document on a deal shared
   * with them created a document owned by the deal's assignee and was 404'd on
   * his OWN document by the very next GET. Denormalising a *reporting* attribute
   * into a *policy* field is the defect; the two are separated now:
   *
   *   - `owner_id` (documents) stays the CREATOR — the PEP field, never spoofed;
   *   - `context_owner_id`/`context_owner_department_id` (proto 12/13 on Generate
   *     and Upload) carry the donor record's owner for reporting/analytics.
   *
   * Reuses the same Get<Entity> RPCs (and the same PEP/visibility) the BFF already
   * calls elsewhere. Errors are DETERMINISTIC — a donor fault propagates
   * (403/404/503) instead of silently degrading to an empty snapshot: the previous
   * blanket `catch {}` made the stored owner depend on the health of a neighbouring
   * service, i.e. the same action produced different data on different days.
   *
   * `context_owner_department_id` is only populated for entities that actually
   * carry a department attribute — deal (pipe.proto Deal.department_id) and company
   * (company.proto Company.department_id). Order and contact have no department
   * field in their contracts at all (orders has no `departmentId` anywhere in the
   * domain), so the uniform `??''` mapping yields '' for them by construction, not
   * by a hardcoded literal (m3).
   */
  private async resolveContextOwner(
    req: GrpcReq,
    projectId: string,
    contextType: string,
    recordId: string,
  ): Promise<{ context_owner_id: string; context_owner_department_id: string }> {
    const none = { context_owner_id: '', context_owner_department_id: '' };
    if (!recordId || contextType === 'none') return none;
    type Svc = Record<string, (x: unknown, m?: unknown) => unknown>;
    // contextType → donor RPC + the attribute that names the record's owner.
    // Unknown/unsupported context (e.g. `chat` uploads): nothing to snapshot.
    const donors: Record<string, { svc: () => Svc; method: string; owner: string }> = {
      deal: { svc: () => this.pipe as Svc, method: 'getDeal', owner: 'assignee_id' },
      order: { svc: () => this.orders as Svc, method: 'getOrder', owner: 'assignee_id' },
      contact: {
        svc: () => this.contactClient.getService('ContactGrpc') as Svc,
        method: 'getContact',
        owner: 'owner_id',
      },
      company: {
        svc: () => this.companyClient.getService('CompanyGrpc') as Svc,
        method: 'getCompany',
        owner: 'owner_id',
      },
    };
    const donor = donors[contextType];
    if (!donor) return none;
    const svc = donor.svc();
    // A donor client that does not expose the RPC at all is a WIRING gap, not a
    // verdict about the record (same treatment as `resolveDocumentVariables`):
    // there is simply nothing to snapshot, and this value is reporting-only —
    // it is NOT an authorization input. A donor that DOES answer with an error
    // is handled below and never degrades silently.
    if (typeof svc?.[donor.method] !== 'function') return none;
    try {
      const r = (await grpcBffCall(
        svc[donor.method](
          { project_id: projectId, id: recordId },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>;
      // One mapping for every donor: owner attribute + department attribute
      // (absent on order/contact ⇒ '').
      return {
        context_owner_id: String(r[donor.owner] ?? ''),
        context_owner_department_id: String(r.department_id ?? ''),
      };
    } catch (e) {
      // Deterministic, like `resolveDocumentVariables`: the donor is the PEP for the
      // source record, so its verdict reaches the client. A transient fault is a
      // 503 (retryable) — NOT a silent owner change.
      const code = grpcCodeToString((e as { code?: unknown })?.code);
      if (code === 'PERMISSION_DENIED') {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Нет доступа к записи-источнику документа',
        });
      }
      if (code === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Запись-источник документа не найдена',
        });
      }
      throw new ServiceUnavailableException({
        code: 'UNAVAILABLE',
        message: 'Не удалось определить владельца записи-источника документа',
      });
    }
  }

  /**
   * FR-ORDERS-255: order document path — drift-gate + `crm.order.document_requested`
   * before variables are handed to documents.
   */
  private async resolveOrderDocumentVariables(
    req: GrpcReq,
    projectId: string,
    orderId: string,
    templateId: string,
    acceptDrift: boolean,
  ): Promise<{ values_json: string; source_hash: string; empty_required: string[] }> {
    if (!orderId) {
      return { values_json: '{}', source_hash: '', empty_required: [] };
    }
    if (!templateId) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'templateId обязателен для генерации документа по продаже',
      });
    }
    try {
      const r = (await grpcBffCall(
        this.orders.requestOrderDocument(
          {
            project_id: projectId,
            order_id: orderId,
            template_id: templateId,
            accept_drift: acceptDrift,
          },
          this.meta(req, projectId),
        ) as never,
      )) as {
        values?: Record<string, string>;
        source_hash?: string;
        empty_required?: string[];
      };
      return {
        values_json: JSON.stringify(r.values ?? {}),
        source_hash: String(r.source_hash ?? ''),
        empty_required: r.empty_required ?? [],
      };
    } catch (e) {
      const code = grpcCodeToString((e as { code?: unknown })?.code);
      if (code === 'FAILED_PRECONDITION') {
        const msg = String((e as { message?: string }).message ?? '');
        if (msg.includes('DRIFT_NOT_ACCEPTED')) {
          throw new ConflictException({
            code: 'DRIFT_NOT_ACCEPTED',
            message: 'Перед генерацией документа примите изменения реквизитов',
          });
        }
      }
      if (code === 'PERMISSION_DENIED') {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Нет доступа к записи-источнику документа',
        });
      }
      if (code === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Запись-источник документа не найдена',
        });
      }
      throw new ServiceUnavailableException({
        code: 'UNAVAILABLE',
        message: 'Не удалось получить переменные продажи для документа',
      });
    }
  }

  /**
   * TODO-207 — денормализованные имена продажи.
   *
   * Домен orders их не пишет: `createOrder` кладёт в документ только *Id
   * (orders.service.ts, поле productName/dealName/contactName/companyName там
   * отсутствует), `toOrder` читает `doc.productName ?? ''` — и список, канбан,
   * карточка и CSV-экспорт продаж показывали пустые колонки «Продукт», «Сделка»,
   * «Контакт», «Компания».
   *
   * Join делается на gateway по образцу `AssigneeNameInterceptor`: это
   * единственная точка, знающая и запись (id в продаже), и справочники соседних
   * доменов. Читаем теми же `Get<Entity>`-RPC и исходящей метадатой ЭТОГО же
   * запроса, но с одной обязательной заменой: `x-access-predicate` пересобирается
   * под subject донора (`donorGate`). Маршрутный предикат скомпилирован под
   * `orders` и в чужом домене был бы одновременно дырой (условный allow донора
   * не применился бы вовсе) и багом (условие `record.assigneeId == user.id`
   * не совпало бы ни с одной записью contacts, где владелец — `ownerId`).
   * Видимость (`x-visibility-scope`) донор применяет ту же самую: mode/ownerIds
   * резолвятся от роли, а не от ресурса (visibility-resolver.service.ts).
   *
   * Инварианты:
   *  - project_id берётся из авторизованного контекста (query → x-project-id),
   *    НИКОГДА из тела/строки ответа;
   *  - непустое имя от домена не перетирается — если orders когда-нибудь начнёт
   *    денормализовать имена при записи, ветка резолва просто не сработает
   *    (и лишних gRPC-вызовов не будет);
   *  - fail-soft: ошибка/недоступность соседнего домена оставляет имя пустым,
   *    но не роняет ответ по продажам;
   *  - резолв живёт ровно один запрос (кэша между запросами нет) — общий кэш
   *    имён отдал бы пользователю B имя записи, видимой только пользователю A;
   *  - `subject` — id модуля-донора в реестре (он же subject политики). Резолв
   *    идёт ТОЛЬКО по донорам, чтение которых разрешено проекту и политикой, и
   *    ТОЛЬКО с ABAC-предикатом самого донора (`donorGate`): выключенный модуль,
   *    project-wide deny `<subject>:read` и условные правила донора — три вердикта,
   *    которые за gateway не применит никто.
   */
  private orderNameKinds() {
    type Svc = Record<string, (x: unknown, m?: unknown) => unknown>;
    return [
      {
        idKey: 'productId',
        subject: 'products',
        nameKey: 'productName',
        svc: () => this.product as Svc,
        method: 'getProduct',
        name: (r: Record<string, unknown>) => String(r.name ?? '').trim(),
      },
      {
        idKey: 'dealId',
        subject: 'deals',
        nameKey: 'dealName',
        svc: () => this.pipe as Svc,
        method: 'getDeal',
        name: (r: Record<string, unknown>) => String(r.name ?? '').trim(),
      },
      {
        idKey: 'contactId',
        subject: 'contacts',
        nameKey: 'contactName',
        svc: () => this.contactClient.getService('ContactGrpc') as Svc,
        method: 'getContact',
        // Тот же порядок ФИО, что и в снапшоте контакта на `deals/:id/link-contact`.
        name: (r: Record<string, unknown>) =>
          [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ').trim(),
      },
      {
        idKey: 'companyId',
        subject: 'companies',
        nameKey: 'companyName',
        svc: () => this.companyClient.getService('CompanyGrpc') as Svc,
        method: 'getCompany',
        name: (r: Record<string, unknown>) => String(r.name ?? '').trim(),
      },
    ];
  }

  /**
   * BX-ORD-NAMES-2/-3 — можно ли резолвить имя у донора и С КАКОЙ метадатой к нему идти.
   *
   * `fillOrderNames` ходит в чужие домены (products/deals/contacts/companies)
   * с маршрута, чей собственный гейт — `orders:read`. Три вердикта уровнем выше
   * запись-в-запись не применит за gateway никто:
   *
   *  1) МОДУЛЬНАЯ ИЗОЛЯЦИЯ. Выключенный в проекте модуль-донор не защищён сам:
   *     `ModuleGuard` в contact/company/pipe не зарегистрирован, домен ответит.
   *     Единственная точка, знающая эффективный набор модулей, — гейт gateway
   *     (`GatewayModuleGuard` кладёт его в `req.__enabledModules`).
   *  2) POLICY OVERLAY. Project-wide `deny <subject>:read` (§4e) применяется
   *     `ProjectAccessGuard`ом к subject'у САМОГО маршрута; для донора его не
   *     применяет никто. Иначе пользователь, которому политикой проекта запрещено
   *     чтение контактов, видел бы их ФИО в списке/канбане/карточке/CSV продаж.
   *     Условие правила здесь не смотрим намеренно — ровно как `isDeniedByPolicy`
   *     (project-access.guard.ts): для гейта маршрута условный deny — тоже 403.
   *  3) ABAC ДОНОРА (условные правила, RFC-5 §1.4 / FR-ABAC-6). Домен предикат
   *     применяет честно (`contact.grpc.controller.ts` → `contacts.findOne(…,
   *     readAccessPredicate)`), но в метадате маршрута лежит предикат,
   *     скомпилированный под subject `orders` (`ProjectAccessGuard` :421 →
   *     `compileAccessPredicate(subject маршрута)`, а `ruleApplies` фильтрует
   *     правила по subject). В contacts уезжало нечто, где условий про contacts
   *     нет вовсе: сужающий грант «allow contacts:read where record.ownerId ==
   *     user.id» не применялся — утечка ФИО/названий тому, кому прямой
   *     GET /v1/contacts их не отдаёт; а orders-условие (`record.assigneeId ==
   *     user.id`) приклеивалось к запросу в contacts, где владелец зовётся
   *     `ownerId` (contacts.service.ts), — и имена молча пустели у всех.
   *     Поэтому предикат ПЕРЕСОБИРАЕТСЯ под subject донора и уезжает вместо
   *     маршрутного: сужение по-прежнему уходит в БД донора предикатом, а не
   *     фильтром в памяти gateway.
   *
   * Роль (RBAC) здесь не проверяется осознанно: матрица `projectRoleCan` не имеет
   * оси subject — тот, кто прошёл `orders:read`, по роли может `read` и на любом
   * другом subject'е. Проверка была бы тавтологией, а не защитой.
   *
   * Fail-closed (возвращаем `null` — донор не опрашивается, имя остаётся пустым,
   * ответ по продажам не ломается):
   *  - нет `__enabledModules`/`__policySnapshot` или снапшот битый: гейты класса
   *    (`@UseGuards(GatewayModuleGuard, …)` + `@RequireModule('orders')` на каждом
   *    маршруте продаж) кладут оба значения ВСЕГДА вместе и до хендлера, так что
   *    их отсутствие = гейты не отработали;
   *  - у донора ЕСТЬ применимые условные правила, а предиката нет: не удалось
   *    скомпилировать или в условии контекст, неразрешимый на gateway
   *    (`UNRESOLVABLE_CONTEXT_REFS` — департаменты/владение проектом), либо нет
   *    userId для partial-eval. На маршруте отсутствие предиката значит «как до
   *    push-down» (домен всё равно PEP своего гейта), здесь значило бы «отдай имя
   *    мимо ABAC донора» — поэтому имя не резолвим вовсе.
   */
  private donorGate(req: GrpcReq, projectId: string): (subject: string) => unknown | null {
    const reqRec = req as unknown as Record<string, unknown>;
    const modulesRaw = reqRec.__enabledModules;
    const snapshotRaw = reqRec.__policySnapshot;
    const closed = () => null;
    if (!Array.isArray(modulesRaw) || typeof snapshotRaw !== 'string') return closed;
    const modules = new Set(modulesRaw.map((m) => String(m)));

    let rules: AbacPolicyRule[];
    try {
      const parsed = JSON.parse(snapshotRaw) as unknown;
      if (!Array.isArray(parsed)) return closed;
      rules = parsed as AbacPolicyRule[];
    } catch {
      return closed;
    }

    const userId = String(req.user?.userId ?? '').trim();
    // Тот же partial-eval контекст, что у `ProjectAccessGuard.resolveAccessPredicate`:
    // департаментные/владельческие атрибуты на gateway не резолвятся, правило с ними
    // компилятор отложит целиком (UNRESOLVABLE_CONTEXT_REFS) → fail-closed выше.
    const ctx: AbacEvalContext = {
      user: {
        id: userId,
        departmentId: null,
        departmentChain: [],
        leaderOfDepartmentIds: [],
        role: req.__projectRole ?? '',
      },
      project: { id: projectId, ownerType: '', ownerId: '' },
    };

    return (subject: string) => {
      if (!modules.has(subject)) return null;
      // Тот же предикат, что и `ProjectAccessGuard.isDeniedByPolicy`: deny выигрывает,
      // allow — no-op (правило не несёт оси роли и ничего сверх RBAC не выдаёт).
      if (
        rules.some(
          (r) =>
            r.effect === 'deny' &&
            r.subject === subject &&
            r.action === 'read' &&
            (!r.resource || r.resource === '*'),
        )
      ) {
        return null;
      }

      let predicate: string | undefined;
      if (rules.some((r) => donorRuleApplies(r, subject))) {
        // Условные правила у донора есть ⇒ идти без предиката нельзя.
        if (!userId) return null;
        try {
          predicate = compileAccessPredicate({ rules, subject, action: 'read', ctx });
        } catch {
          return null;
        }
        if (!predicate) return null;
      }

      // Прототипная копия запроса: `build` читает `headers`/`user` через геттеры
      // Fastify (спред их потеряет), а собственное поле `__accessPredicate`
      // перекрывает маршрутное — включая случай `undefined`, когда у донора
      // условных правил нет и сужать нечем (маршрутный orders-предикат к чужому
      // домену не относится и уезжать не должен).
      const donorReq = Object.create(req as object) as GrpcReq & { __accessPredicate?: string };
      donorReq.__accessPredicate = predicate;
      return this.outboundMeta.build(donorReq, { projectId });
    };
  }

  /**
   * Заполняет пустые *Name в уже смапленных (orderFe) строках продаж. Мутирует на месте.
   *
   * `opts.budget` передаёт ТОЛЬКО выгрузка: у неё, в отличие от страницы списка,
   * количество одиночных Get*-вызовов растёт с размером набора (до 4 на строку),
   * поэтому там действует общий потолок вызовов и общий дедлайн запроса. Всё, что
   * в бюджет не поместилось, помечается (`budget.namesIncomplete`) и доезжает до
   * пользователя примечанием в файле — деградация объявленная, а не молчаливая.
   */
  private async fillOrderNames<T extends Record<string, unknown>>(
    req: GrpcReq,
    projectId: string | undefined,
    rows: T[],
    opts: { maxIds?: number; budget?: ExportBudget } = {},
  ): Promise<T[]> {
    const maxIds = opts.maxIds ?? ORDER_NAME_MAX_IDS;
    const budget = opts.budget;
    if (rows.length === 0) return rows;
    const headerPid = req.headers?.['x-project-id'];
    const pid =
      String(projectId ?? '').trim() || (typeof headerPid === 'string' ? headerPid.trim() : '');
    if (!pid) return rows;
    // Вердикт по subject'у донора (модуль включён + нет project-wide deny
    // `<subject>:read`) и метадата ИМЕННО для него — с ABAC-предикатом донора,
    // а не маршрутного `orders` (см. `donorGate`). Запрещённый донор просто не
    // опрашивается: имя остаётся пустым, как при недоступной записи.
    const gate = this.donorGate(req, pid);

    await Promise.all(
      this.orderNameKinds().map(async (kind) => {
        const md = gate(kind.subject);
        if (!md) return;
        // id → строки, которым это имя нужно (дедуп: один Get на уникальный id).
        const pending = new Map<string, T[]>();
        for (const row of rows) {
          const id = String(row[kind.idKey] ?? '').trim();
          if (!id || String(row[kind.nameKey] ?? '').trim()) continue;
          const bucket = pending.get(id);
          if (bucket) bucket.push(row);
          else if (pending.size < maxIds) pending.set(id, [row]);
          // Потолок уникальных id исчерпан: строка останется без имени. Для списка это
          // штатная деградация «сверх 200-й строки», для выгрузки — факт, о котором
          // пользователю сообщают примечанием в файле.
          else budget?.markNamesIncomplete();
        }
        if (pending.size === 0) return;
        const svc = kind.svc();
        // Клиент без такой RPC — дыра проводки, а не вердикт о записи: резолвить нечем.
        if (typeof svc?.[kind.method] !== 'function') return;

        const ids = [...pending.keys()];
        for (let i = 0; i < ids.length; i += ORDER_NAME_CONCURRENCY) {
          const slice = ids.slice(i, i + ORDER_NAME_CONCURRENCY);
          // Общий бюджет выгрузки (только у неё): время запроса и суммарное число
          // Get*-вызовов на ВСЕ четыре вида имён. Резолв — деградируемая часть
          // ответа: исчерпан бюджет — выходим, а не тянем ещё тысячу RPC.
          if (budget) {
            if (!budget.hasTime()) {
              budget.markTimedOut();
              budget.markNamesIncomplete();
              return;
            }
            const allowed = budget.takeCalls(slice.length);
            if (allowed === 0) return;
            slice.length = allowed;
          }
          await Promise.all(
            slice.map(async (id) => {
              let name = '';
              try {
                const r = (await grpcBffCall(
                  svc[kind.method]({ project_id: pid, id }, md) as never,
                )) as Record<string, unknown>;
                name = kind.name(r);
              } catch {
                // fail-soft: удалённая/невидимая запись остаётся без имени.
              }
              if (!name) return;
              for (const row of pending.get(id) ?? []) {
                (row as Record<string, unknown>)[kind.nameKey] = name;
              }
            }),
          );
        }
      }),
    );
    return rows;
  }

  /**
   * TODO-207 — имя ответственного в выгрузке продаж.
   *
   * Домен пишет в `assignee_name` пустую строку (`orders.service.ts` — `String(
   * doc.assigneeName ?? '')`), а join id→ФИО делает `AssigneeNameInterceptor`.
   * Интерцептор обходит ТЕЛО ответа, поэтому список/канбан/карточку он покрывает,
   * а `exportOrders` — нет: там payload сериализуется в `Buffer` внутри хендлера,
   * то есть ДО интерцептора, и колонка «assigneeName» уезжала в CSV/JSON пустой.
   *
   * Здесь тот же самый резолвер (`IdentityResolverService`: батч `ResolveUsers` +
   * кэш), что и у интерцептора, — источник имён один, разъехаться не может.
   * Fail-soft: недоступный auth оставляет ячейку пустой, выгрузка не падает.
   * Ничего дополнительного не раскрывается: те же строки с тем же `assigneeName`
   * пользователь уже получает из `GET /v1/orders` (видимость отфильтрована
   * доменом, ABAC-предикат в БД).
   */
  private async fillOrderAssigneeNames<T extends Record<string, unknown>>(
    req: GrpcReq,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const nameById = await this.identity.resolveNames(
      req,
      rows.map((r) => (r.assigneeId == null ? '' : String(r.assigneeId))),
    );
    if (nameById.size === 0) return rows;
    for (const row of rows) {
      const id = String(row.assigneeId ?? '').trim();
      const name = id ? nameById.get(id) : undefined;
      // Как в интерцепторе: неразрешённый id имя не перетирает.
      if (name) (row as Record<string, unknown>).assigneeName = name;
    }
    return rows;
  }

  /**
   * TODO-207 (хвост ревью) — выгрузка обязана отдать ВЕСЬ отфильтрованный набор.
   *
   * `OrdersService.listOrders` клампит размер страницы (`Math.min(Math.max(pageSize
   * || 25, 1), 100)`), поэтому прежний одиночный вызов с `page_size: 1000` получал
   * ровно 100 строк: цепочка «gateway просит 1000 → домен отдаёт 100» рвалась молча,
   * а меню во фронте обещало «весь список». Листаем домен страницами по доменному
   * максимуму до `total`, с жёстким потолком `ORDERS_EXPORT_MAX_ROWS`; факт усечения
   * возвращается наверх, а не замалчивается.
   *
   * Фильтры и метадата — те же, что у `GET /v1/orders`, поэтому видимость (fail-closed
   * ABAC-предикат в БД) у выгрузки ровно та же: это не полный дамп проекта.
   */
  private async fetchOrdersPagesForExport(
    req: GrpcReq,
    projectId: string,
    filters: Record<string, unknown>,
    budget: ExportBudget,
  ): Promise<{ list: Record<string, unknown>[]; total: number; truncated: boolean }> {
    const md = this.meta(req, projectId);
    const list: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const maxPages = Math.ceil(ORDERS_EXPORT_MAX_ROWS / ORDERS_EXPORT_PAGE_SIZE);
    let total = 0;
    let complete = false;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      // Общий бюджет времени запроса. Страницы читаются ПОСЛЕДОВАТЕЛЬНО, и у каждой
      // свой дедлайн (5 с), поэтому без общего потолка сотня медленных страниц
      // растягивала один запрос на минуты, держа соединение и нагружая домен.
      // Прерванное листание — тот же случай «набор вычитан не весь», что и потолок
      // строк: ниже это даёт `truncated` (страницы не кончились ⇒ `complete` = false)
      // и обычный маркер усечения в файле. Первую страницу читаем всегда: пустой
      // файл без единого запроса — не выгрузка.
      if (pageIndex > 0 && !budget.hasTime()) {
        budget.markTimedOut();
        break;
      }
      const r = (await grpcBffCall(
        this.orders.listOrders(
          {
            ...filters,
            project_id: projectId,
            page_index: pageIndex,
            page_size: ORDERS_EXPORT_PAGE_SIZE,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      const chunk = Array.isArray(r.list) ? r.list : [];
      if (typeof r.total === 'number' && r.total > total) total = r.total;
      for (const raw of chunk) {
        // Страницы читаются последовательно: параллельная запись двигает сортировку
        // (updatedAt desc) и может вернуть строку дважды — в файл она попадёт один раз.
        const id = String(raw?.id ?? '');
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        list.push(raw);
      }
      // Неполная (в т.ч. пустая) страница — данных в домене больше нет.
      if (chunk.length < ORDERS_EXPORT_PAGE_SIZE) {
        complete = true;
        break;
      }
    }

    // Что о размере набора сказал САМ домен — до нормализации ниже. Если страницы
    // кончились (complete), файл полон. Иначе верить можно только домену: он назвал
    // ровно столько строк, сколько мы выгрузили → это весь набор; любое другое
    // значение (в т.ч. потерянный по дороге `total: 0` — граблю с int64/keepCase мы
    // ловили четырежды) означает «может быть больше», и честнее объявить усечение,
    // чем выдать обрезок за весь набор.
    const reportedTotal = total;
    if (total < list.length) total = list.length;
    return { list, total, truncated: !complete && reportedTotal !== list.length };
  }

  /** Одна продажа: маппинг в FE-форму + догрузка имён (TODO-207). */
  private async orderWithNames(
    req: GrpcReq,
    projectId: string | undefined,
    raw: Record<string, unknown>,
  ) {
    const [row] = await this.fillOrderNames(req, projectId, [orderFe(raw)]);
    return row;
  }

  /**
   * Inject the global `project.name` variable into the donor-resolved map before
   * forwarding it to documents (BX-DOCS-3/G3). The catalog advertises `project.name`
   * as a canonical global, but the donors resolve only record-scoped variables and
   * documents (a pure renderer, not a data source) has no project metadata — so the
   * gateway, which owns the project context, resolves the name from control here.
   * Fail-soft: a control outage leaves `project.name` empty (non-blocking), matching
   * the donor-resolve policy — generation never 500s over a missing global.
   */
  private async withGlobalVariables(
    req: GrpcReq,
    projectId: string,
    valuesJson: string,
  ): Promise<string> {
    let name = '';
    try {
      const p = (await grpcBffCall(
        this.project.getProject({ id: projectId }, this.meta(req, projectId)) as never,
      )) as { name?: string };
      name = String(p?.name ?? '');
    } catch {
      // control unreachable / project gone — leave project.name empty (non-blocking).
    }
    if (!name) return valuesJson;
    let values: Record<string, string> = {};
    try {
      const parsed = JSON.parse(valuesJson) as unknown;
      if (parsed && typeof parsed === 'object') values = parsed as Record<string, string>;
    } catch {
      values = {};
    }
    values['project.name'] = name;
    return JSON.stringify(values);
  }

  onModuleInit() {
    this.pipe = this.pipeClient.getService('PipeGrpc');
    this.orders = this.ordersClient.getService('OrdersGrpc');
    this.product = this.productClient.getService('ProductGrpc');
    this.activity = this.activityClient.getService('ActivityGrpc');
    this.documents = this.documentsClient.getService('DocumentsGrpc');
    this.reports = this.reportsClient.getService('ReportsGrpc');
    this.automation = this.automationClient.getService('AutomationGrpc');
    this.project = this.controlClient.getService('ProjectGrpc');
    this.audit = this.auditClient?.getService('AuditGrpc') as
      | Record<string, (x: unknown, m?: unknown) => unknown>
      | undefined;
  }

  // NOTE (C1-stats-be): the operational dashboard moved to StatisticsBffController
  // (`GET /api/v1/dashboard` — statistics-module, reports-backed, visibility-aware,
  // gated by @RequireModule('statistics') + @RequirePermission('statistics','read')).
  // The legacy ungated pipe-backed handler that lived here was the AS-IS dyra
  // (current-state #6) and is removed to fix it. The pipe `GetDashboard` RPC is
  // still surfaced via the guarded REST `GET deals/dashboard` handler below.

  // Deals dashboard: pipe-backed funnel aggregates (conversion / cycle / timeline /
  // top-managers) over a [from,to] period (FR-40). Distinct from the operational
  // statistics dashboard (StatisticsBffController); this one is deals-funnel-specific.
  @Get('deals/dashboard')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async dealsDashboard(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('pipelineId') pipelineId?: string,
  ) {
    const r = (await grpcBffCall(
      this.pipe.getDashboard(
        {
          project_id: projectId,
          from: from ? Number(from) : 0,
          to: to ? Number(to) : 0,
          pipeline_id: pipelineId ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    const conv = (r.conversion ?? {}) as Record<string, unknown>;
    return {
      statistics: arr<Record<string, unknown>>(r.statistics).map((s) => ({
        key: s.key,
        label: s.label,
        value: s.value,
        previousValue: s.previous_value,
        growthRate: s.growth_rate,
      })),
      dealsByStage: arr<Record<string, unknown>>(r.deals_by_stage).map((s) => ({
        stageId: s.stage_id,
        stageName: s.stage_name,
        count: s.count,
        amount: s.amount,
      })),
      dealsTimeline: arr<Record<string, unknown>>(r.deals_timeline).map((p) => ({
        t: p.t,
        count: p.count,
        amount: p.amount,
      })),
      topManagers: arr<Record<string, unknown>>(r.top_managers).map((m) => ({
        id: m.id,
        name: m.name,
        dealsCount: m.deals_count,
        amount: m.amount,
        wonCount: m.won_count,
      })),
      conversion: {
        wonCount: conv.won_count ?? 0,
        lostCount: conv.lost_count ?? 0,
        conversionRate: conv.conversion_rate ?? 0,
        wonAmount: conv.won_amount ?? 0,
        avgCycleDays: conv.avg_cycle_days ?? 0,
        openCount: conv.open_count ?? 0,
      },
      recentDeals: arr<Record<string, unknown>>(r.recent_deals).map(dealFe),
      stalledCount: r.stalled_count ?? 0,
      forecastAmount: r.forecast_amount ?? 0,
      byDepartment: arr<Record<string, unknown>>(r.by_department).map((d) => ({
        departmentId: d.department_id,
        count: d.count,
        amount: d.amount,
      })),
      from: r.from,
      to: r.to,
    };
  }

  /**
   * SCR-DEALS-DISABLE-CASCADE-DIALOG / FR-MDEAL-47 — preview before disabling
   * the deals module: count of open deals (pipe) + enabled modules that hard-depend
   * on deals (module-registry). Host-owned dialog; deals domain supplies the count.
   */
  @Get('deals/disable-cascade-preview')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('project', 'manage')
  async dealsDisableCascadePreview(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const md = this.meta(req, projectId);
    const p = (await grpcBffCall(this.project.getProject({ id: projectId }, md) as never)) as {
      effective_modules?: string[];
      module_configs?: Array<{ module_id?: string; enabled?: boolean; installed?: boolean }>;
    };

    const enabled = new Set<string>();
    for (const id of p.effective_modules ?? []) {
      if (id) enabled.add(id);
    }
    if (!p.effective_modules?.length) {
      for (const cfg of p.module_configs ?? []) {
        if (cfg.enabled && cfg.module_id) enabled.add(cfg.module_id);
      }
    }

    const installed = new Set<string>();
    for (const cfg of p.module_configs ?? []) {
      if (cfg.installed && cfg.module_id) installed.add(cfg.module_id);
    }
    for (const id of enabled) installed.add(id);
    installed.add('deals');

    const cascadeIds = enabledDependentsOf('deals', { installed, enabled });
    const cascadeModules = cascadeIds.map((id) => ({
      id,
      name: MODULE_REGISTRY[id]?.name ?? id,
    }));

    let openDealCount: number | null;
    try {
      const r = (await grpcBffCall(
        this.pipe.listDeals(
          {
            project_id: projectId,
            page_index: 0,
            page_size: 1,
            status: 'open',
            include_deleted: false,
          },
          md,
        ) as never,
      )) as { total?: number };
      openDealCount = toNum(r.total);
    } catch {
      // ST-6: cascade list still useful when the count endpoint degrades.
      openDealCount = null;
    }

    return { openDealCount, cascadeModules };
  }

  @Get('deals')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async listDeals(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('pipelineId') pipelineId?: string,
    @Query('stageId') stageId?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('status') statusF?: string,
    @Query('contactId') contactId?: string,
    @Query('companyId') companyId?: string,
    @Query('source') source?: string,
    @Query('amountMin') amountMin?: string,
    @Query('amountMax') amountMax?: string,
    @Query('stageDaysMin') stageDaysMin?: string,
    // TODO-189: корзина сделок. DealTrash.tsx уже зовёт `GET /v1/deals?deleted=true`
    // (CrmService.apiGetTrashedDeals), но параметр не объявлялся здесь и не уходил
    // в pipe — экран всегда показывал живые сделки, а не удалённые. Флаг
    // ЗАМЕЩАЮЩИЙ (в pipe.listDeals он переключает фильтр на deletedAt != null),
    // а не аддитивный: иначе корзина смешала бы живое с удалённым. Обратный путь
    // уже готов: Deal.deleted_at есть в proto:66 и мапится в dealFe (:163).
    @Query('deleted') deleted?: string,
    @Query('minDaysOnStage') minDaysOnStage?: string,
    @Query('withoutAssignee') withoutAssignee?: string,
  ) {
    const r = (await grpcBffCall(
      this.pipe.listDeals(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
          pipeline_id: pipelineId,
          stage_id: stageId,
          assignee_id: assigneeId,
          department_id: departmentId,
          status: statusF,
          contact_id: contactId,
          company_id: companyId,
          source,
          amount_min: amountMin != null ? Number(amountMin) : undefined,
          amount_max: amountMax != null ? Number(amountMax) : undefined,
          stage_days_min: stageDaysMin != null ? Number(stageDaysMin) : undefined,
          include_deleted: deleted === 'true',
          min_days_on_stage:
            minDaysOnStage != null && minDaysOnStage !== ''
              ? parseInt(minDaysOnStage, 10)
              : undefined,
          without_assignee: withoutAssignee === 'true',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number; hidden_by_policy?: number };
    const hiddenByPolicy = typeof r.hidden_by_policy === 'number' ? r.hidden_by_policy : undefined;
    return {
      list: r.list.map(dealFe),
      total: r.total,
      ...(hiddenByPolicy !== undefined ? { hiddenByPolicy } : {}),
    };
  }

  /** Nested REST form: GET /v1/contacts/:contactId/deals → listDeals(contactId). */
  @Get('contacts/:contactId/deals')
  @ApiTags('Contacts')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async listDealsForContact(
    @Req() req: GrpcReq,
    @Param('contactId') contactId: string,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') statusF?: string,
  ) {
    return this.listDeals(
      req,
      projectId,
      pageIndex,
      pageSize,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      statusF,
      contactId,
    );
  }

  @Get('deals/kanban')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async kanban(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pipelineId') pipelineId?: string,
    @Query('query') query?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('status') statusF?: string,
    @Query('contactId') contactId?: string,
    @Query('companyId') companyId?: string,
    @Query('source') source?: string,
    @Query('amountMin') amountMin?: string,
    @Query('amountMax') amountMax?: string,
    @Query('stageDaysMin') stageDaysMin?: string,
  ) {
    const r = (await grpcBffCall(
      this.pipe.getDealsKanban(
        {
          project_id: projectId,
          pipeline_id: pipelineId,
          query: query ?? '',
          assignee_id: assigneeId,
          department_id: departmentId,
          status: statusF,
          contact_id: contactId,
          company_id: companyId,
          source,
          amount_min: amountMin != null ? Number(amountMin) : undefined,
          amount_max: amountMax != null ? Number(amountMax) : undefined,
          stage_days_min: stageDaysMin != null ? Number(stageDaysMin) : undefined,
        },
        this.meta(req, projectId),
      ) as never,
    )) as {
      pipeline?: Record<string, unknown>;
      columns?: {
        stage_id: string;
        stage_name: string;
        deals?: Record<string, unknown>[];
        total?: number | string;
        has_more?: boolean;
      }[];
    };
    const pipeline = r.pipeline ?? {};
    const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
    return {
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        stages: arr(
          pipeline.stages as { id: string; name: string; color: string; order: number }[],
        ).map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          order: s.order,
        })),
        isDefault: pipeline.is_default,
      },
      columns: arr(r.columns).map((c) => ({
        stageId: c.stage_id,
        stageName: c.stage_name,
        deals: arr(c.deals).map(dealFe),
        total: Number(c.total ?? 0),
        hasMore: Boolean(c.has_more),
      })),
    };
  }

  @Get('deals/:id')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async getDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.getDeal({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('deals')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async createDeal(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    // Same fail-closed donor gate as link-contact/link-company: `contactId`/`companyId`
    // arriving in the body is an attach, so it must pass the donor's OWN read gate.
    // Without this, `POST /deals {contactId: <foreign>}` is a second door to the very
    // leak the link routes just closed — drift detection then reports the invisible
    // contact's live name/phone/email as `current_value` on the deal card.
    await this.assertLinkDonorsReadable(req, pid, body.contactId, body.companyId);
    return dealFe(
      (await grpcBffCall(
        this.pipe.createDeal(
          {
            project_id: pid,
            name: body.name,
            amount: body.amount,
            currency: body.currency,
            pipeline_id: body.pipelineId,
            stage_id: body.stageId,
            contact_id: body.contactId,
            company_id: body.companyId,
            source: body.source,
            assignee_id: body.assigneeId,
            // GAP-DEALS-010: CreateDealRequest fields 11..18 exist in proto and are
            // fully consumed by the domain (pipe.service.createDeal) — they were simply
            // never mapped here, so productId/expectedCloseDate sent by DealList.tsx and
            // the light-lead quartet silently evaporated at the BFF boundary.
            product_id: body.productId,
            department_id: body.departmentId,
            expected_close_date: body.expectedCloseDate,
            probability: body.probability,
            light_name: body.lightName,
            light_phone: body.lightPhone,
            light_email: body.lightEmail,
            light_company_name: body.lightCompanyName,
            notes: body.notes,
          },
          this.meta(req, pid),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Put('deals/:id')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async updateDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    // See createDeal: re-pointing a deal at a contact/company is an attach too. An
    // empty value is a DEtach (TODO-385 clearing) and needs no donor read.
    await this.assertLinkDonorsReadable(req, projectId, body.contactId, body.companyId);
    return dealFe(
      (await grpcBffCall(
        this.pipe.updateDeal(
          {
            project_id: projectId,
            id,
            name: body.name,
            amount: body.amount,
            pipeline_id: body.pipelineId,
            stage_id: body.stageId,
            contact_id: body.contactId,
            company_id: body.companyId,
            assignee_id: body.assigneeId,
            // GAP-DEALS-140/180: UpdateDealRequest fields 10..13 exist in proto and are
            // applied by pipe.service.updateDeal — the BFF just never forwarded them.
            department_id: body.departmentId,
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            probability: body.probability,
            expected_close_date: body.expectedCloseDate,
            // …and 14..17 did not exist in the contract at all, so a product/source/
            // currency/notes change on the edit form saved everything BUT them, with
            // no error shown. Added to the proto + applied in pipe.service.updateDeal.
            product_id: body.productId,
            source: body.source,
            currency: body.currency,
            notes: body.notes,
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Delete('deals/:id')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'delete')
  async deleteDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    await grpcBffCall(
      this.pipe.deleteDeal({ project_id: projectId, id }, this.meta(req, projectId)) as never,
    );
    return { ok: true };
  }

  @Put('deals/:dealId/stage')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'move')
  async moveDeal(
    @Req() req: GrpcReq,
    @Param('dealId') dealId: string,
    @Query('projectId') projectId: string,
    @Body() body: { stageId: string },
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.moveDealToStage(
          { project_id: projectId, deal_id: dealId, stage_id: body.stageId },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Get('deals/:id/drift')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async dealDrift(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.pipe.getDealDrift({ project_id: projectId, id }, this.meta(req, projectId)) as never,
    )) as {
      deal_id: string;
      drift?: Record<string, unknown>[];
      source_deleted?: boolean;
      contact_source_deleted?: boolean;
      company_source_deleted?: boolean;
    };
    const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
    return {
      dealId: r.deal_id,
      drift: arr(r.drift).map((e) => ({
        field: e.field,
        snapshotValue: e.snapshot_value,
        currentValue: e.current_value,
        changedBy: e.changed_by,
        changedAt: e.changed_at,
      })),
      sourceDeleted: Boolean(r.source_deleted),
      contactSourceDeleted: Boolean(r.contact_source_deleted),
      companySourceDeleted: Boolean(r.company_source_deleted),
    };
  }

  @Get('deals/:id/stage-history')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async dealStageHistory(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.reports.getDealStageHistory(
        { project_id: projectId, deal_id: id },
        this.meta(req, projectId),
      ) as never,
    )) as { entries?: Record<string, unknown>[] };
    const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
    return {
      entries: arr(r.entries).map((e) => ({
        fromStageId: e.from_stage_id,
        toStageId: e.to_stage_id,
        enteredAt: toNum(e.entered_at),
        exitedAt: toNum(e.exited_at),
        movedBy: e.moved_by,
        kind: e.kind,
        durationMs: toNum(e.duration_ms),
        label: e.label,
      })),
    };
  }

  @Post('deals/:id/close')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async closeDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { result: string; lostReasonId?: string; lostReasonComment?: string },
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.closeDeal(
          {
            project_id: projectId,
            id,
            result: body.result,
            lost_reason_id: body.lostReasonId,
            lost_reason_comment: body.lostReasonComment,
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('deals/:id/reopen')
  @ApiTags('Deals')
  @RequireModule('deals')
  // GAP-DEALS-130: `deals:manage` is the *settings* permission (pipelines, sources,
  // lost reasons) and the manager role deliberately does not have it — so the old
  // `manage` gate locked reopen to admin/owner while the domain explicitly allows
  // manager+ (@RequireRoles('manager') on PipeGrpc.ReopenDeal).
  //
  // B1: dropping it to `write` alone was a NET WEAKENING — `write` belongs to
  // `member` (shared/rbac.ts PROJECT_ROLE_ACTIONS), so the PEP stopped deciding
  // anything at all. The route therefore keeps the data-write permission AND adds
  // the domain's own role predicate (DealReopenRoleGuard ⇒ role >= manager), so
  // the gateway gate is never weaker than the domain gate.
  @RequirePermission('deals', 'write')
  @UseGuards(DealReopenRoleGuard)
  async reopenDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { reason: string; targetStageId: string },
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.reopenDeal(
          {
            project_id: projectId,
            id,
            reason: body.reason,
            target_stage_id: body.targetStageId,
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  /** Layer-3 snapshot shape from a contact as the contact domain returns it. */
  private contactSnapshotOf(c: Record<string, unknown>): {
    name: string;
    phone: string;
    email: string;
  } {
    const name = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ').trim();
    return { name, phone: String(c.phone ?? ''), email: String(c.email ?? '') };
  }

  /**
   * Resolve the link donor (contact) under the CALLER's own metadata and return its
   * PII snapshot. FAIL-CLOSED: any resolve failure aborts the link.
   *
   * This used to be `try { … } catch { snapshot = undefined }` — a contact the caller
   * may not see (contact ABAC), or one that does not exist at all, was linked anyway,
   * merely with an empty snapshot. That was inert while the snapshot never crossed the
   * wire (TODO-185 added the proto field); it stopped being inert the moment it did:
   * drift detection diffs the stored snapshot against the live contact and records the
   * real name/phone/email in `driftDetail[field].currentValue`, `GET deals/:id/drift`
   * hands them out as `current_value` and `POST deals/:id/accept-drift` (TODO-178)
   * materialises them into the deal's `contactSnapshot`. A holder of `deals:write`
   * would thereby read PII of a contact his own visibility denies — the write gate
   * would be softer than the read gate.
   *
   * So the donor read is the gate: contact's `GetContact` applies project isolation +
   * visibility scope + access predicate and NOT_FOUND-masks a denied record, and that
   * error is propagated verbatim (404/403/503 via AppErrorFilter) instead of being
   * swallowed into a "successful" link.
   */
  private async resolveContactSnapshot(
    req: GrpcReq,
    projectId: string,
    contactId: string | undefined,
  ): Promise<{ name: string; phone: string; email: string }> {
    if (!contactId) throw new BadRequestException('contactId is required');
    const contact = this.contactClient.getService('ContactGrpc') as Record<
      string,
      (x: unknown, m?: unknown) => unknown
    >;
    const c = (await grpcBffCall(
      contact.getContact(
        { project_id: projectId, id: contactId },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return this.contactSnapshotOf(c);
  }

  /** Same fail-closed contract as {@link resolveContactSnapshot}, for the company donor. */
  private async resolveCompanySnapshot(
    req: GrpcReq,
    projectId: string,
    companyId: string | undefined,
  ): Promise<{ name: string; inn: string }> {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = this.companyClient.getService('CompanyGrpc') as Record<
      string,
      (x: unknown, m?: unknown) => unknown
    >;
    const c = (await grpcBffCall(
      company.getCompany(
        { project_id: projectId, id: companyId },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return { name: String(c.name ?? ''), inn: String(c.inn ?? '') };
  }

  /**
   * Donor read gate for the deal write paths that attach a contact/company as part of
   * a bigger payload (create/update). Only presence is asserted — the snapshot is
   * materialised by the dedicated link RPCs — but the assertion is the same one:
   * unreadable donor ⇒ the write does not happen. An empty id is a detach and is
   * deliberately not checked.
   */
  private async assertLinkDonorsReadable(
    req: GrpcReq,
    projectId: string,
    contactId: unknown,
    companyId: unknown,
  ): Promise<void> {
    const cid = contactId == null ? '' : String(contactId).trim();
    const coid = companyId == null ? '' : String(companyId).trim();
    if (cid) await this.resolveContactSnapshot(req, projectId, cid);
    if (coid) await this.resolveCompanySnapshot(req, projectId, coid);
  }

  @Post('deals/:id/link-contact')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async linkContact(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { contactId: string },
  ) {
    // Snapshot (layer-3) is resolved on gateway from the live contact, with the same
    // project isolation + visibility (contract §11-12 SEC) — and the resolve IS the
    // read gate for the donor: an unreadable donor aborts the link (see
    // resolveContactSnapshot).
    const snapshot = await this.resolveContactSnapshot(req, projectId, body?.contactId);
    return dealFe(
      (await grpcBffCall(
        this.pipe.linkContact(
          { project_id: projectId, id, contact_id: body.contactId, snapshot },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  // QUALIFY (light → real contact): composite gateway orchestration (pipe.md §4).
  // 1) read the deal's light* PII; 2) FindDuplicates on contact (phone/email);
  // 3) if dups exist and caller did not force → return candidates for the FE to choose;
  //    else create/link the chosen-or-new contact and attach its snapshot to the deal.
  // No new rpc in pipe — it's create-contact + link-contact stitched here.
  @Post('deals/:id/qualify')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async qualifyDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body()
    body: {
      target?: 'contact' | 'company';
      contactId?: string;
      companyId?: string;
      createNew?: boolean;
      create?: {
        firstName?: string;
        lastName?: string;
        phone?: string;
        email?: string;
        name?: string;
        inn?: string;
      };
    },
  ) {
    const md = this.meta(req, projectId);
    const deal = (await grpcBffCall(
      this.pipe.getDeal({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;

    if (body?.target === 'company') {
      const company = this.companyClient.getService('CompanyGrpc') as Record<
        string,
        (x: unknown, m?: unknown) => unknown
      >;
      const lightCompanyName = String(deal.light_company_name ?? '');
      let companyId = body?.companyId ?? '';
      const forceCreate = !!body?.createNew || !!body?.create;
      if (!companyId && !forceCreate) {
        const dup = (await grpcBffCall(
          company.findDuplicates(
            {
              project_id: projectId,
              name: lightCompanyName,
              inn: String(body?.create?.inn ?? ''),
            },
            md,
          ) as never,
        )) as { candidates?: Record<string, unknown>[] };
        const candidates = Array.isArray(dup.candidates) ? dup.candidates : [];
        if (candidates.length === 1 && !candidates[0].deleted) {
          companyId = String(candidates[0].id ?? candidates[0].company_id ?? '');
        } else if (candidates.length > 0) {
          return {
            status: 'duplicates',
            target: 'company',
            candidates: candidates.map((c) => ({
              companyId: c.id ?? c.company_id,
              displayName: c.name ?? c.display_name,
              matchedOn: c.match_reason ?? c.matched_on,
              maskedValue: c.inn ?? c.masked_value ?? '',
              deleted: Boolean(c.deleted),
            })),
          };
        }
      }
      let snapshot: { name: string; inn: string } | undefined;
      if (!companyId) {
        const cr = body?.create ?? {};
        const created = (await grpcBffCall(
          company.createCompany(
            {
              project_id: projectId,
              name: cr.name ?? lightCompanyName,
              inn: cr.inn ?? '',
              assignee_id: String(deal.assignee_id ?? ''),
            },
            md,
          ) as never,
          'write',
        )) as Record<string, unknown>;
        companyId = String(created.id ?? '');
        snapshot = { name: String(created.name ?? ''), inn: String(created.inn ?? '') };
      }
      if (!snapshot) snapshot = await this.resolveCompanySnapshot(req, projectId, companyId);
      const linked = (await grpcBffCall(
        this.pipe.linkCompany(
          { project_id: projectId, id, company_id: companyId, snapshot },
          md,
        ) as never,
        'write',
      )) as Record<string, unknown>;
      return { status: 'qualified', companyId, deal: dealFe(linked) };
    }

    const contact = this.contactClient.getService('ContactGrpc') as Record<
      string,
      (x: unknown, m?: unknown) => unknown
    >;

    const lightName = String(deal.light_name ?? '');
    const lightPhone = String(deal.light_phone ?? '');
    const lightEmail = String(deal.light_email ?? '');

    // Resolve which contact to link. Presence of `create` (or createNew) means the caller
    // has already chosen to force-create a new contact, so skip the dedup gate.
    let contactId = body?.contactId ?? '';
    const forceCreate = !!body?.createNew || !!body?.create;

    if (!contactId && !forceCreate) {
      // Surface duplicate candidates so the FE can pick existing or force-create.
      const dup = (await grpcBffCall(
        contact.findDuplicates(
          { project_id: projectId, email: lightEmail, phone: lightPhone },
          md,
        ) as never,
      )) as { candidates?: Record<string, unknown>[]; possible_external_duplicate?: boolean };
      const candidates = Array.isArray(dup.candidates) ? dup.candidates : [];
      if (candidates.length === 1 && !candidates[0].deleted) {
        // FR-MDEAL-6: a single live exact match auto-links without a fork dialog.
        contactId = String(candidates[0].contact_id ?? '');
      } else if (candidates.length > 0) {
        return {
          status: 'duplicates',
          candidates: candidates.map((c) => ({
            contactId: c.contact_id,
            displayName: c.display_name,
            matchedOn: c.matched_on,
            maskedValue: c.masked_value,
            deleted: Boolean(c.deleted),
          })),
          possibleExternalDuplicate: !!dup.possible_external_duplicate,
        };
      }
    }

    // Layer-3 snapshot of the contact that ends up linked (layer-2 + layer-3 in one hop).
    let snapshot: { name: string; phone: string; email: string } | undefined;

    if (!contactId) {
      // Create a real contact. Prefer the user-edited `create` fields from the dialog;
      // fall back to the deal's light* fields (assignee = deal owner).
      const cr = body?.create ?? {};
      const parts = lightName.split(/\s+/).filter(Boolean);
      const firstName = cr.firstName ?? (parts.slice(1).join(' ') || parts[0] || '');
      const lastName = cr.lastName ?? (parts.length > 1 ? parts[0] : '');
      const created = (await grpcBffCall(
        contact.createContact(
          {
            project_id: projectId,
            first_name: firstName,
            last_name: lastName,
            phone: cr.phone ?? lightPhone,
            email: cr.email ?? lightEmail,
            source: String(deal.source ?? ''),
            assignee_id: String(deal.assignee_id ?? ''),
          },
          md,
        ) as never,
        'write',
      )) as Record<string, unknown>;
      contactId = String(created.id ?? '');
      // The contact we have just created IS the resolved donor — its own response
      // carries the fields, so no second read-back. (Reading it back would also be
      // wrong here: a contact assigned to the deal's owner may fall outside the
      // caller's own visibility, and the fail-closed read would then abort qualify
      // AFTER the contact was created — an orphan record on every such qualify.)
      snapshot = this.contactSnapshotOf(created);
    }

    // Linking an EXISTING contact (caller-supplied id or a chosen duplicate): resolve
    // it under the caller's visibility, fail-closed — see resolveContactSnapshot.
    if (!snapshot) snapshot = await this.resolveContactSnapshot(req, projectId, contactId);

    const linked = (await grpcBffCall(
      this.pipe.linkContact(
        { project_id: projectId, id, contact_id: contactId, snapshot },
        md,
      ) as never,
      'write',
    )) as Record<string, unknown>;
    return { status: 'qualified', contactId, deal: dealFe(linked) };
  }

  @Post('deals/:id/link-company')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async linkCompany(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { companyId: string },
  ) {
    // Same fail-closed donor resolve as link-contact: an unreadable/absent company
    // must not be linkable with an empty snapshot (drift would then leak its name).
    const snapshot = await this.resolveCompanySnapshot(req, projectId, body?.companyId);
    return dealFe(
      (await grpcBffCall(
        this.pipe.linkCompany(
          { project_id: projectId, id, company_id: body.companyId, snapshot },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('deals/:id/accept-drift')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async acceptDrift(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { target?: string },
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.acceptContactDrift(
          { project_id: projectId, id, target: body?.target },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('deals/bulk/accept-drift')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async bulkAcceptDrift(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body: { dealIds: string[]; target?: string },
  ) {
    const r = (await grpcBffCall(
      this.pipe.bulkAcceptDrift(
        {
          project_id: projectId,
          deal_ids: body?.dealIds ?? [],
          target: body?.target,
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as { accepted?: string[]; skipped?: { id: string; reason: string }[] };
    return {
      accepted: r.accepted ?? [],
      skipped: r.skipped ?? [],
    };
  }

  @Post('deals/bulk')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'write')
  async bulkDeals(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body: { dealIds: string[]; change: Record<string, unknown> },
  ) {
    const change = body?.change ?? {};
    const r = (await grpcBffCall(
      this.pipe.bulkUpdateDeals(
        {
          project_id: projectId,
          deal_ids: body?.dealIds ?? [],
          change: {
            assignee_id: change.assigneeId,
            department_id: change.departmentId,
            stage_id: change.stageId,
            pipeline_id: change.pipelineId,
          },
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as {
      updated?: string[];
      skipped?: { id: string; reason: string }[];
      async?: boolean;
      job_id?: string;
    };
    return {
      updated: r.updated ?? [],
      skipped: r.skipped ?? [],
      async: Boolean(r.async),
      jobId: r.job_id ?? '',
    };
  }

  @Post('deals/:id/restore')
  @ApiTags('Deals')
  @RequireModule('deals')
  @RequirePermission('deals', 'delete')
  async restoreDeal(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return dealFe(
      (await grpcBffCall(
        this.pipe.restoreDeal({ project_id: projectId, id }, this.meta(req, projectId)) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Get('pipelines')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async pipelines(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const r = (await grpcBffCall(
      this.pipe.listPipelines({ project_id: projectId }, this.meta(req, projectId)) as never,
    )) as { list: unknown[] };
    return r.list.map((p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      isDefault: p.is_default,
      stages: p.stages,
    }));
  }

  /**
   * GAP-DEALS-200: PipelineEdit.tsx (edit mode) calls `GET /v1/pipelines/:id`, but the
   * BFF only exposed list/create/update/delete — the constructor 404'd on open. There is
   * no `GetPipeline` RPC in pipe.proto either, and ListPipelines already returns the full
   * `stages[]`, so this route resolves the single pipeline from the list instead of
   * touching proto/domain. Stages are mapped to camelCase because the FE form reads
   * `kind`/`rottingDays` (the raw domain payload is snake_case `rotting_days`).
   */
  @Get('pipelines/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async getPipeline(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') qpid: string,
  ) {
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    const pid = this.authoritativeProjectId(req, qpid, undefined);
    const r = (await grpcBffCall(
      this.pipe.listPipelines({ project_id: pid }, this.meta(req, pid)) as never,
    )) as { list: Record<string, unknown>[] };
    const p = arr<Record<string, unknown>>(r.list).find((x) => String(x.id) === id);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Воронка не найдена' });
    return {
      id: p.id,
      name: p.name,
      isDefault: p.is_default,
      stages: arr<Record<string, unknown>>(p.stages).map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        order: s.order,
        kind: s.kind,
        probability: s.probability,
        rottingDays: s.rotting_days,
      })),
      autoTransitions: arr<Record<string, unknown>>(p.auto_transitions).map((t) => ({
        fromStageId: t.from_stage_id,
        toStageId: t.to_stage_id,
      })),
    };
  }

  @Post('pipelines')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async createPipeline(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const autoTransitions = Array.isArray(body.autoTransitions)
      ? (body.autoTransitions as Record<string, unknown>[]).map((t) => ({
          from_stage_id: t.fromStageId,
          to_stage_id: t.toStageId,
        }))
      : [];
    const p = (await grpcBffCall(
      this.pipe.createPipeline(
        {
          project_id: projectId,
          name: body.name,
          is_default: body.isDefault === true,
          debounce_ms: body.debounceMs,
          default_rotting_days: body.defaultRottingDays,
          stages: Array.isArray(body.stages) ? body.stages : [],
          auto_transitions: autoTransitions,
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as Record<string, unknown>;
    return {
      id: p.id,
      name: p.name,
      isDefault: p.is_default,
      stages: p.stages,
      autoTransitions: Array.isArray(p.auto_transitions)
        ? (p.auto_transitions as Record<string, unknown>[]).map((t) => ({
            fromStageId: t.from_stage_id,
            toStageId: t.to_stage_id,
          }))
        : [],
    };
  }

  @Put('pipelines/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async updatePipeline(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const autoTransitions = Array.isArray(body.autoTransitions)
      ? (body.autoTransitions as Record<string, unknown>[]).map((t) => ({
          from_stage_id: t.fromStageId,
          to_stage_id: t.toStageId,
        }))
      : undefined;
    const p = (await grpcBffCall(
      this.pipe.updatePipeline(
        {
          project_id: projectId,
          id,
          name: body.name,
          is_default: body.isDefault === true,
          debounce_ms: body.debounceMs,
          default_rotting_days: body.defaultRottingDays,
          stages: Array.isArray(body.stages) ? body.stages : undefined,
          auto_transitions: autoTransitions,
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as Record<string, unknown>;
    return {
      id: p.id,
      name: p.name,
      isDefault: p.is_default,
      stages: p.stages,
      autoTransitions: Array.isArray(p.auto_transitions)
        ? (p.auto_transitions as Record<string, unknown>[]).map((t) => ({
            fromStageId: t.from_stage_id,
            toStageId: t.to_stage_id,
          }))
        : [],
    };
  }

  @Delete('pipelines/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async deletePipeline(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.pipe.deletePipeline({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      'write',
    );
  }

  @Get('deal-sources')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async sources(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const r = (await grpcBffCall(
      this.pipe.listDealSources({ project_id: projectId }, this.meta(req, projectId)) as never,
    )) as { list: unknown[] };
    return r.list;
  }

  @Post('deal-sources')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async createSource(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body: { name: string; color?: string },
  ) {
    return grpcBffCall(
      this.pipe.createDealSource(
        { project_id: projectId, name: body.name, color: body.color },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Put('deal-sources/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async updateSource(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { name?: string; color?: string },
  ) {
    return grpcBffCall(
      this.pipe.updateDealSource(
        { project_id: projectId, id, name: body.name, color: body.color },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Delete('deal-sources/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async deleteSource(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.pipe.deleteDealSource({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      'write',
    );
  }

  @Get('lost-reasons')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'read')
  async lostReasons(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const r = (await grpcBffCall(
      this.pipe.listLostReasons(
        { project_id: projectId, active_only: activeOnly === 'true' },
        this.meta(req, projectId),
      ) as never,
    )) as { list: unknown[] };
    return r.list;
  }

  @Post('lost-reasons')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async createLostReason(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body: { name: string; order?: number; active?: boolean },
  ) {
    return grpcBffCall(
      this.pipe.createLostReason(
        { project_id: projectId, name: body.name, order: body.order, active: body.active },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Put('lost-reasons/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async updateLostReason(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { name?: string; order?: number; active?: boolean },
  ) {
    return grpcBffCall(
      this.pipe.updateLostReason(
        { project_id: projectId, id, name: body.name, order: body.order, active: body.active },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Delete('lost-reasons/:id')
  @ApiTags('Pipelines')
  @RequireModule('deals')
  @RequirePermission('deals', 'manage')
  async deleteLostReason(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.pipe.deleteLostReason({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      'write',
    );
  }

  @Get('members')
  @ApiTags('Projects')
  @MembershipOnly()
  async members(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const r = (await grpcBffCall(
      this.project.listMembers({ project_id: projectId }, this.meta(req, projectId)) as never,
    )) as { list: unknown[] };
    return r.list;
  }

  @Get('orders')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async listOrders(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('dealId') dealId?: string,
    @Query('typeId') typeId?: string,
    @Query('status') statusFilter?: string,
    @Query('stageId') stageId?: string,
    @Query('staleDays') staleDays?: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.listOrders(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
          deal_id: dealId,
          type_id: typeId,
          status: statusFilter,
          stage_id: stageId,
          stale_days: staleDays ? parseInt(staleDays, 10) : undefined,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      // TODO-207: домен отдаёт product/deal/contact/company_name пустыми — имена
      // догружаются на gateway (см. fillOrderNames).
      list: await this.fillOrderNames(req, projectId, list.map(orderFe)),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }

  @Get('orders/kanban')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async ordersKanban(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('typeId') typeId?: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.getOrdersKanban(
        { project_id: projectId, type_id: typeId },
        this.meta(req, projectId),
      ) as never,
    )) as {
      type_id?: string;
      stages?: Record<string, unknown>[];
      columns?: { stage_id: string; stage_name: string; orders?: Record<string, unknown>[] }[];
    };
    const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
    const columns = arr(r.columns).map((c) => ({
      stageId: c.stage_id,
      stageName: c.stage_name,
      orders: arr(c.orders).map(orderFe),
    }));
    // TODO-207: карточки канбана берут те же *Name, что и список — один резолв на
    // все колонки сразу (дедуп по id внутри fillOrderNames), мутация на месте.
    await this.fillOrderNames(
      req,
      projectId,
      columns.flatMap((c) => c.orders),
    );
    return {
      typeId: r.type_id,
      stages: arr(r.stages).map(stageSpecFe),
      columns,
    };
  }

  @Get('orders/export')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'export')
  @Header('Cache-Control', 'no-store')
  async exportOrders(
    @Req() req: GrpcReq,
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('projectId') projectId: string,
    @Query('format') format?: string,
    @Query('query') query?: string,
    @Query('dealId') dealId?: string,
    @Query('typeId') typeId?: string,
    @Query('status') statusFilter?: string,
    @Query('stageId') stageId?: string,
  ) {
    const requested = (format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const limits = ordersExportLimits();
    /**
     * ЗАЩИТА ОТ УСИЛЕНИЯ (часть `TODO(152-ФЗ / E2-08)` про egress rate-limit).
     *
     * Один этот запрос — самый дорогой маршрут продаж: до 100 последовательных
     * `ListOrders` плюс резолв имён одиночными Get* в четыре соседних домена.
     * Последовательную стоимость ограничивает `ExportBudget` (общее время +
     * общий потолок Get*-вызовов), а опасен ровно ПАРАЛЛЕЛИЗМ: десяток
     * одновременных выгрузок кладёт не gateway, а contacts/companies/pipe/product.
     * Поэтому одновременные выгрузки считаются по пользователю, проекту и
     * процессу; сверх лимита — честный 429 с `Retry-After`, а не тихая очередь,
     * которая всё равно доедет до доноров.
     */
    const userKey = String(req.user?.userId ?? '').trim() || 'anonymous';
    const projectKey = String(projectId ?? '').trim();
    const release = this.exportInflight.acquire(userKey, projectKey, limits);
    if (!release) {
      void res.header('Retry-After', '30');
      throw new HttpException(
        {
          code: 'EXPORT_RATE_LIMITED',
          message: 'Выгрузка продаж уже выполняется. Дождитесь её завершения и повторите запрос.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await this.buildOrdersExport(
        req,
        res,
        projectId,
        requested,
        {
          query: query ?? '',
          deal_id: dealId,
          type_id: typeId,
          status: statusFilter,
          stage_id: stageId,
        },
        new ExportBudget(limits),
      );
    } finally {
      // Слот освобождается и на ошибке (504 от домена, отвал соединения) — иначе
      // первая же неудачная выгрузка навсегда закрывала бы пользователю ручку.
      release();
    }
  }

  /**
   * Тело выгрузки продаж: листание набора, резолв имён, сериализация в CSV/JSON.
   * Вынесено из хендлера, чтобы ограничитель одновременных выгрузок гарантированно
   * освобождал слот в `finally`, не оборачивая сотню строк в лишний уровень отступа.
   */
  private async buildOrdersExport(
    req: GrpcReq,
    res: FastifyReply,
    projectId: string,
    requested: 'csv' | 'json',
    filters: Record<string, unknown>,
    budget: ExportBudget,
  ): Promise<Buffer> {
    // Export reuses ListOrders with the *same* visibility scope as the list — never a full
    // project dump. Fail-closed visibility is pushed down and enforced domain-side.
    // TODO-207 (хвост): домен клампит страницу до 100 строк, поэтому один вызов с
    // `page_size: 1000` молча отдавал первую сотню. Листаем страницами до `total`.
    const page = await this.fetchOrdersPagesForExport(req, projectId, filters, budget);
    // TODO-207: колонки productName/dealName/contactName/companyName в CSV читались
    // из полей, которые домен не заполняет, — выгрузка уезжала с пустыми колонками.
    const rows = await this.fillOrderNames(req, projectId, page.list.map(orderFe), {
      maxIds: ORDERS_EXPORT_NAME_MAX_IDS,
      budget,
    });
    // TODO-207: и колонка assigneeName — её обычно заполняет AssigneeNameInterceptor,
    // но он работает по телу ответа, а тут тело уже Buffer (см. fillOrderAssigneeNames).
    await this.fillOrderAssigneeNames(req, rows);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Усечение объявляется явно и в файле тоже: FE скачивает blob и своё имя файла
    // подставляет сам, а кросс-доменный XHR читает только «безопасные» заголовки —
    // молчаливо обрезанная выгрузка выглядела бы для пользователя полной.
    const truncatedNote = page.truncated
      ? page.total > rows.length
        ? `Выгружены первые ${rows.length} строк из ${page.total} по текущим фильтрам — уточните фильтры`
        : // Домен не назвал вменяемый total: сколько осталось за бортом — неизвестно,
          // но молчать об усечении нельзя.
          `Выгружены первые ${rows.length} строк по текущим фильтрам (потолок выгрузки) — уточните фильтры`
      : '';
    /**
     * Бюджет резолва имён исчерпан (общий потолок Get*-вызовов или время запроса):
     * часть колонок productName/dealName/contactName/companyName уехала пустой.
     * Пустая ячейка сама по себе неотличима от «имени нет» / «запись не видна»,
     * поэтому причина проговаривается — как и усечение по строкам.
     */
    const namesNote = budget.namesIncomplete
      ? budget.timedOut
        ? 'Часть имён (продукт/сделка/контакт/компания) не разрешена: истёк бюджет времени выгрузки — сузьте фильтры'
        : 'Часть имён (продукт/сделка/контакт/компания) не разрешена: исчерпан бюджет запросов выгрузки — сузьте фильтры'
      : '';
    // TODO(152-ФЗ / E2-08): record export as PII egress in immutable audit.
    // (Egress rate-limit по этой ручке закрыт: `ExportInflightLimiter` выше + `ExportBudget`.)
    let payload: string;
    let contentType: string;
    if (requested === 'json') {
      // Полная выгрузка остаётся ровно массивом строк (формат не меняется); неполная
      // несёт последним элементом служебный маркер — потребитель не примет обрезок за всё.
      payload = JSON.stringify(
        truncatedNote || namesNote
          ? [
              ...rows,
              {
                _truncated: Boolean(truncatedNote),
                _exported: rows.length,
                _total: page.total,
                _namesIncomplete: budget.namesIncomplete,
                _note: [truncatedNote, namesNote].filter(Boolean).join(' '),
              },
            ]
          : rows,
        null,
        2,
      );
      contentType = 'application/json; charset=utf-8';
    } else {
      const cols = [
        'number',
        'typeName',
        'productName',
        'dealName',
        'contactName',
        'companyName',
        'stageName',
        'assigneeName',
        'status',
        'createdAt',
      ] as const;
      const escape = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        cols.join(','),
        ...rows.map((row) =>
          cols.map((c) => escape((row as Record<string, unknown>)[c])).join(','),
        ),
      ];
      // Маркер усечения — отдельной строкой в первой колонке: виден и в Excel, и в `tail`.
      for (const note of [truncatedNote, namesNote]) {
        if (note) lines.push([escape(`# ${note}`), ...cols.slice(1).map(() => '')].join(','));
      }
      payload = lines.join('\n');
      contentType = 'text/csv; charset=utf-8';
    }
    void res.header('Content-Type', contentType);
    const suffix = truncatedNote
      ? page.total > rows.length
        ? `-first-${rows.length}-of-${page.total}`
        : `-first-${rows.length}`
      : '';
    void res.header(
      'Content-Disposition',
      `attachment; filename="orders-${stamp}${suffix}.${requested}"`,
    );
    // Машиночитаемая версия того же факта — для API-клиентов и предупреждения в UI
    // (заголовки перечислены в CORS `exposedHeaders`, см. `application.ts`).
    void res.header('X-Export-Row-Count', String(rows.length));
    void res.header('X-Export-Total', String(page.total));
    void res.header('X-Export-Truncated', truncatedNote ? 'true' : 'false');
    // Отдельный факт от усечения по строкам: строки все, а имена в них — не все.
    void res.header('X-Export-Names-Incomplete', budget.namesIncomplete ? 'true' : 'false');
    return Buffer.from(payload, 'utf8');
  }

  @Get('orders/:id')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async getOrder(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.getOrder({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      )) as Record<string, unknown>,
    );
  }

  /**
   * TODO-414: реальная лента изменений продажи — из неизменяемой цепочки audit,
   * тем же паттерном, что `/v1/contacts/:id/history` и `/v1/companies/:id/history`.
   * Пока ручки не было, карточка рисовала два выдуманных события из createdAt/
   * updatedAt; события же лежали в цепочке с самого начала (`crm.order.*`,
   * subject `order/<id>` → entityType `order`).
   *
   * Гейт видимости — GetOrder ПЕРЕД чтением истории: история не должна быть
   * обходным каналом к продаже, которую вызывающему видеть не положено
   * (гейт чтения истории = гейт чтения записи).
   *
   * TODO-124 (закрыт здесь же, в волне): `AuditGrpcController` висел под
   * `@RequireModule('audit')`, а модуля `audit` в MODULE_REGISTRY нет и в
   * `x-enabled-modules` он не попал бы никогда — домен отвечал
   * PERMISSION_DENIED на ЛЮБОЙ вызов с гейта, включая существующие
   * `/v1/contacts/:id/history` и `/v1/companies/:id/history`. Декоратор снят
   * (`audit/src/audit/audit.grpc.controller.ts`, регресс —
   * `audit/src/audit/audit.module-gate.spec.ts`): аудит сквозной, а не
   * подключаемый модуль. Модульный гейт остаётся ЗДЕСЬ и по сущности:
   * `@RequireModule('orders')` + `@RequirePermission('orders','read')` ниже.
   * Обходить гейт вырезанием `x-enabled-modules` из метадаты по-прежнему
   * НЕЛЬЗЯ: это подмена PEP, а не починка.
   */
  @Get('orders/:id/history')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async orderHistory(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const md = this.meta(req, projectId);
    const order = (await grpcBffCall(
      this.orders.getOrder({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;

    const ctx = emptyOrderHistoryContext();
    // Имена этапов и подписи пользовательских полей берём из ТОЙ ревизии типа,
    // к которой продажа закреплена (order_type_version), иначе история старой
    // продажи подписывалась бы этапами свежей версии.
    const typeId = String(order.type_id ?? '');
    if (typeId) {
      try {
        const detail = (await grpcBffCall(
          this.orders.getOrderType(
            {
              project_id: projectId,
              id: typeId,
              version: Number(order.order_type_version ?? 0) || 0,
            },
            md,
          ) as never,
        )) as {
          revision?: { stages?: Record<string, unknown>[]; fields?: Record<string, unknown>[] };
        };
        for (const s of detail.revision?.stages ?? []) {
          ctx.stageNameById.set(String(s.id ?? ''), String(s.name ?? ''));
        }
        for (const f of detail.revision?.fields ?? []) {
          ctx.fieldLabelByKey.set(String(f.key ?? ''), String(f.label ?? f.key ?? ''));
        }
      } catch {
        // fail-soft: тип удалён/недоступен — покажем историю с сырыми id этапов,
        // но не уроним всю карточку из-за подписи.
      }
    }

    const audit = this.audit;
    if (!audit) {
      // Клиент audit приходит из DI всегда; отсутствие — только сломанная сборка.
      // Отдаём честный 503, а не пустую историю: пустой список читался бы как
      // «изменений не было» — то самое враньё, ради которого TODO-414 и заведён.
      throw new ServiceUnavailableException('audit client is not configured');
    }
    const r = (await grpcBffCall(
      audit.listEvents(
        {
          project_id: projectId,
          page_index: 0,
          page_size: parsePageSize(limit ?? '50'),
          entity_type: 'order',
          entity_id: id,
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const events = r.list ?? [];

    const nameById = await this.identity.resolveNames(req, collectOrderHistoryUserIds(events));
    for (const [uid, name] of nameById) ctx.userNameById.set(uid, name);

    const items = events.map((e) => orderHistoryItemFe(e, ctx));
    return { items, hasMore: toNum(r.total) > items.length };
  }

  @Get('order-types')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async orderTypes(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.listOrderTypes(
        { project_id: projectId, include_deleted: includeDeleted === 'true' },
        this.meta(req, projectId),
      ) as never,
    )) as { list: unknown[] };
    return (r.list as Record<string, unknown>[]).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      fields: (Array.isArray(t.fields) ? (t.fields as Record<string, unknown>[]) : []).map(
        fieldSpecFe,
      ),
      stages: (Array.isArray(t.stages) ? (t.stages as Record<string, unknown>[]) : []).map(
        stageSpecFe,
      ),
      schemaVersion: t.schema_version,
      webhookEnabled: t.webhook_enabled,
      activeOrders: t.active_orders,
      currentVersion: t.current_version,
      deletedAt: t.deleted_at,
    }));
  }

  @Get('order-types/:id')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async getOrderType(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('version') version?: string,
  ) {
    return orderTypeDetailFe(
      (await grpcBffCall(
        this.orders.getOrderType(
          { project_id: projectId, id, version: version ? parseInt(version, 10) : 0 },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('order-types')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'manage')
  async createOrderType(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId: string,
  ) {
    return orderTypeDetailFe(
      (await grpcBffCall(
        this.orders.createOrderType(
          { project_id: projectId, spec: orderTypeSpecToGrpc(body) },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Put('order-types/:id')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'manage')
  async updateOrderType(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return orderTypeDetailFe(
      (await grpcBffCall(
        this.orders.updateOrderType(
          { project_id: projectId, id, spec: orderTypeSpecToGrpc(body) },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Delete('order-types/:id')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'manage')
  async deleteOrderType(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.deleteOrderType(
        { project_id: projectId, id },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return { id: r.id, deletedAt: r.deleted_at };
  }

  @Post('order-types/:id/restore')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'manage')
  async restoreOrderType(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return orderTypeDetailFe(
      (await grpcBffCall(
        this.orders.restoreOrderType(
          { project_id: projectId, id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('orders')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async createOrder(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    const productId = body.productId ? String(body.productId) : '';
    // BX-FLOW-3: keep the manual sale product-linked (like the auto-created one)
    // — forward product_id (previously dropped, so the order lost its catalog
    // link), and when the sale-type is omitted default it from the product's
    // configured sale-type (order_type_id) unless that link is dangling.
    // Fail-soft: a product-lookup fault never blocks the create — orders then
    // falls back to its first non-deleted sale-type exactly as before.
    let orderTypeId = body.orderTypeId ? String(body.orderTypeId) : '';
    if (!orderTypeId && productId) {
      try {
        const product = (await grpcBffCall(
          this.product.getProduct({ project_id: pid, id: productId }, this.meta(req, pid)) as never,
        )) as Record<string, unknown>;
        const productTypeId = product?.order_type_id ? String(product.order_type_id) : '';
        if (productTypeId && !product?.order_type_dangling) {
          orderTypeId = productTypeId;
        }
      } catch {
        // fail-soft — leave orderTypeId empty; orders resolves its own default.
      }
    }
    return this.orderWithNames(
      req,
      pid,
      (await grpcBffCall(
        this.orders.createOrder(
          {
            project_id: pid,
            deal_id: body.dealId,
            order_type_id: orderTypeId,
            contact_id: body.contactId,
            company_id: body.companyId,
            assignee_id: body.assigneeId,
            notes: body.notes,
            product_id: productId,
            // GAP-ORDERS-180/300/150/210: the FE names this bag `customFields`
            // (OrderEdit.tsx, EntityCreateDrawer.tsx) — reading only `body.fields`
            // dropped every custom-field value on the floor (fields_json === '{}').
            // Both spellings are accepted; `customFields` wins.
            fields_json: JSON.stringify(orderCustomFields(body) ?? {}),
          },
          this.meta(req, pid),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('orders/batch')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async createOrdersBatch(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    const items = Array.isArray(body.items) ? body.items : [];
    const r = (await grpcBffCall(
      this.orders.createOrdersBatch(
        {
          project_id: pid,
          deal_id: body.dealId,
          contact_id: body.contactId,
          company_id: body.companyId,
          assignee_id: body.assigneeId,
          items: items.map((item: Record<string, unknown>) => ({
            product_id: item.productId,
            order_type_id: item.orderTypeId,
            fields_json: JSON.stringify(orderCustomFields(item) ?? {}),
            notes: item.notes,
          })),
        },
        this.meta(req, pid),
      ) as never,
    )) as {
      created?: Record<string, unknown>[];
      errors?: Array<{ index?: number; code?: string; message?: string }>;
    };
    const created = await Promise.all(
      (r.created ?? []).map((o) => this.orderWithNames(req, pid, o)),
    );
    return {
      created,
      errors: (r.errors ?? []).map((e) => ({
        index: e.index ?? 0,
        code: e.code ?? 'CREATE_FAILED',
        message: e.message ?? '',
      })),
    };
  }

  @Put('orders/:id')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async updateOrder(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.updateOrder(
          {
            project_id: projectId,
            id,
            // GAP-ORDERS-180/300/150/210: same `customFields` vs `fields` mismatch as
            // on create — OrderEdit.tsx PUTs `{ customFields }`, so `fields_json` was
            // never sent at all and every edit of a custom field was a silent no-op.
            fields_json: (() => {
              const f = orderCustomFields(body);
              return f != null ? JSON.stringify(f) : undefined;
            })(),
            assignee_id: body.assigneeId,
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Put('orders/:orderId/stage')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'move')
  async moveOrder(
    @Req() req: GrpcReq,
    @Param('orderId') orderId: string,
    @Query('projectId') projectId: string,
    @Body() body: { stageId: string; acceptDrift?: boolean },
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.moveOrderToStage(
          {
            project_id: projectId,
            order_id: orderId,
            stage_id: body.stageId,
            accept_drift: !!body.acceptDrift,
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('orders/:id/cancel')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async cancelOrder(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { reason?: string },
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.cancelOrder(
          { project_id: projectId, id, reason: body?.reason },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Get('orders/:id/drift')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async orderDrift(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.checkDrift({ project_id: projectId, id }, this.meta(req, projectId)) as never,
    )) as { has_drift?: boolean; source_state?: string; diffs?: Record<string, unknown>[] };
    return {
      hasDrift: !!r.has_drift,
      sourceState: r.source_state ?? 'present',
      diffs: (Array.isArray(r.diffs) ? r.diffs : []).map((d) => ({
        entity: d.entity,
        field: d.field,
        old: d.old,
        new: d.new,
      })),
    };
  }

  @Post('orders/:id/accept-drift')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async acceptOrderDrift(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.acceptDrift({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('orders/:id/retry')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders.integration', 'invoke')
  async retryFinalAction(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return this.orderWithNames(
      req,
      projectId,
      (await grpcBffCall(
        this.orders.retryFinalAction(
          { project_id: projectId, id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('orders/reassign')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'write')
  async reassignOrders(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body()
    body: {
      fromAssigneeId: string;
      toAssigneeId: string;
      filter?: { typeId?: string; status?: string; stageId?: string };
    },
  ) {
    const r = (await grpcBffCall(
      this.orders.reassignOrders(
        {
          project_id: projectId,
          from_assignee_id: body.fromAssigneeId,
          to_assignee_id: body.toAssigneeId,
          type_id: body.filter?.typeId,
          status: body.filter?.status,
          stage_id: body.filter?.stageId,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { reassigned?: number };
    return { reassigned: r.reassigned ?? 0 };
  }

  @Get('deals/:dealId/orders-summary')
  @ApiTags('Orders')
  @RequireModule('orders')
  @RequirePermission('orders', 'read')
  async dealOrdersSummary(
    @Req() req: GrpcReq,
    @Param('dealId') dealId: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.orders.getOrdersSummaryForDeal(
        { project_id: projectId, deal_id: dealId },
        this.meta(req, projectId),
      ) as never,
    )) as {
      total?: number;
      by_status?: { status: string; count: number }[];
      items?: Record<string, unknown>[];
    };
    const byStatus: Record<string, number> = {};
    for (const b of Array.isArray(r.by_status) ? r.by_status : []) byStatus[b.status] = b.count;
    return {
      total: r.total ?? 0,
      byStatus,
      items: (Array.isArray(r.items) ? r.items : []).map((it) => ({
        id: it.id,
        number: it.number,
        status: it.status,
        stageId: it.stage_id,
        assigneeName: it.assignee_name,
        stageName: it.stage_name,
        typeName: it.type_name,
        productName: it.product_name,
        dealName: it.deal_name,
      })),
    };
  }

  @Get('activities')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'read')
  async listActivities(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('type') type?: string,
    @Query('types') types?: string | string[],
    @Query('status') status?: string,
    @Query('overdueOnly') overdueOnly?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('linkEntityType') linkEntityType?: string,
    @Query('linkEntityId') linkEntityId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('sortField') sortField?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('state') state?: string,
    // TODO-183: виджет «Активности» в карточке сделки (DealDetails.tsx) зовёт
    // `GET /v1/activities?dealId=<id>` — параметра с таким именем тут не было,
    // фильтр молча терялся и виджет показывал активности ВСЕГО проекта.
    // Алиас: dealId → link_entity_type='deal' + link_entity_id (`deal` входит в
    // LINK_TYPES домена, activity.service.ts:18). Явные linkEntityType/linkEntityId
    // приоритетнее — алиас только дополняет, а не переопределяет.
    @Query('dealId') dealId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('withoutAssignee') withoutAssignee?: string,
  ) {
    const md = this.meta(req, projectId);
    if (state === 'trashed') {
      // Тот же ответ, что даёт PEP на GET /activities/trash: матрица роли ИЛИ
      // гранулярный грант activities:delete (projectRoleCanKey, как в
      // project-access.guard.ts) — иначе роль с точечным грантом видит /trash,
      // но получает 403 на state=trashed.
      if (!projectRoleCanKey(req.__projectRole, 'activities', 'delete')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          subject: 'activities',
          action: 'delete',
          message: `Role "${req.__projectRole || 'none'}" cannot view activity trash`,
        });
      }
      const rt = (await grpcBffCall(
        this.activity.listTrash(
          {
            project_id: projectId,
            page_index: parseInt(pageIndex ?? '0', 10),
            page_size: parsePageSize(pageSize),
            query: query ?? '',
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      const listT = Array.isArray(rt.list) ? rt.list : [];
      return {
        list: listT.map(activityFe),
        total: typeof rt.total === 'number' ? rt.total : listT.length,
      };
    }
    const num = (v?: string) => (v != null && v !== '' ? parseInt(v, 10) : undefined);
    const explicitLink = Boolean(linkEntityType || linkEntityId);
    const linkType = explicitLink ? (linkEntityType ?? '') : dealId ? 'deal' : '';
    const linkId = explicitLink ? (linkEntityId ?? '') : (dealId ?? '');
    const typeList = parseQueryTypes(type, types);
    const r = (await grpcBffCall(
      this.activity.listActivities(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
          type: typeList.length === 1 ? typeList[0] : '',
          types: typeList.length > 1 ? typeList : [],
          status: status ?? '',
          overdue_only: overdueOnly === 'true',
          assignee_id: assigneeId,
          department_id: departmentId,
          link_entity_type: linkType,
          link_entity_id: linkId,
          date_from: num(dateFrom),
          date_to: num(dateTo),
          include_deleted: includeDeleted === 'true',
          sort_field: sortField ?? '',
          sort_order: sortOrder ?? '',
          without_assignee: withoutAssignee === 'true',
        },
        md,
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(activityFe), total: r.total };
  }

  @Get('activities/trash')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'delete')
  async listActivitiesTrash(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const r = (await grpcBffCall(
      this.activity.listTrash(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      list: list.map(activityFe),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }

  @Get('activities/overdue-count')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'read')
  async overdueCount(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('assigneeId') assigneeId?: string,
  ) {
    const r = (await grpcBffCall(
      this.activity.countOverdue(
        { project_id: projectId, assignee_id: assigneeId },
        this.meta(req, projectId),
      ) as never,
    )) as { count: number };
    return { count: r.count };
  }

  @Get('activities/calendar')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'read')
  async actCal(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('type') type?: string,
    @Query('mine') mine?: string,
    @Query('linkEntityId') linkEntityId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const num = (v?: string) => (v != null && v !== '' ? parseInt(v, 10) : undefined);
    const r = (await grpcBffCall(
      this.activity.listActivitiesCalendar(
        {
          project_id: projectId,
          type: type ?? '',
          mine: mine ?? '',
          link_entity_id: linkEntityId ?? '',
          date_from: num(dateFrom),
          date_to: num(dateTo),
        },
        this.meta(req, projectId),
      ) as never,
    )) as {
      events?: {
        id: string;
        title: string;
        start: number;
        end: number;
        all_day: boolean;
        color: string;
        type?: string;
        overdue?: boolean;
      }[];
    };
    const events = Array.isArray(r.events) ? r.events : [];
    // CalendarEvent.start/end — int64 (мс). ОБЯЗАТЕЛЬНО через toNum: сырой Long
    // давал `new Date(объект)` = Invalid Date, а прежний fallback подставлял
    // «сейчас» — календарь сваливал ВСЕ активности проекта в текущий момент.
    // Теперь невалидная метка = событие отбрасывается: показать пусто честнее,
    // чем показать ложную дату.
    const toIso = (v: unknown): string | null => {
      const ms = toNum(v);
      if (!ms) return null;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    };
    return events.flatMap((e) => {
      const start = toIso(e.start);
      if (start == null) return [];
      return [
        {
          id: e.id,
          title: e.title,
          start,
          // Нет валидного конца → точечное событие (end = start), а не выдуманное
          // «сейчас»: домен и сам отдаёт end == start для task/call.
          end: toIso(e.end) ?? start,
          allDay: e.all_day,
          color: e.color,
          extendedProps: { type: e.type, overdue: Boolean(e.overdue) },
        },
      ];
    });
  }

  @Get('activities/:id')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'read')
  async getAct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return activityFe(
      (await grpcBffCall(
        this.activity.getActivity(
          { project_id: projectId, id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('activities')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'write')
  async createAct(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1: projectId is taken from the trusted query/metadata, not the body.
    // SEC-ISO-1 (TODO-001): guard-enforced query/header only; mismatching body → 403.
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    return activityFe(
      (await grpcBffCall(
        this.activity.createActivity(
          {
            project_id: pid,
            type: body.type,
            title: body.title,
            description: body.description,
            status: body.status,
            priority: body.priority,
            due_date: body.dueDate,
            has_due_date: body.dueDate !== undefined,
            start_date: body.startDate,
            end_date: body.endDate,
            all_day: body.allDay === true,
            direction: body.direction,
            duration: body.duration,
            location: body.location,
            participants: Array.isArray(body.participants) ? body.participants : undefined,
            reminder_offset: body.reminderOffset,
            assignee_id: body.assigneeId,
            department_id: body.departmentId,
            links: linksToProto(body.links),
            contact_id: body.contactId,
            company_id: body.companyId,
            deal_id: body.dealId,
            order_id: body.orderId,
          },
          this.meta(req, pid),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Patch('activities/:id')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'write')
  async updateAct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return activityFe(
      (await grpcBffCall(
        this.activity.updateActivity(
          {
            project_id: projectId,
            id,
            title: body.title,
            description: body.description,
            status: body.status,
            priority: body.priority,
            due_date: body.dueDate,
            start_date: body.startDate,
            end_date: body.endDate,
            all_day: body.allDay,
            direction: body.direction,
            duration: body.duration,
            location: body.location,
            participants: Array.isArray(body.participants) ? body.participants : undefined,
            reminder_offset: body.reminderOffset,
            assignee_id: body.assigneeId,
            department_id: body.departmentId,
            links: linksToProto(body.links),
            has_links: body.links !== undefined,
            can_manage: canManage(req),
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('activities/:id/complete')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'write')
  async completeAct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return activityFe(
      (await grpcBffCall(
        this.activity.completeActivity(
          {
            project_id: projectId,
            id,
            result: body?.result,
            actual_duration: body?.actualDuration,
            completed_at: body?.completedAt,
            can_manage: canManage(req),
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Delete('activities/:id')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'delete')
  async deleteAct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    await grpcBffCall(
      this.activity.deleteActivity(
        { project_id: projectId, id, can_manage: canManage(req) },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
    return { ok: true };
  }

  @Post('activities/:id/restore')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'delete')
  async restoreAct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return activityFe(
      (await grpcBffCall(
        this.activity.restoreActivity(
          { project_id: projectId, id, can_manage: canManage(req) },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('activities/bulk')
  @ApiTags('Activities')
  @RequireModule('activities')
  @RequirePermission('activities', 'write')
  async bulkActivities(
    @Req() req: GrpcReq,
    @Query('projectId') qpid: string,
    @Body() body: { action?: string; ids?: string[]; result?: string; projectId?: string },
  ) {
    // SEC-ISO-1 (TODO-001): guard-enforced query/header only; mismatching body → 403.
    const projectId = this.authoritativeProjectId(req, qpid, body?.projectId);
    const action = body?.action;
    const ids = Array.isArray(body?.ids) ? body!.ids! : [];
    if (action !== 'complete' && action !== 'delete') {
      return {
        succeeded: [],
        failed: ids.map((id) => ({ id, code: 'INVALID_ARGUMENT', message: 'unknown action' })),
      };
    }
    // TODO-004: bulk delete must require the same right as the single
    // DELETE activities/:id route (@RequirePermission('activities','delete')).
    // The route-level decorator only enforces 'write', so re-check 'delete'
    // explicitly against the guard-resolved project role (fail-closed).
    if (action === 'delete' && !projectRoleCan(req.__projectRole, 'delete')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        subject: 'activities',
        action: 'delete',
        message: `Role "${req.__projectRole || 'none'}" cannot delete activities`,
      });
    }
    if (ids.length > 100) {
      return {
        succeeded: [],
        failed: [{ id: '', code: 'RESOURCE_EXHAUSTED', message: 'ids limit is 100' }],
      };
    }
    const cm = canManage(req);
    const succeeded: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];
    // Orchestration on gateway; the domain re-checks perms/visibility per record.
    for (const id of ids) {
      const md = this.metaWithScopedIdempotency(req, projectId, id);
      try {
        if (action === 'complete') {
          await grpcBffCall(
            this.activity.completeActivity(
              { project_id: projectId, id, result: body?.result, can_manage: cm },
              md,
            ) as never,
            'write',
          );
        } else {
          await grpcBffCall(
            this.activity.deleteActivity(
              { project_id: projectId, id, can_manage: cm },
              md,
            ) as never,
            'write',
          );
        }
        succeeded.push(id);
      } catch (e) {
        const err = e as { code?: unknown; message?: string };
        failed.push({ id, code: grpcCodeToString(err.code), message: err.message ?? 'failed' });
      }
    }
    return { succeeded, failed };
  }

  @Get('products')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'read')
  async products(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
  ) {
    const r = (await grpcBffCall(
      this.product.listProducts(
        {
          project_id: projectId,
          page_index: parsePageIndex(pageIndex),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
          category: category ?? '',
          status: status ?? '',
          sort: sort ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(productFe), total: r.total };
  }

  @Get('products/categories')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'read')
  async productCategories(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const r = (await grpcBffCall(
      this.product.listCategories({ project_id: projectId }, this.meta(req, projectId)) as never,
    )) as { categories?: string[] };
    return Array.isArray(r.categories) ? r.categories : [];
  }

  @Get('products/export')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'export')
  @Header('Cache-Control', 'no-store')
  async exportProducts(
    @Req() req: GrpcReq,
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('projectId') projectId: string,
    @Query('format') format?: string,
    @Query('query') query?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    const requested = (format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    // Export reuses ListProducts with the *same* visibility scope as the list — never a full
    // project dump. Fail-closed visibility is pushed down and enforced domain-side.
    const r = (await grpcBffCall(
      this.product.listProducts(
        {
          project_id: projectId,
          page_index: 0,
          page_size: 1000,
          query: query ?? '',
          category: category ?? '',
          status: status ?? '',
          sort: '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    const rows = (r.list ?? []).map(productFe);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let payload: string;
    let contentType: string;
    if (requested === 'json') {
      payload = JSON.stringify(rows, null, 2);
      contentType = 'application/json; charset=utf-8';
    } else {
      const cols = [
        'name',
        'category',
        'price',
        'currency',
        'unit',
        'orderTypeName',
        'status',
      ] as const;
      const escape = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      payload = [
        cols.join(','),
        ...rows.map((row) =>
          cols.map((c) => escape((row as Record<string, unknown>)[c])).join(','),
        ),
      ].join('\n');
      contentType = 'text/csv; charset=utf-8';
    }
    void res.header('Content-Type', contentType);
    void res.header('Content-Disposition', `attachment; filename="products-${stamp}.${requested}"`);
    return Buffer.from(payload, 'utf8');
  }

  @Post('products')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'write')
  async createProduct(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    return productFe(
      (await grpcBffCall(
        this.product.createProduct(
          {
            project_id: pid,
            name: body.name,
            description: body.description,
            category: body.category,
            price: body.price,
            unit: body.unit,
            currency: body.currency,
            order_type_id: body.orderTypeId,
            order_type_name: body.orderTypeName,
            prefill: prefillToStruct(body.prefill),
            owner_department_id: body.ownerDepartmentId,
          },
          this.meta(req, pid),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Put('products/:id')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'write')
  async updateProduct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return productFe(
      (await grpcBffCall(
        this.product.updateProduct(
          {
            project_id: projectId,
            id,
            name: body.name,
            description: body.description,
            category: body.category,
            price: body.price,
            unit: body.unit,
            currency: body.currency,
            order_type_id: body.orderTypeId,
            order_type_name: body.orderTypeName,
            prefill: prefillToStruct(body.prefill),
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('products/:id/archive')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'write')
  async archiveProduct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.product.archiveProduct(
        { project_id: projectId, id },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return { ok: true, affected: productAffectedFe(r.affected as Record<string, unknown>) };
  }

  @Post('products/:id/restore')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'write')
  async restoreProduct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return productFe(
      (await grpcBffCall(
        this.product.restoreProduct(
          { project_id: projectId, id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  /**
   * Reconciliation (contract §3.10, TODO-234): recompute usage counters from
   * authoritative pipe/orders counts. Empty body.id → whole project backfill.
   */
  @Post('products/recount')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'manage')
  async recountProducts(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Body() body?: { id?: string },
  ) {
    const r = (await grpcBffCall(
      this.product.recountProductUsage(
        { project_id: projectId, id: body?.id ?? '' },
        this.meta(req, projectId),
      ) as never,
    )) as { recounted?: number; skipped?: number };
    return { recounted: r.recounted ?? 0, skipped: r.skipped ?? 0 };
  }

  @Delete('products/:id')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'delete')
  async deleteProduct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('force') force?: string,
  ) {
    const r = (await grpcBffCall(
      this.product.deleteProduct(
        { project_id: projectId, id, force: force === 'true' },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return r.affected
      ? { ok: true, affected: productAffectedFe(r.affected as Record<string, unknown>) }
      : { ok: true };
  }

  @Get('products/:id/usage')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'read')
  async productUsage(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('departmentId') departmentId?: string,
  ) {
    const r = (await grpcBffCall(
      this.product.getProductUsage(
        { project_id: projectId, id, department_id: departmentId ?? '' },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    return {
      dealsCount: r.deals_count ?? 0,
      activeDealsCount: r.active_deals_count ?? 0,
      ordersCount: r.orders_count ?? 0,
      byDepartment: (Array.isArray(r.by_department) ? r.by_department : []).map((x) => {
        const v = x as Record<string, unknown>;
        return { departmentId: v.department_id, deals: v.deals, orders: v.orders };
      }),
      byUser: (Array.isArray(r.by_user) ? r.by_user : []).map((x) => {
        const v = x as Record<string, unknown>;
        return { userId: v.user_id, deals: v.deals, orders: v.orders };
      }),
    };
  }

  @Get('products/:id')
  @ApiTags('Products')
  @RequireModule('products')
  @RequirePermission('products', 'read')
  async getProduct(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return productFe(
      (await grpcBffCall(
        this.product.getProduct({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      )) as Record<string, unknown>,
    );
  }

  // ===== Templates (project-scoped) ====================================

  @Get('document-templates')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async listTemplates(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('contextType') contextType?: string,
    @Query('recordId') recordId?: string,
    @Query('status') statusFilter?: string,
  ) {
    // BX-FLOW-4: for an order card, resolve record_id(order)→order.type_id and pass
    // it to documents so template suggestions are narrowed to that sale type.
    // Fail-soft: if the order is missing/inaccessible we skip narrowing (no filter).
    let orderTypeId: string | undefined;
    if (contextType === 'order' && recordId) {
      try {
        const ord = (await grpcBffCall(
          this.orders.getOrder(
            { project_id: projectId, id: recordId },
            this.meta(req, projectId),
          ) as never,
        )) as Record<string, unknown>;
        orderTypeId = ord?.type_id ? String(ord.type_id) : undefined;
      } catch {
        orderTypeId = undefined;
      }
    }
    const r = (await grpcBffCall(
      this.documents.listTemplates(
        {
          project_id: projectId,
          context_type: contextType,
          record_id: recordId,
          status: statusFilter,
          order_type_id: orderTypeId,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[] };
    const items = (Array.isArray(r.list) ? r.list : []).map(documentTemplateFe);
    return { items: this.filterTemplatesByEnabledModules(req, items) };
  }

  @Get('document-templates/:id')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async getTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('version') version?: string,
  ) {
    return documentTemplateFe(
      (await grpcBffCall(
        this.documents.getTemplate(
          { project_id: projectId, id, version: version ? parseInt(version, 10) : 0 },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  // BX-DOCS-1: the FE posts the DOCX as multipart/form-data (FormData{file, name,
  // contextType, orderTypeId?}). The gateway sanitizes the bytes (OOXML/VBA/XXE/
  // zip-bomb — FR-MDOC-9/10) and streams them into the PRIVATE documents bucket
  // BEFORE ever calling the domain, then hands the resolved storage pointer over
  // gRPC. A JSON body carrying a pre-uploaded pointer stays honoured for back-compat.
  @Post('document-templates')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'manage')
  async createTemplate(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    const b = body ?? {};
    const mp = await this.readMultipart(req);

    let pid: string;
    let name: unknown;
    let contextType: unknown;
    let orderTypeId: unknown;
    let pointer: {
      bucket: unknown;
      objectKey: unknown;
      fileHash: unknown;
      sizeBytes: unknown;
      mimeType: unknown;
    };

    if (mp) {
      if (!mp.buffer) throw new BadRequestException('file is required');
      pid = this.authoritativeProjectId(req, qpid, mp.field('projectId'));
      name = mp.field('name');
      contextType = mp.field('contextType');
      orderTypeId = mp.field('orderTypeId');
      const stored = await this.docStorage.uploadTemplateFile({
        projectId: pid,
        fileName: mp.filename,
        buffer: mp.buffer,
      });
      pointer = {
        bucket: stored.bucket,
        objectKey: stored.objectKey,
        fileHash: stored.fileHash,
        sizeBytes: stored.sizeBytes,
        mimeType: stored.mimeType,
      };
    } else {
      pid = this.authoritativeProjectId(req, qpid, b.projectId);
      name = b.name;
      contextType = b.contextType;
      orderTypeId = b.orderTypeId;
      // X4: the JSON branch names an address the domain will READ FROM
      // (`validateTemplateFile` → `getObjectBuffer(bucket, objectKey)`) — the
      // sharpest instance of the class, since the fetched bytes are then parsed.
      pointer = this.trustedClientPointer(pid, b, DOCX_MIME);
    }

    // TODO-098: шаблон нельзя привязать к контексту, чей модуль-донор выключен в
    // проекте (иначе шаблон создаётся мёртвым — генерация по нему невозможна).
    this.assertContextModuleEnabled(req, contextType);

    return documentTemplateFe(
      (await grpcBffCall(
        this.documents.createTemplate(
          {
            project_id: pid,
            name,
            context_type: contextType,
            order_type_id: orderTypeId ?? '',
            bucket: pointer.bucket,
            object_key: pointer.objectKey,
            file_hash: pointer.fileHash,
            size_bytes: pointer.sizeBytes,
            mime_type: pointer.mimeType,
            // declared_variables are extracted from the DOCX by the domain (BX-DOCS-2).
            declared_variables: b.declaredVariables ?? [],
          },
          this.meta(req, pid),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  // PUT creates a NEW draft revision (FR-MDOC-2), prior revisions are immutable.
  // BX-DOCS-1: multipart{file?, name} — a new file is sanitized + uploaded to S3
  // and forwarded as a real pointer (new revision); with NO file part the edit is
  // metadata-only (rename), the domain updates the name without a new revision. A
  // JSON pointer body stays honoured for back-compat.
  @Put('document-templates/:id')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'manage')
  async updateTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const b = body ?? {};
    const mp = await this.readMultipart(req);

    let name: unknown;
    // X4: same rule as `createTemplate` — a body-supplied pointer is held to the
    // configured bucket and the authorized project prefix. An empty objectKey stays
    // empty (metadata-only rename: the domain then updates the name without a new
    // revision), so back-compat behaviour is unchanged. Resolved lazily so a
    // multipart edit keeps working exactly as before.
    let pointer: {
      bucket: unknown;
      objectKey: unknown;
      fileHash: unknown;
      sizeBytes: unknown;
      mimeType: unknown;
    };

    if (mp?.buffer) {
      name = mp.field('name') ?? '';
      const pid = this.authoritativeProjectId(req, projectId, mp.field('projectId'));
      const stored = await this.docStorage.uploadTemplateFile({
        projectId: pid,
        fileName: mp.filename,
        buffer: mp.buffer,
      });
      pointer = {
        bucket: stored.bucket,
        objectKey: stored.objectKey,
        fileHash: stored.fileHash,
        sizeBytes: stored.sizeBytes,
        mimeType: stored.mimeType,
      };
    } else {
      name = mp ? (mp.field('name') ?? '') : (b.name ?? '');
      pointer = this.trustedClientPointer(
        this.authoritativeProjectId(req, projectId, b.projectId),
        b,
        DOCX_MIME,
      );
    }

    return documentTemplateFe(
      (await grpcBffCall(
        this.documents.createTemplateRevision(
          {
            project_id: projectId,
            id,
            name,
            bucket: pointer.bucket,
            object_key: pointer.objectKey,
            file_hash: pointer.fileHash,
            size_bytes: pointer.sizeBytes,
            mime_type: pointer.mimeType,
            // declared_variables are extracted from the DOCX by the domain (BX-DOCS-2).
            declared_variables: b.declaredVariables ?? [],
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('document-templates/:id/publish')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'manage')
  async publishTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return documentTemplateFe(
      (await grpcBffCall(
        this.documents.publishTemplate(
          { project_id: projectId, id, version: body?.version ? Number(body.version) : 0 },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('document-templates/:id/archive')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'manage')
  async archiveTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return documentTemplateFe(
      (await grpcBffCall(
        this.documents.archiveTemplate(
          { project_id: projectId, id },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Get('document-templates/:id/revisions')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async listTemplateRevisions(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.documents.listTemplateRevisions(
        { project_id: projectId, id },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[] };
    return { items: (Array.isArray(r.list) ? r.list : []).map(templateRevisionFe) };
  }

  // BX-DOCS-4/G4: download the ORIGINAL DOCX of a template revision. The domain
  // resolves the revision (?version, else current published, else latest draft),
  // validates the objectKey prefix BEFORE S3 (B-2) and returns a short-lived
  // presigned URL — never a public/permanent URL. The FE opens it to download.
  @Get('document-templates/:id/download')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async downloadTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('version') version?: string,
    @Query('ttlSec') ttlSec?: string,
  ) {
    const r = (await grpcBffCall(
      this.documents.getTemplateDownloadUrl(
        {
          project_id: projectId,
          id,
          version: version ? parseInt(version, 10) : 0,
          ttl_sec: ttlSec ? parseInt(ttlSec, 10) : 0,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { url: string; expires_at: number };
    void appendPiiEgressAudit(
      this.audit as { appendEvent: (x: unknown, m?: unknown) => unknown } | undefined,
      this.outboundMeta,
      req,
      projectId,
      {
        channel: 'presigned_url',
        subject: 'document-templates',
        entityId: id,
      },
    );
    return { url: r.url, expiresAt: r.expires_at };
  }

  @Delete('document-templates/:id')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'manage')
  async deleteTemplate(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.documents.deleteTemplate(
        { project_id: projectId, id },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  // GET /api/document-variables (§3.9) — variable palette for the template editor.
  // Gateway-owned aggregation (documents does NOT store it, ТЗ §5.5); today a
  // static catalog mirroring the donor `ResolveDocumentVariables` keys + globals.
  @Get('document-variables')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async listDocumentVariables(
    @Req() req: GrpcReq,
    @Query('contextType') contextType?: string,
    @Query('projectId') projectId?: string,
    @Query('recordId') recordId?: string,
    @Query('orderTypeId') orderTypeId?: string,
  ) {
    if (!isDocVarContextType(contextType)) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: 'contextType is required and must be one of order|deal|contact|company',
      });
    }
    const modules = (req as unknown as Record<string, unknown>).__enabledModules;
    const enabled = Array.isArray(modules) ? (modules as string[]) : undefined;
    let items = documentVariablesCatalog(contextType, enabled);
    if (contextType === 'order') {
      let typeId = orderTypeId?.trim() || '';
      if (!typeId && recordId && projectId) {
        try {
          const ord = (await grpcBffCall(
            this.orders.getOrder(
              { project_id: projectId, id: recordId },
              this.meta(req, projectId),
            ) as never,
          )) as Record<string, unknown>;
          typeId = ord?.type_id ? String(ord.type_id) : '';
        } catch {
          typeId = '';
        }
      }
      if (typeId && projectId) {
        try {
          const ot = (await grpcBffCall(
            this.orders.getOrderType(
              { project_id: projectId, id: typeId },
              this.meta(req, projectId),
            ) as never,
          )) as { revision?: { fields?: Array<Record<string, unknown>> } };
          const fields = ot?.revision?.fields ?? [];
          const dynamic = fields
            .filter((f) => f.key && !f.deprecated)
            .map((f) => ({
              key: `order.field.${String(f.key)}`,
              label: String(f.label ?? f.key),
              group: 'Продажа',
              required: Boolean(f.required),
              source: 'order' as const,
            }));
          const seen = new Set(items.map((i) => i.key));
          for (const entry of dynamic) {
            if (!seen.has(entry.key)) items.push(entry);
          }
        } catch {
          // fail-soft: static manifest still usable without dynamic fields
        }
      }
    }
    return { items };
  }

  // ===== Documents (owner-scoped) ======================================

  @Get('documents')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async listDocuments(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('contextType') contextType?: string,
    @Query('recordId') recordId?: string,
    @Query('ownerId') ownerId?: string,
    @Query('hasDrift') hasDrift?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('sourceKind') sourceKind?: string,
    @Query('fileType') fileType?: string,
    @Query('templateId') templateId?: string,
    @Query('emptyVarsOnly') emptyVarsOnly?: string,
  ) {
    const kind = sourceKind === 'generated' || sourceKind === 'uploaded' ? sourceKind : undefined;
    const r = (await grpcBffCall(
      this.documents.listDocuments(
        {
          project_id: projectId,
          context_type: contextType,
          record_id: recordId,
          owner_id: ownerId,
          has_drift_set: hasDrift !== undefined,
          has_drift: hasDrift === 'true',
          from: from ? parseInt(from, 10) : 0,
          to: to ? parseInt(to, 10) : 0,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          search: search?.trim() || undefined,
          source_kind: kind,
          file_type: fileType?.trim() || undefined,
          template_id: templateId?.trim() || undefined,
          empty_vars_only_set: emptyVarsOnly !== undefined,
          empty_vars_only: emptyVarsOnly === 'true',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: unknown };
    return { list: (r.list ?? []).map(documentGroupFe), total: toNum(r.total) };
  }

  @Get('documents/:groupId')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async getDocument(
    @Req() req: GrpcReq,
    @Param('groupId') groupId: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.documents.getDocument(
        { project_id: projectId, group_id: groupId },
        this.meta(req, projectId),
      ) as never,
    )) as {
      group: Record<string, unknown>;
      versions: Record<string, unknown>[];
      drift: Record<string, unknown>;
    };
    return {
      group: documentGroupFe(r.group),
      versions: (r.versions ?? []).map(documentVersionFe),
      drift: driftStatusFe(r.drift ?? {}),
    };
  }

  @Get('documents/:groupId/versions')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async listVersions(
    @Req() req: GrpcReq,
    @Param('groupId') groupId: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.documents.listVersions(
        { project_id: projectId, group_id: groupId },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[] };
    return { items: (r.list ?? []).map(documentVersionFe) };
  }

  // documents does NOT accept caller-supplied variable values (FR-MDOC-6). The
  // gateway resolves them from the context donor via ResolveDocumentVariables
  // (`resolveDocumentVariables` helper) and proxies {values,sourceHash,emptyRequired}.
  @Post('documents/generate')
  @ApiTags('Documents')
  @RequireModule('documents')
  // Same catalog key the FE gates the button on (`documents.generate:execute`,
  // TODO-045) — one key for one action on both sides. `execute` is manager+ in
  // the flat matrix, PLUS member via the granular key allow-list
  // (PROJECT_ROLE_KEY_ALLOWLIST, owner decision 2026-08-16) — viewer denied;
  // matches the PDP expansion (expandSystemRolePermissions).
  @RequirePermission('documents.generate', 'execute')
  async generateDocument(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    // TODO-098: генерация по контексту выключенного модуля-донора отклоняется здесь
    // явным MODULE_DISABLED — до похода к донору, который ответил бы
    // PERMISSION_DENIED («нет доступа к записи») и увёл диагностику в сторону.
    this.assertContextModuleEnabled(req, body.contextType);
    const contextType = String(body.contextType ?? '');
    const recordId = String(body.recordId ?? '');
    const vars =
      contextType === 'order'
        ? await this.resolveOrderDocumentVariables(
            req,
            pid,
            recordId,
            String(body.templateId ?? ''),
            !!body.acceptDrift,
          )
        : await this.resolveDocumentVariables(req, pid, contextType, recordId);
    // Merge the global `project.name` on top of the donor map (BX-DOCS-3/G3).
    const valuesJson = await this.withGlobalVariables(req, pid, vars.values_json);
    // GAP-DOCS-190/B2: reporting snapshot of the SOURCE record's owner. The
    // document's own `owner_id` (the ABAC field) stays the creator — resolved by
    // the domain from `x-user-id`, never sent from here.
    const ctxOwner = await this.resolveContextOwner(
      req,
      pid,
      String(body.contextType ?? ''),
      String(body.recordId ?? ''),
    );
    const r = (await grpcBffCall(
      this.documents.generateDocument(
        {
          project_id: pid,
          template_id: body.templateId,
          context_type: body.contextType,
          record_id: body.recordId,
          use_revision: body.useRevision ?? 'current',
          trigger_event_id: body.triggerEventId ?? '',
          context_owner_id: ctxOwner.context_owner_id,
          context_owner_department_id: ctxOwner.context_owner_department_id,
          values_json: valuesJson,
          source_hash: vars.source_hash,
          empty_required: vars.empty_required,
        },
        this.meta(req, pid),
      ) as never,
      'write',
    )) as {
      group: Record<string, unknown>;
      version: Record<string, unknown>;
      warnings?: Record<string, unknown>;
    };
    return {
      group: documentGroupFe(r.group),
      version: documentVersionFe(r.version),
      warnings: generateWarningsFe(r.warnings),
    };
  }

  @Post('documents/:groupId/regenerate')
  @ApiTags('Documents')
  @RequireModule('documents')
  // `documents.generate:execute` — same catalog key as the FE gate (TODO-045).
  @RequirePermission('documents.generate', 'execute')
  async regenerateDocument(
    @Req() req: GrpcReq,
    @Param('groupId') groupId: string,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId: string,
  ) {
    // regenerate carries only group_id — read the group to learn its context
    // (contextType/contextRecordId) so we can re-resolve the donor variables.
    // Fail-soft: if the lookup/donor errors, fall back to the empty map.
    let vars = { values_json: '{}', source_hash: '', empty_required: [] as string[] };
    try {
      const g = (await grpcBffCall(
        this.documents.getDocument(
          { project_id: projectId, group_id: groupId },
          this.meta(req, projectId),
        ) as never,
      )) as {
        group?: {
          context_type?: string;
          context_record_id?: string;
          template_id?: string;
        };
      };
      this.assertContextModuleEnabled(req, g.group?.context_type);
      const contextType = String(g.group?.context_type ?? '');
      const recordId = String(g.group?.context_record_id ?? '');
      // FR-ORDERS-255: order regenerate is still document generation — same
      // drift-gate + `crm.order.document_requested` as POST /documents/generate.
      vars =
        contextType === 'order'
          ? await this.resolveOrderDocumentVariables(
              req,
              projectId,
              recordId,
              String(g.group?.template_id ?? ''),
              !!body.acceptDrift,
            )
          : await this.resolveDocumentVariables(req, projectId, contextType, recordId);
    } catch (e) {
      // GAP-DOCS-115/185 + TODO-077: любой вердикт донора доходит до клиента —
      // 403/404 (PEP), 409 DRIFT_NOT_ACCEPTED, 400 (нет templateId), 503
      // (донор недоступен). Перевыпуск создаёт НОВУЮ версию, поэтому «тихо
      // перегенерировать с пустой картой» — тот же дефект, что и в generate.
      // Мягким остаётся только сбой чтения самой группы.
      if (e instanceof HttpException) {
        throw e;
      }
      // keep the empty map
    }
    // Merge the global `project.name` on top of the donor map (BX-DOCS-3/G3).
    const valuesJson = await this.withGlobalVariables(req, projectId, vars.values_json);
    const r = (await grpcBffCall(
      this.documents.regenerateDocument(
        {
          project_id: projectId,
          group_id: groupId,
          use_revision: body.useRevision ?? 'current',
          expected_version: body.expectedVersion ? Number(body.expectedVersion) : 0,
          values_json: valuesJson,
          source_hash: vars.source_hash,
          empty_required: vars.empty_required,
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as {
      group: Record<string, unknown>;
      version: Record<string, unknown>;
      warnings?: Record<string, unknown>;
    };
    return {
      group: documentGroupFe(r.group),
      version: documentVersionFe(r.version),
      warnings: generateWarningsFe(r.warnings),
    };
  }

  // BX-DOCS-1: the FE posts a finished document as multipart/form-data
  // (FormData{file, name, contextType, recordId}). The gateway streams the bytes
  // into the PRIVATE documents bucket (under projectId/) and hands the resolved
  // pointer + computed fileHash to the domain. Uploaded documents are stored as-is
  // (any MIME) — they are never rendered by the template engine. A JSON pointer
  // body stays honoured for back-compat.
  @Post('documents/upload')
  @ApiTags('Documents')
  @RequireModule('documents')
  // `documents.generate:execute` — same catalog key as the FE gate (TODO-045).
  @RequirePermission('documents.generate', 'execute')
  async uploadDocument(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    const b = body ?? {};
    const mp = await this.readMultipart(req);

    const contextTypeEarly = mp
      ? (mp.field('contextType') ?? 'none')
      : ((b.contextType as string) ?? 'none');
    if (contextTypeEarly === 'chat') {
      throw new BadRequestException('contextType=chat is not allowed on this upload route');
    }

    let pid: string;
    let name: unknown;
    let contextType: string;
    let recordId: unknown;
    let fileBytes: Buffer | undefined;

    // Step 1 — resolve WHAT is being uploaded and WHERE it is being attached. The
    // bytes are already fully buffered by `readMultipart` (20 MB cap), so nothing
    // is streamed anywhere yet.
    if (mp) {
      if (!mp.buffer) throw new BadRequestException('file is required');
      fileBytes = mp.buffer;
      pid = this.authoritativeProjectId(req, qpid, mp.field('projectId'));
      contextType = mp.field('contextType') ?? 'none';
      recordId = mp.field('recordId') ?? '';
      name = mp.field('name') ?? mp.filename ?? '';
    } else {
      pid = this.authoritativeProjectId(req, qpid, b.projectId);
      name = b.name;
      contextType = (b.contextType as string) ?? 'none';
      recordId = b.recordId ?? '';
      const objectKey = String(b.objectKey ?? '');
      const bucket = String(b.bucket ?? '');
      if (contextType !== 'none' && (!objectKey || !bucket)) {
        throw new BadRequestException('multipart file upload is required');
      }
    }

    // Step 2 — ASK THE DONOR FIRST (X3). `resolveContextOwner` is not just a
    // reporting lookup: it is the PEP for the source record and throws 403/404 for
    // a record the caller may not see. It used to run AFTER the file had been
    // written to S3, so a rejected upload still left up to 20 MB of unreferenced
    // client-supplied bytes in the private bucket (no document row ever points at
    // them, so nothing ever cleans them up). Deciding before writing removes the
    // orphan by construction — no compensating delete to get wrong.
    //
    // GAP-DOCS-190/B2: the value itself is a reporting snapshot of the SOURCE
    // record's owner; the uploader remains the document's `owner_id` (ABAC field)
    // in every context, including contextType='none' (FR-MDOC-17).
    const ctxOwner = await this.resolveContextOwner(
      req,
      pid,
      contextType,
      recordId ? String(recordId) : '',
    );

    // Step 3 — only now do the bytes land in the bucket. In the JSON/back-compat
    // branch there are no bytes: the pointer comes from the body and is held to
    // the configured bucket + project prefix (X4).
    const pointer =
      mp && fileBytes
        ? await this.docStorage.uploadRecordDocument({
            projectId: pid,
            contextType,
            recordId: recordId ? String(recordId) : undefined,
            fileName: mp.filename,
            contentType: mp.mimetype,
            buffer: fileBytes,
          })
        : this.trustedClientPointer(pid, b, 'application/octet-stream');

    const r = (await grpcBffCall(
      this.documents.uploadDocument(
        {
          project_id: pid,
          name,
          context_type: contextType,
          record_id: recordId ?? '',
          bucket: pointer.bucket,
          object_key: pointer.objectKey,
          mime_type: pointer.mimeType,
          size_bytes: pointer.sizeBytes,
          file_hash: pointer.fileHash,
          context_owner_id: ctxOwner.context_owner_id,
          context_owner_department_id: ctxOwner.context_owner_department_id,
        },
        this.meta(req, pid),
      ) as never,
      'write',
    )) as { group: Record<string, unknown>; version: Record<string, unknown> };
    return { group: documentGroupFe(r.group), version: documentVersionFe(r.version) };
  }

  @Get('documents/versions/:versionId/download')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async downloadVersion(
    @Req() req: GrpcReq,
    @Param('versionId') versionId: string,
    @Query('projectId') projectId: string,
    @Query('ttlSec') ttlSec?: string,
  ) {
    // Domain validates project membership + objectKey prefix BEFORE S3 (B-2) and
    // returns a short-lived presigned URL. Public/permanent URLs are never returned.
    const r = (await grpcBffCall(
      this.documents.getDownloadUrl(
        {
          project_id: projectId,
          version_id: versionId,
          ttl_sec: ttlSec ? parseInt(ttlSec, 10) : 0,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { url: string; expires_at: number };
    void appendPiiEgressAudit(
      this.audit as { appendEvent: (x: unknown, m?: unknown) => unknown } | undefined,
      this.outboundMeta,
      req,
      projectId,
      {
        channel: 'presigned_url',
        subject: 'documents',
        entityId: versionId,
      },
    );
    return { url: r.url, expiresAt: r.expires_at };
  }

  @Get('documents/:groupId/drift')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'read')
  async checkDrift(
    @Req() req: GrpcReq,
    @Param('groupId') groupId: string,
    @Query('projectId') projectId: string,
  ) {
    // GAP-DOCS-110/350: the domain's hash comparison (documents.service.checkDrift)
    // was dead code because the BFF sent neither `source_hash` nor `source_available`
    // — every check answered "no drift". Re-resolve the donor variables for the
    // group's context (same pattern as regenerateDocument) and hand over the real
    // current hash. Fail-soft: a donor fault reports `source_available: false`, which
    // the domain answers with an explicit "cannot tell" instead of a false negative.
    let sourceHash = '';
    let sourceAvailable = false;
    let currentValuesJson = '{}';
    try {
      const g = (await grpcBffCall(
        this.documents.getDocument(
          { project_id: projectId, group_id: groupId },
          this.meta(req, projectId),
        ) as never,
      )) as { group?: { context_type?: string; context_record_id?: string } };
      const contextType = String(g.group?.context_type ?? '');
      const recordId = String(g.group?.context_record_id ?? '');
      if (contextType && contextType !== 'none' && recordId) {
        const vars = await this.resolveDocumentVariables(req, projectId, contextType, recordId);
        sourceHash = vars.source_hash;
        sourceAvailable = sourceHash !== '';
        currentValuesJson = vars.values_json;
      } else if (contextType === '' || contextType === 'none') {
        // A document without a source record (an uploaded file, context_type 'none')
        // has nothing to drift FROM. Reporting `source_available: false` here made the
        // card show "источник недоступен" — indistinguishable from a donor outage.
        // `true` + an empty hash is the honest answer: compared, no drift. Uploaded
        // versions are stored with `sourceHash: ''` (documents.service.ts), so the
        // domain's hash comparison stays false for them.
        // A real context type with an empty record id stays `false` — that IS a
        // broken donor link, and "cannot tell" is the truthful verdict there.
        sourceAvailable = true;
      }
    } catch (e) {
      // The donor's PEP verdict still wins (GAP-DOCS-115/185); anything else stays soft.
      if (e instanceof ForbiddenException || e instanceof NotFoundException) throw e;
    }
    return driftStatusFe(
      (await grpcBffCall(
        this.documents.checkDrift(
          {
            project_id: projectId,
            group_id: groupId,
            source_hash: sourceHash,
            source_available: sourceAvailable,
            current_values_json: currentValuesJson,
          },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Delete('documents/:groupId')
  @ApiTags('Documents')
  @RequireModule('documents')
  @RequirePermission('documents', 'delete')
  async deleteDocument(
    @Req() req: GrpcReq,
    @Param('groupId') groupId: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.documents.deleteDocument(
        { project_id: projectId, group_id: groupId },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Get('reports')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'read')
  async listReports(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const r = (await grpcBffCall(
      this.reports.listReports(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(reportFe), total: r.total };
  }

  @Get('reports/:id')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'read')
  async getReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return reportFe(
      (await grpcBffCall(
        this.reports.getReport({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('reports')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'manage')
  async createReport(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    return reportFe(
      (await grpcBffCall(
        this.reports.createReport(
          {
            project_id: pid,
            name: body.name,
            description: body.description,
            kind: body.kind,
            spec_json: body.spec && typeof body.spec === 'object' ? JSON.stringify(body.spec) : '',
            // TODO-466: уровень доступа — отдельным полем, а не строкой описания.
            visibility: reportVisibilityToGrpc(body.visibility) ?? 'project',
          },
          this.meta(req, pid),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Patch('reports/:id')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'manage')
  async updateReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return reportFe(
      (await grpcBffCall(
        this.reports.updateReport(
          {
            project_id: projectId,
            id,
            name: body.name,
            description: body.description,
            spec_json: body.spec && typeof body.spec === 'object' ? JSON.stringify(body.spec) : '',
            // TODO-466: `undefined` → на проводе '' → домен не трогает уровень
            // доступа (PATCH без поля не должен «расшаривать» личный отчёт).
            visibility: reportVisibilityToGrpc(body.visibility),
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Delete('reports/:id')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'manage')
  async deleteReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const r = (await grpcBffCall(
      this.reports.deleteReport({ project_id: projectId, id }, this.meta(req, projectId)) as never,
      'write',
    )) as { id: string; deleted: boolean; deleted_at?: number };
    return { id: r.id, deleted: r.deleted, deletedAt: r.deleted_at };
  }

  @Post('reports/:id/run')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'read')
  async runReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const run = (await grpcBffCall(
      this.reports.runReport(
        {
          project_id: projectId,
          id,
          params_json:
            body.params && typeof body.params === 'object' ? JSON.stringify(body.params) : '{}',
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as Record<string, unknown>;
    // TODO-269 (FR-MREP-8 / FR-MREP-25): срезы «По менеджерам» и «Сравнение
    // отделов» приезжают из домена с сырыми id — display-имена подставляет
    // gateway (единственный, кто видит справочники auth/control). Fail-soft:
    // справочник недоступен → в отчёте останется id, цифры не теряются.
    return this.reportRunNames.enrichRunResult(req, run);
  }

  @Post('reports/:id/export')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'export')
  async exportReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return grpcBffCall(
      this.reports.exportReport(
        {
          project_id: projectId,
          id,
          format: body.format ?? 'csv',
          params_json:
            body.params && typeof body.params === 'object' ? JSON.stringify(body.params) : '{}',
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Post('reports/:id/drill')
  @ApiTags('Reports')
  @RequireModule('reports')
  @RequirePermission('reports', 'read')
  async drillReport(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const cell = (body.cell ?? {}) as Record<string, unknown>;
    const r = (await grpcBffCall(
      this.reports.drillReport(
        {
          project_id: projectId,
          id,
          params_json:
            body.params && typeof body.params === 'object' ? JSON.stringify(body.params) : '{}',
          dimension: String(cell.dimension ?? ''),
          value: String(cell.value ?? ''),
          limit: typeof body.limit === 'number' ? body.limit : 50,
          cursor: typeof body.cursor === 'string' ? body.cursor : '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { items_json?: string[]; next_cursor?: string; has_more?: boolean; total?: number };
    return {
      items: (r.items_json ?? []).map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return {};
        }
      }),
      nextCursor: r.next_cursor || null,
      hasMore: !!r.has_more,
      total: r.total ?? 0,
    };
  }

  @Get('automation/rules')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async listRules(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('enabledOnly') enabledOnly?: string,
    @Query('state') state?: string,
    @Query('triggerType') triggerType?: string,
    @Query('createdBy') createdBy?: string,
    @Query('engineVersion') engineVersion?: string,
  ) {
    const r = (await grpcBffCall(
      this.automation.listRules(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          query: query ?? '',
          enabled_only: enabledOnly === 'true',
          state: state ?? '',
          trigger_type: triggerType ?? '',
          created_by: createdBy ?? '',
          engine_version: parseInt(engineVersion ?? '0', 10) || 0,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(automationRuleFe), total: r.total };
  }

  @Get('automation/rules/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async getRule(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return automationRuleFe(
      (await grpcBffCall(
        this.automation.getRule(
          { project_id: projectId, rule_id: id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/rules')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'write')
  async createRule(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') qpid: string,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    const engineVersion = Number(body.engineVersion ?? 1) || 1;
    const enabledModules =
      ((req as unknown as Record<string, unknown>).__enabledModules as string[] | undefined) ?? [];
    return automationRuleFe(
      (await grpcBffCall(
        this.automation.createRule(
          {
            project_id: pid,
            name: body.name,
            description: body.description,
            enabled: body.enabled !== false,
            created_by: req.user?.userId ?? '',
            priority: body.priority != null ? Number(body.priority) : 100,
            notify_on_failure:
              body.notifyOnFailure != null
                ? String(body.notifyOnFailure)
                : (req.user?.userId ?? ''),
            trigger_type: body.triggerType,
            trigger_config_json:
              body.triggerConfig && typeof body.triggerConfig === 'object'
                ? JSON.stringify(body.triggerConfig)
                : '{}',
            conditions_json:
              body.conditions && typeof body.conditions === 'object'
                ? JSON.stringify(body.conditions)
                : '{}',
            actions_json:
              body.actions && typeof body.actions === 'object'
                ? JSON.stringify(body.actions)
                : '{}',
            // automation-v2: pass the engine discriminator + graph. The domain
            // validates the graph (reject-on-save) and denormalizes trigger fields.
            engine_version: engineVersion,
            ...(engineVersion === 2 ? { graph: automationGraphToGrpc(body.graph) } : {}),
            // automation:manage gate for external-effect nodes is enforced by the
            // domain PEP; forward the caller's manage capability for that check.
            can_manage: canManage(req),
            enabled_modules: enabledModules,
          },
          this.meta(req, pid),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Put('automation/rules/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'write')
  async updateRule(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const engineVersion = Number(body.engineVersion ?? 0) || 0;
    const enabledModules =
      ((req as unknown as Record<string, unknown>).__enabledModules as string[] | undefined) ?? [];
    const updatePayload: Record<string, unknown> = {
      project_id: projectId,
      rule_id: id,
      name: body.name,
      description: body.description,
      trigger_type: body.triggerType,
      trigger_config_json:
        body.triggerConfig && typeof body.triggerConfig === 'object'
          ? JSON.stringify(body.triggerConfig)
          : '{}',
      conditions_json:
        body.conditions && typeof body.conditions === 'object'
          ? JSON.stringify(body.conditions)
          : '{}',
      actions_json:
        body.actions && typeof body.actions === 'object' ? JSON.stringify(body.actions) : '{}',
      ...(engineVersion ? { engine_version: engineVersion } : {}),
      ...(engineVersion === 2 ? { graph: automationGraphToGrpc(body.graph) } : {}),
      can_manage: canManage(req),
      enabled_modules: enabledModules,
    };
    if (body.enabled !== undefined) updatePayload.enabled = body.enabled !== false;
    if (body.priority !== undefined) updatePayload.priority = Number(body.priority);
    if (body.notifyOnFailure !== undefined) {
      updatePayload.notify_on_failure =
        body.notifyOnFailure == null ? '' : String(body.notifyOnFailure);
    }
    return automationRuleFe(
      (await grpcBffCall(
        this.automation.updateRule(updatePayload, this.meta(req, projectId)) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Delete('automation/rules/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async deleteRule(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.automation.deleteRule(
        { project_id: projectId, rule_id: id },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Post('automation/rules/:id/execute')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'execute')
  async executeRule(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return grpcBffCall(
      this.automation.executeRule(
        {
          project_id: projectId,
          rule_id: id,
          source: body.source ?? 'manual',
          payload_json:
            body.payload && typeof body.payload === 'object' ? JSON.stringify(body.payload) : '{}',
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Post('automation/rules/:id/restore')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'delete')
  async restoreRule(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return automationRuleFe(
      (await grpcBffCall(
        this.automation.restoreRule(
          { project_id: projectId, rule_id: id },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Put('automation/rules/:id/enabled')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'write')
  async setRuleEnabled(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return automationRuleFe(
      (await grpcBffCall(
        this.automation.setRuleEnabled(
          {
            project_id: projectId,
            rule_id: id,
            enabled: body.enabled !== false,
            can_manage: canManage(req),
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/rules/:id/run')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'execute')
  async manualRun(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return automationExecutionFe(
      (await grpcBffCall(
        this.automation.manualRun(
          {
            project_id: projectId,
            rule_id: id,
            entity_type: String(body.entityType ?? ''),
            entity_id: String(body.entityId ?? ''),
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/rules/:id/dry-run')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'execute')
  async dryRun(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const r = (await grpcBffCall(
      this.automation.dryRun(
        {
          project_id: projectId,
          rule_id: id,
          sample_json:
            body.sample && typeof body.sample === 'object' ? JSON.stringify(body.sample) : '',
          last_n: body.lastN != null ? parseInt(String(body.lastN), 10) : 0,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { results?: Record<string, unknown>[] };
    return {
      results: (r.results ?? []).map((res) => ({
        eventName: res.event_name,
        matched: res.matched,
        conditionsPassed: res.conditions_passed,
        actions: ((res.actions as Record<string, unknown>[]) ?? []).map((a) => ({
          type: a.type,
          wouldRun: a.would_run,
          reason: a.reason || undefined,
        })),
        dryRun: res.dry_run,
      })),
    };
  }

  @Get('automation/rules/:id/executions')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async listRuleExecutions(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const r = (await grpcBffCall(
      this.automation.listExecutions(
        {
          project_id: projectId,
          rule_id: id,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          status: status ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(automationExecutionFe), total: r.total };
  }

  @Get('automation/executions')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async listProjectExecutions(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('actionType') actionType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('ruleId') ruleId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
  ) {
    const r = (await grpcBffCall(
      this.automation.listProjectExecutions(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          status: status ?? '',
          action_type: actionType ?? '',
          from: from ? parseInt(from, 10) : 0,
          to: to ? parseInt(to, 10) : 0,
          rule_id: ruleId ?? '',
          entity_type: entityType ?? '',
          entity_id: entityId ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(automationExecutionFe), total: r.total };
  }

  @Get('automation/registry')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async getRegistry(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    // x-enabled-modules is resolved by ProjectAccessGuard (server-trusted), not
    // taken from the client — pass the effective set to the domain filter.
    const enabledModules =
      ((req as unknown as Record<string, unknown>).__enabledModules as string[] | undefined) ?? [];
    const r = (await grpcBffCall(
      this.automation.getRegistry(
        { project_id: projectId, enabled_modules: enabledModules },
        this.meta(req, projectId),
      ) as never,
    )) as { triggers?: Record<string, unknown>[]; actions?: Record<string, unknown>[] };
    return {
      triggers: (r.triggers ?? []).map((t) => ({
        id: t.id,
        requiredModule: t.required_module,
        entityType: t.entity_type,
        eventName: t.event_name,
        configSchema: parseMaybeJson(t.config_schema_json) ?? {},
        outputSchema: parseMaybeJson(t.output_schema_json) ?? {},
      })),
      actions: (r.actions ?? []).map((a) => ({
        id: a.id,
        requiredModule: a.required_module,
        externalEffect: a.external_effect,
        configSchema: parseMaybeJson(a.config_schema_json) ?? {},
      })),
    };
  }

  // ── automation-v2 (contract §5) ─────────────────────────────────────────
  @Post('automation/rules/validate-graph')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'write')
  async validateGraph(
    @Req() req: GrpcReq,
    @Query('projectId') qpid: string,
    @Body() body: Record<string, unknown>,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    const enabledModules =
      ((req as unknown as Record<string, unknown>).__enabledModules as string[] | undefined) ?? [];
    const r = (await grpcBffCall(
      this.automation.validateGraph(
        {
          project_id: pid,
          graph: automationGraphToGrpc(body.graph),
          // The external-effect node check needs the caller's manage capability.
          can_manage: canManage(req),
          enabled_modules: enabledModules,
        },
        this.meta(req, pid),
      ) as never,
    )) as { valid?: boolean; issues?: Record<string, unknown>[] };
    return {
      valid: !!r.valid,
      issues: (r.issues ?? []).map(automationGraphIssueFe),
    };
  }

  @Get('automation/node-registry')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'read')
  async getNodeRegistry(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    // x-enabled-modules is server-trusted (ProjectAccessGuard), never from client.
    const enabledModules =
      ((req as unknown as Record<string, unknown>).__enabledModules as string[] | undefined) ?? [];
    const r = (await grpcBffCall(
      this.automation.getNodeRegistry(
        { project_id: projectId, enabled_modules: enabledModules },
        this.meta(req, projectId),
      ) as never,
    )) as {
      triggers?: Record<string, unknown>[];
      actions?: Record<string, unknown>[];
      structural?: Record<string, unknown>[];
    };
    const structural = (r.structural ?? []).map(automationNodeTypeFe);
    return {
      triggers: (r.triggers ?? []).map(automationNodeTypeFe),
      actions: (r.actions ?? []).map(automationNodeTypeFe),
      structural,
      conditions: structural.filter((n) => n.type === 'condition'),
      branches: structural.filter((n) => n.type === 'branch'),
    };
  }

  @Get('automation/connections')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async listConnections(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const r = (await grpcBffCall(
      this.automation.listConnections(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number };
    return { list: r.list.map(automationConnectionFe), total: r.total };
  }

  @Get('automation/connections/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async getConnection(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return automationConnectionFe(
      (await grpcBffCall(
        this.automation.getConnection(
          { project_id: projectId, connection_id: id },
          this.meta(req, projectId),
        ) as never,
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/connections')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async createConnection(
    @Req() req: GrpcReq,
    @Query('projectId') qpid: string,
    @Body() body: Record<string, unknown>,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    return automationConnectionFe(
      (await grpcBffCall(
        this.automation.createConnection(
          {
            project_id: pid,
            name: String(body.name ?? ''),
            url: String(body.url ?? ''),
            secret: String(body.secret ?? ''),
            headers_json:
              body.headers && typeof body.headers === 'object'
                ? JSON.stringify(body.headers)
                : '{}',
            enabled: body.enabled !== false,
            created_by: req.user?.userId ?? '',
          },
          this.meta(req, pid),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Put('automation/connections/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async updateConnection(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data: Record<string, unknown> = {
      project_id: projectId,
      connection_id: id,
      reset_breaker: body.resetBreaker === true,
    };
    if (body.name != null) data.name = String(body.name);
    if (body.url != null) data.url = String(body.url);
    if (body.secret != null) data.secret = String(body.secret);
    if (body.headers != null && typeof body.headers === 'object')
      data.headers_json = JSON.stringify(body.headers);
    if (body.enabled != null) data.enabled = Boolean(body.enabled);
    return automationConnectionFe(
      (await grpcBffCall(
        this.automation.updateConnection(data, this.meta(req, projectId)) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Delete('automation/connections/:id')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async deleteConnection(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return grpcBffCall(
      this.automation.deleteConnection(
        { project_id: projectId, connection_id: id },
        this.meta(req, projectId),
      ) as never,
      'write',
    );
  }

  @Get('automation/dlq')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async listDlq(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const r = (await grpcBffCall(
      this.automation.listDlq(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parsePageSize(pageSize),
          status: status ?? '',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { list: Record<string, unknown>[]; total: number; counts?: Record<string, number> };
    return { list: r.list.map(automationDlqFe), total: r.total, counts: r.counts ?? {} };
  }

  @Post('automation/dlq/:id/retry')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async retryDlq(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    return automationDlqFe(
      (await grpcBffCall(
        this.automation.retryDlq(
          { project_id: projectId, dlq_id: id },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/dlq/:id/dismiss')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation', 'manage')
  async dismissDlq(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return automationDlqFe(
      (await grpcBffCall(
        this.automation.dismissDlq(
          { project_id: projectId, dlq_id: id, reason: String(body.reason ?? '') },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('automation/integration/trigger')
  @ApiTags('Automation')
  @RequireModule('automation')
  @RequirePermission('automation.integration', 'invoke')
  async hookEvent(
    @Req() req: GrpcReq,
    @Query('projectId') qpid: string,
    @Body() body: Record<string, unknown>,
  ) {
    // SEC-ISO-1 (TODO-001): the effective projectId is the one the guards enforced
    // on (query/header) — a body-supplied projectId must never win (cross-project
    // write IDOR: authorize in A, write into B).
    const pid = this.authoritativeProjectId(req, qpid, body.projectId);
    const r = (await grpcBffCall(
      this.automation.hookEvent(
        {
          project_id: pid,
          event_name: String(body.eventName ?? ''),
          source: String(body.source ?? 'event_hook'),
          payload_json:
            body.payload && typeof body.payload === 'object' ? JSON.stringify(body.payload) : '{}',
        },
        this.meta(req, pid),
      ) as never,
      'write',
    )) as { accepted?: boolean; matched_rules?: number; executions?: Record<string, unknown>[] };
    return {
      accepted: r.accepted ?? false,
      matchedRules: r.matched_rules ?? 0,
      executions: (r.executions ?? []).map(automationExecutionFe),
    };
  }

  @Post('contacts/import')
  @ApiTags('Contacts')
  @RequireModule('contacts')
  @RequirePermission('contacts', 'import')
  async importContacts(@Req() req: GrpcReq, @Query('projectId') projectId: string) {
    const contact = this.contactClient.getService('ContactGrpc') as Record<
      string,
      (x: unknown, m?: unknown) => unknown
    >;
    // FR-CONTACTS-360: мастер импорта шлёт три части — file + filename + mapping.
    // Раньше здесь читался только `req.file()`, поэтому карта колонок и имя файла
    // до домена не доезжали вовсе: экран разметки колонок был чисто декоративным,
    // а парсер домена разбирал CSV по фиксированным позициям.
    const mp = await this.readMultipart(req);
    const buf = mp?.buffer ?? Buffer.alloc(0);
    if (buf.length === 0) throw new BadRequestException('файл импорта не передан');
    // Тот же allowlist-нормализатор, что у импорта компаний: карта приходит от
    // фронта в ориентации «поле → индекс», домен ждёт «индекс → поле», а мапить
    // ownerId/createdBy/departmentId из файла нельзя (подделка атрибуции и ABAC).
    const mappingJson = normalizeImportMapping(
      mp?.field('mapping') ?? mp?.field('mappingJson') ?? '',
      IMPORT_MAPPABLE_CONTACT_FIELDS,
    );
    const filename = mp?.filename || (mp?.field('filename') ?? '');
    const r = (await grpcBffCall(
      contact.importContacts(
        {
          project_id: projectId,
          file_content: buf,
          filename,
          mapping_json: mappingJson,
        },
        this.meta(req, projectId),
      ) as never,
    )) as {
      created?: number;
      updated?: number;
      skipped?: number;
      errors?: string[];
      skipped_rows?: Record<string, unknown>[];
    };
    // Мастер импорта читает «Пропущенные строки» как массив объектов в camelCase.
    // Пока домен не заполнил skipped_rows — отдаём числовой счётчик (фронт умеет
    // оба варианта); подменять его пустым массивом нельзя, иначе «Пропущено» врёт 0.
    const skippedRows = Array.isArray(r.skipped_rows) ? r.skipped_rows : [];
    return {
      created: Number(r.created ?? 0),
      updated: Number(r.updated ?? 0),
      skipped:
        skippedRows.length > 0
          ? skippedRows.map((s) => ({
              row: Number(s.row ?? 0),
              reason: String(s.reason ?? ''),
              matchedContactId: String(s.matched_contact_id ?? ''),
              matchedField: String(s.matched_field ?? ''),
            }))
          : Number(r.skipped ?? 0),
      errors: Array.isArray(r.errors) ? r.errors : [],
    };
  }

  // NOTE: `POST companies/import` is owned by V1DataBffController (canonical:
  // permission `companies.import:execute`, mapping_json/dedup_mode per company.md
  // §3.17). The legacy duplicate that used to live here was removed — it collided
  // on the same Fastify route and crashed gateway bootstrap (FST_ERR_DUPLICATED_ROUTE).
}
