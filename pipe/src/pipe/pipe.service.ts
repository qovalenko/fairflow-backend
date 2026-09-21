import { Injectable } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  getProjectTemplate,
  DEFAULT_DEAL_SOURCES,
  buildVisibilityFilter,
  buildDocumentVariablesResponse,
  computeHiddenByPolicy,
  isRecordVisible,
  evalGate,
  type AbacNode,
  type AccessPredicate,
  type DocumentVariablesResult,
  type EmitIntent,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import type { DealStageLogEntry, PipelineStageDoc } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { ProjectMembersService } from './project-members.service';
import { normalizeAutoTransitions, validateAutoTransitions } from './stage-auto-transitions';

const OWNER_FIELD = 'assigneeId';
/** NFR-DEALS-060 / FR-MDEAL-33: synchronous bulk cap. */
const BULK_SYNC_LIMIT = 200;

/**
 * int64 с провода → обычное JS-число.
 *
 * proto-loader БЕЗ `longs: Number` отдаёт int64 объектом `Long {low,high,unsigned}`,
 * а TypeScript видит объявленный в интерфейсе `number` и молчит. Такой объект,
 * записанный в Mongo как есть, ломает и обратное чтение (`Number(obj)` = NaN →
 * protobuf кодирует 0 → дата затирается), и диапазонные запросы (`$gte: NaN`
 * не матчит ничего). Loader'ы теперь ставят `longs: Number` (см. pipe/src/main.ts),
 * но каждое int64-поле, попадающее в БД или в фильтр, всё равно проходит через
 * этот хелпер — грабля keepCase/longs выстреливала в проекте уже четырежды.
 */
export function int64ToNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return Number(v) || 0;
  const l = v as { low?: unknown; high?: unknown };
  if (typeof l.low === 'number' && typeof l.high === 'number') {
    return l.high * 0x1_0000_0000 + (l.low >>> 0);
  }
  return 0;
}

/**
 * Required document variables the deal context always ships (documents §3.9).
 * Blank → `warnings.emptyRequired` on generate.
 */
export const DEAL_REQUIRED_VARIABLES = ['deal.name'];

/**
 * Map a deal (toDeal proto shape) to the flat document-variable map (documents
 * contract §4). The deal owns its links, so it folds the denormalized
 * contact/company requisites (snapshot or light fields) into its own map — no
 * cross-domain call. Pure/no-IO → unit-testable.
 */
export function buildDealDocumentVariables(deal: Record<string, unknown>): DocumentVariablesResult {
  const contactSnap = (deal.contact_snapshot as Record<string, unknown>) ?? {};
  const companySnap = (deal.company_snapshot as Record<string, unknown>) ?? {};
  const contactName =
    String(deal.contact_name ?? '') ||
    String(contactSnap.name ?? '') ||
    String(deal.light_name ?? '');
  const companyName =
    String(deal.company_name ?? '') ||
    String(companySnap.name ?? '') ||
    String(deal.light_company_name ?? '');
  return buildDocumentVariablesResponse(
    {
      'deal.name': String(deal.name ?? ''),
      'deal.amount': String(deal.amount ?? 0),
      'deal.currency': String(deal.currency ?? ''),
      'deal.stage': String(deal.stage_name ?? ''),
      'deal.status': String(deal.status ?? ''),
      'deal.probability': String(deal.probability ?? 0),
      'deal.source': String(deal.source ?? ''),
      'contact.name': contactName,
      'contact.phone': String(contactSnap.phone ?? deal.light_phone ?? ''),
      'contact.email': String(contactSnap.email ?? deal.light_email ?? ''),
      'company.name': companyName,
    },
    DEAL_REQUIRED_VARIABLES,
  );
}

/** Escape regex metacharacters so user input is matched literally (#22, ReDoS-safe). */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DAY_MS = 86_400_000;

export type DealListFilters = {
  assigneeId?: string;
  departmentId?: string;
  status?: string;
  contactId?: string;
  companyId?: string;
  source?: string;
  amountMin?: number;
  amountMax?: number;
  includeDeleted?: boolean;
  /** FR-DEALS-080 / FR-SEARCH-390: сделки на стадии дольше N дней. */
  stageDaysMin?: number;
  minDaysOnStage?: number;
  /** FR-SEARCH-390/410: без назначенного ответственного. */
  withoutAssignee?: boolean;
};

/** FR-DEALS-180: timing derivatives computed on read from stageEnteredAt + stageLog. */
export function computeDerivedDealFields(
  doc: Record<string, unknown>,
  rottingDays = 0,
): {
  days_on_stage: number;
  is_stalled: boolean;
  stage_return_count: number;
  total_time_on_stage_days: number;
} {
  const now = Date.now();
  const stageEnteredAt = Number(doc.stageEnteredAt ?? doc.createdAt ?? 0);
  const daysOnStage =
    stageEnteredAt > 0 ? Math.max(0, Math.floor((now - stageEnteredAt) / DAY_MS)) : 0;
  const stageId = String(doc.stageId ?? '');
  const log =
    (doc.stageLog as Array<{ stageId?: string; enteredAt?: number; exitedAt?: number }>) ?? [];
  let visits = 0;
  let totalMs = 0;
  for (const entry of log) {
    if (String(entry.stageId ?? '') !== stageId) continue;
    const entered = Number(entry.enteredAt ?? 0);
    const exited = Number(entry.exitedAt ?? 0);
    // Count only completed visits. The current open stay is always in stageLog
    // without exitedAt — adding it here plus stageEnteredAt double-counted
    // returns on every first-visit deal.
    if (entered > 0 && exited >= entered) {
      visits += 1;
      totalMs += exited - entered;
    }
  }
  if (stageEnteredAt > 0) {
    totalMs += now - stageEnteredAt;
    visits += 1;
  }
  const rotting = rottingDays > 0 ? rottingDays : 0;
  return {
    days_on_stage: daysOnStage,
    is_stalled: rotting > 0 && daysOnStage > rotting,
    stage_return_count: Math.max(0, visits - 1),
    total_time_on_stage_days: Math.max(0, Math.floor(totalMs / DAY_MS)),
  };
}

/**
 * Читает запись `driftDetail` по имени поля дрейфа.
 *
 * Консьюмер дрейфа пишет деталь ТОЧЕЧНЫМ путём (`$set: {'driftDetail.company.name': …}`),
 * а Mongo такой путь всегда разворачивает во ВЛОЖЕННЫЙ документ:
 * `driftDetail: { company: { name: {…} } }`. Литерального ключа `'company.name'`
 * в базе не появляется никогда — поэтому прямое чтение `detail['company.name']`
 * молча отдавало `undefined` (TODO-178: приём дрейфа не материализовал
 * `companySnapshot.name`, а `GET /deals/:id/drift` отдавал пустой `current_value`).
 *
 * Идём по сегментам пути; литеральный ключ проверяем первым — на случай старых
 * документов, куда деталь могла попасть целым объектом `driftDetail`.
 */
function driftDetailEntry(
  detail: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const literal = detail[field];
  if (literal != null && typeof literal === 'object') return literal as Record<string, unknown>;
  let cur: unknown = detail;
  for (const seg of field.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}

/** Closed deals are read-only except for non-funnel fields. */
const FUNNEL_FIELDS = new Set([
  'amount',
  'contact_id',
  'company_id',
  'pipeline_id',
  'stage_id',
  'product_id',
]);

@Injectable()
export class PipeService {
  /** Max cards materialised per kanban column (perf #13 — DB-side $limit). */
  private static readonly KANBAN_COLUMN_LIMIT = 50;

  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    private readonly projectMembers: ProjectMembersService,
  ) {}

  /**
   * Cross-domain read-only count of non-deleted deals linked to a product
   * (product.md §3.10, product delete-guard / counter reconciliation). The
   * `{projectId}` scope is the unbreakable isolation boundary — a foreign
   * projectId can never count another tenant's deals (S7). `active_count` is
   * the subset still open (not won/lost).
   */
  async countDealsByProduct(
    projectId: string,
    productId: string,
  ): Promise<{ count: number; active_count: number }> {
    if (!projectId || !productId) return { count: 0, active_count: 0 };
    const base: Record<string, unknown> = {
      projectId,
      productId,
      deletedAt: { $in: [null, undefined] },
    };
    const count = await this.mongo.deals().countDocuments(base);
    const active_count = await this.mongo.deals().countDocuments({ ...base, status: 'open' });
    return { count, active_count };
  }

  /**
   * Инстанцирует воронку/этапы/источники сделок проекта по шаблону (спека §6.2).
   * Идемпотентно: если у проекта уже есть воронки — ничего не делает.
   * Вызывается из control при создании проекта; обычный доступ к домену
   * по-прежнему страхует ленивый `ensureProject` (дефолтная воронка).
   */
  async provisionDefaults(projectId: string, templateId?: string) {
    if (!projectId) return { created: false, pipeline_id: '' };
    const existing = await this.mongo.pipelines().findOne({ projectId });
    if (existing) return { created: false, pipeline_id: String(existing.id) };

    const template = getProjectTemplate(templateId);
    const pipelineId = new ObjectId().toString();
    await this.mongo.pipelines().insertOne({
      _id: new ObjectId(),
      id: pipelineId,
      projectId,
      name: template.pipeline.name,
      isDefault: true,
      stages: template.pipeline.stages.map((s, order) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        order,
        kind: s.kind,
      })),
    });
    if (template.dealSources.length > 0) {
      await this.mongo.dealSources().insertMany(
        template.dealSources.map((src) => ({
          _id: new ObjectId(),
          id: src.id,
          projectId,
          name: src.name,
          color: src.color,
        })),
      );
    }
    return { created: true, pipeline_id: pipelineId };
  }

  /** Record ids shared with the viewer (resolved upstream), as ObjectIds. */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  /** Viewer org-unit ids for department-owned deal visibility (FR-DEALS-315). */
  private viewerUnitIds(scope?: VisibilityScope): string[] {
    const stamped = (scope as { viewerUnitIds?: string[] } | undefined)?.viewerUnitIds;
    return stamped ?? scope?.descriptor?.unitIds ?? [];
  }

  /**
   * Deals visibility: assignee ∈ ownerIds OR departmentId ∈ viewer units OR shared.
   */
  private buildDealsVisibilityFilter(
    scope?: VisibilityScope,
    sharedIds: ObjectId[] = [],
  ): Record<string, unknown> | null {
    const base = buildVisibilityFilter<ObjectId>(scope, OWNER_FIELD, sharedIds);
    if (!scope || scope.mode === 'all') return base;
    if (base && '$nor' in base) return base;
    const units = this.viewerUnitIds(scope);
    if (!units.length) return base;
    const deptBranch = { departmentId: { $in: units } };
    if (!base) return deptBranch;
    return { $or: [base, deptBranch] };
  }

  private isDealRecordVisible(
    deal: { assigneeId?: string; departmentId?: string },
    scope?: VisibilityScope,
    isShared = false,
  ): boolean {
    if (isRecordVisible(scope, deal.assigneeId, isShared)) return true;
    const dept = String(deal.departmentId ?? '');
    if (!dept) return false;
    return this.viewerUnitIds(scope).includes(dept);
  }

  /**
   * A malformed `x-access-predicate` is a broken deny-rule → the whole read must be
   * denied, never silently widened (RFC-ABAC §4 fail-closed). DENY_ALL_ID never
   * matches a real ObjectId, so ANDing it turns any read/aggregate $match into
   * "matches nothing" (empty list / NOT_FOUND) without leaking existence.
   */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Push the three-state ABAC predicate onto a list/aggregate `$and` array (product
   * reference, RFC-5 §1.4 / RFC-ABAC §4). The array already carries `{ projectId }`
   * so a deny stays project-scoped:
   *  - absent (`present:false`)     → no ABAC narrowing;
   *  - malformed (`malformed:true`) → fail-closed: force match-nothing;
   *  - present with `.mongo`        → AND the compiled fragment in.
   */
  private applyAccess(and: Record<string, unknown>[], access?: AccessPredicate): void {
    if (access?.present && access.malformed) {
      and.push({ _id: PipeService.DENY_ALL_ID });
      return;
    }
    if (access?.present && !access.malformed && access.mongo && Object.keys(access.mongo).length) {
      and.push(access.mongo);
    }
  }

  /**
   * Single-record ABAC gate for get-by-id (`evalGate` side of the contract-equivalent
   * pair, RFC-ABAC §4). Returns `true` iff the record passes: absent → pass; malformed
   * → fail-closed deny; present with `.ir` → `evalGate(ir, record)`; a present predicate
   * carrying only `.mongo` (no `.ir`) passes here — the mongo fragment applies on the
   * read-filter path instead.
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

  async ensureProject(projectId: string) {
    const n = await this.mongo.pipelines().countDocuments({ projectId });
    if (n > 0) return;
    const pid = new ObjectId().toString();
    await this.mongo.pipelines().insertOne({
      _id: new ObjectId(),
      id: pid,
      projectId,
      name: 'Продажи',
      isDefault: true,
      stages: [
        { id: 'st1', name: 'Новые', color: '#3b82f6', order: 0, kind: 'active' },
        { id: 'st2', name: 'В работе', color: '#eab308', order: 1, kind: 'active' },
        { id: 'st3', name: 'Успех', color: '#22c55e', order: 2, kind: 'won' },
        { id: 'st4', name: 'Провал', color: '#ef4444', order: 3, kind: 'lost' },
      ],
    });
    await this.mongo.dealSources().insertMany(
      DEFAULT_DEAL_SOURCES.map((src) => ({
        _id: new ObjectId(),
        id: src.id,
        projectId,
        name: src.name,
        color: src.color,
      })),
    );
    const pl = await this.mongo.pipelines().findOne({ projectId, isDefault: true });
    const st = pl?.stages?.[0];
    if (st) {
      await this.mongo.deals().insertOne({
        _id: new ObjectId(),
        projectId,
        pipelineId: pid,
        stageId: st.id,
        name: 'Демо-сделка',
        amount: 100000,
        currency: 'RUB',
        assigneeId: '',
        contactId: '',
        companyId: '',
        source: 'Сайт',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        stageEnteredAt: Date.now(),
      });
    }
  }

  private toPipeline(doc: Record<string, unknown>) {
    return {
      id: String(doc.id ?? doc._id),
      project_id: String(doc.projectId),
      name: String(doc.name),
      is_default: !!doc.isDefault,
      stages: (
        doc.stages as {
          id: string;
          name: string;
          color: string;
          order: number;
          kind?: string;
          probability?: number;
          rottingDays?: number;
        }[]
      ).map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        order: s.order,
        kind: s.kind ?? 'active',
        probability: Number(s.probability ?? 0),
        rotting_days: Number(s.rottingDays ?? 0),
      })),
      auto_transitions: normalizeAutoTransitions(doc.autoTransitions).map((t) => ({
        from_stage_id: t.fromStageId,
        to_stage_id: t.toStageId,
      })),
    };
  }

  private snapshotOut(s?: Record<string, unknown>) {
    if (!s) return undefined;
    return {
      name: String(s.name ?? ''),
      phone: String(s.phone ?? ''),
      email: String(s.email ?? ''),
      linked_at: Number(s.linkedAt ?? 0),
      linked_by: String(s.linkedBy ?? ''),
    };
  }

  private companySnapshotOut(s?: Record<string, unknown>) {
    if (!s) return undefined;
    return {
      name: String(s.name ?? ''),
      inn: String(s.inn ?? ''),
      linked_at: Number(s.linkedAt ?? 0),
      linked_by: String(s.linkedBy ?? ''),
    };
  }

  /**
   * FR-DEALS-345: assign to another user requires manager+ visibility (`mode='all'`)
   * or the target must be inside the actor's managed ownerIds (incl. self).
   */
  private assertAssigneeInScope(
    assigneeId: string | undefined,
    scope: VisibilityScope | undefined,
    selfId?: string,
  ): void {
    const assignee = String(assigneeId ?? '').trim();
    if (!assignee) return;
    if (selfId && assignee === selfId) return;
    if (scope?.mode === 'all') return;
    const allowed = new Set<string>([...(scope?.ownerIds ?? []), ...(selfId ? [selfId] : [])]);
    if (!allowed.has(assignee)) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: JSON.stringify({ code: 'ASSIGNEE_OUT_OF_SCOPE', assigneeId: assignee }),
      });
    }
  }

  private applyDealListFilters(
    base: Record<string, unknown>,
    query?: string,
    pipelineId?: string,
    stageId?: string,
    filters?: DealListFilters,
    opts?: { omitStageDays?: boolean },
  ): void {
    if (pipelineId) base.pipelineId = pipelineId;
    if (stageId) base.stageId = stageId;
    const q = query?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      base.$or = [
        { name: rx },
        { lightName: rx },
        { lightPhone: rx },
        { lightEmail: rx },
        { lightCompanyName: rx },
      ];
    }
    if (filters?.assigneeId) base.assigneeId = filters.assigneeId;
    if (filters?.departmentId) base.departmentId = filters.departmentId;
    if (filters?.status) base.status = filters.status;
    if (filters?.contactId) base.contactId = filters.contactId;
    if (filters?.companyId) base.companyId = filters.companyId;
    if (filters?.source) base.source = filters.source;
    if (filters?.amountMin != null || filters?.amountMax != null) {
      const range: Record<string, number> = {};
      if (filters.amountMin != null) range.$gte = filters.amountMin;
      if (filters.amountMax != null) range.$lte = filters.amountMax;
      base.amount = range;
    }
    if (!opts?.omitStageDays) {
      const stageDaysMin = Number(filters?.stageDaysMin ?? filters?.minDaysOnStage ?? 0);
      if (Number.isFinite(stageDaysMin) && stageDaysMin > 0) {
        base.stageEnteredAt = { $lte: Date.now() - stageDaysMin * DAY_MS };
      }
    }
  }

  private toDeal(
    doc: Record<string, unknown>,
    stageName?: string,
    stageMeta?: { rottingDays?: number },
  ) {
    return {
      id: (doc._id as ObjectId).toString(),
      name: String(doc.name),
      amount: Number(doc.amount ?? 0),
      currency: String(doc.currency ?? 'RUB'),
      pipeline_id: String(doc.pipelineId),
      stage_id: String(doc.stageId),
      stage_name: stageName ?? String(doc.stageId),
      contact_id: String(doc.contactId ?? ''),
      contact_name: String(doc.contactName ?? ''),
      company_id: String(doc.companyId ?? ''),
      company_name: String(doc.companyName ?? ''),
      product_id: String(doc.productId ?? ''),
      product_name: String(doc.productName ?? ''),
      source: String(doc.source ?? ''),
      assignee_id: String(doc.assigneeId ?? ''),
      assignee_name: String(doc.assigneeName ?? ''),
      // int64ToNumber, а не Number(): в БД уже лежат сделки, которым прежний
      // updateDeal записал СЫРОЙ Long ({low,high,unsigned} как поддокумент BSON).
      // `Number(поддокумент)` = NaN, protobuf кодирует NaN как 0 — дата пропадала
      // бы и после починки записи. Так уже сохранённые даты читаются обратно.
      expected_close_date: int64ToNumber(doc.expectedCloseDate),
      closed_at: Number(doc.closedAt ?? 0),
      result: String(doc.result ?? ''),
      lost_reason: String(doc.lostReason ?? ''),
      stage_entered_at: Number(doc.stageEnteredAt ?? doc.createdAt),
      created_at: Number(doc.createdAt),
      updated_at: Number(doc.updatedAt),
      status: String(doc.status ?? 'open'),
      won_at: Number(doc.wonAt ?? 0),
      lost_at: Number(doc.lostAt ?? 0),
      department_id: String(doc.departmentId ?? ''),
      light_name: String(doc.lightName ?? ''),
      light_phone: String(doc.lightPhone ?? ''),
      light_email: String(doc.lightEmail ?? ''),
      light_company_name: String(doc.lightCompanyName ?? ''),
      contact_snapshot: this.snapshotOut(doc.contactSnapshot as Record<string, unknown>),
      company_snapshot: this.companySnapshotOut(doc.companySnapshot as Record<string, unknown>),
      drift_flag: !!doc.driftFlag,
      drift_fields: (doc.driftFields as string[]) ?? [],
      probability: Number(doc.probability ?? 0),
      tags: (doc.tags as string[]) ?? [],
      lost_reason_id: String(doc.lostReasonId ?? ''),
      lost_reason_comment: String(doc.lostReasonComment ?? ''),
      deleted_at: Number(doc.deletedAt ?? 0),
      deleted_by: String(doc.deletedBy ?? ''),
      // `notes` lives in Mongo (demo-seed writes it) and the FE renders it, but it
      // was absent from the Deal message — the read side dropped it silently.
      notes: String(doc.notes ?? ''),
      ...computeDerivedDealFields(doc, stageMeta?.rottingDays ?? 0),
    };
  }

  /**
   * TODO-383 / FR-DEALS-190: how many stage-log entries stay embedded on the deal
   * document (the canon's limit is 200). The array used to grow with every single
   * move (no `$slice` anywhere), so a long-lived deal walked towards the 16 MB BSON
   * ceiling and every read dragged the whole trail along. Older entries are evicted
   * into `crm_deal_stage_history`.
   */
  private static readonly STAGE_LOG_LIMIT = 200;

  /**
   * TODO-383: persist the stage-log entries that the `$slice` window is about to
   * drop. Runs in the CALLER'S session, so the eviction and the move that causes
   * it commit together — the trail is never lost, only relocated.
   * `incoming` = how many entries the upcoming write appends.
   */
  private async evictStageLogOverflow(
    projectId: string,
    dealId: string,
    incoming: number,
    session?: ClientSession,
  ): Promise<void> {
    const raw = await this.mongo
      .deals()
      .findOne(
        { _id: new ObjectId(dealId), projectId },
        { projection: { stageLog: 1, pipelineId: 1 }, ...(session ? { session } : {}) },
      );
    const rows = this.stageLogOverflowRows(
      projectId,
      dealId,
      String(raw?.pipelineId ?? ''),
      (raw?.stageLog as DealStageLogEntry[] | undefined) ?? [],
      incoming,
    );
    if (rows.length === 0) return;
    await this.mongo.dealStageHistory().insertMany(rows, session ? { session } : {});
  }

  /**
   * TODO-383: the `crm_deal_stage_history` rows for the entries an upcoming
   * bounded push/slice will drop (same shape the demo seed writes). Pure — the
   * bulk path already holds the documents and must not re-read them per deal.
   */
  private stageLogOverflowRows(
    projectId: string,
    dealId: string,
    pipelineId: string,
    log: DealStageLogEntry[],
    incoming: number,
  ): Record<string, unknown>[] {
    const overflow = log.length + incoming - PipeService.STAGE_LOG_LIMIT;
    if (overflow <= 0) return [];
    return log.slice(0, overflow).map((e, i) => ({
      _id: new ObjectId(),
      projectId,
      dealId,
      pipelineId,
      fromStageId: i === 0 ? '' : String(log[i - 1]?.stageId ?? ''),
      toStageId: String(e.stageId ?? ''),
      enteredAt: Number(e.enteredAt ?? 0),
      exitedAt: Number(e.exitedAt ?? 0),
      movedBy: String(e.movedBy ?? ''),
      kind: String(e.kind ?? 'move'),
      createdAt: Number(e.enteredAt ?? 0),
    }));
  }

  /** Resolve a deal's pipeline and validate a target stage belongs to it. */
  private isDebouncedStageReturn(
    stageLog: DealStageLogEntry[],
    fromStageId: string,
    toStageId: string,
    now: number,
    debounceMs: number,
  ): boolean {
    if (debounceMs <= 0 || stageLog.length < 2) return false;
    const prev = stageLog[stageLog.length - 2];
    const curr = stageLog[stageLog.length - 1];
    if (prev?.stageId !== toStageId || curr?.stageId !== fromStageId) return false;
    const enteredIntermediate = Number(curr.enteredAt ?? 0);
    return enteredIntermediate > 0 && now - enteredIntermediate < debounceMs;
  }

  private async resolveStage(projectId: string, pipelineId: string, stageId: string) {
    const pl = await this.mongo.pipelines().findOne({ projectId, id: pipelineId });
    const stages = (pl?.stages as PipelineStageDoc[]) ?? [];
    const stage = stages.find((s) => s.id === stageId);
    return { pipeline: pl, stage };
  }

  async listPipelines(projectId: string) {
    // Read path: never triggers a write (auto-provision is explicit — S2/#2).
    const rows = await this.mongo.pipelines().find({ projectId }).toArray();
    return { list: rows.map((d) => this.toPipeline(d as Record<string, unknown>)) };
  }

  async listDealSources(projectId: string) {
    const rows = await this.mongo.dealSources().find({ projectId }).toArray();
    return {
      list: rows.map((d) => ({
        id: String((d as { id?: string }).id ?? (d._id as ObjectId).toString()),
        name: String((d as unknown as { name: string }).name),
        color: String((d as unknown as { color: string }).color),
      })),
    };
  }

  async listDeals(
    projectId: string,
    pageIndex: number,
    pageSize: number,
    query?: string,
    pipelineId?: string,
    stageId?: string,
    scope?: VisibilityScope,
    filters?: DealListFilters,
    access?: AccessPredicate,
  ) {
    // Read path: never triggers a write (auto-provision is explicit — S2/#2).
    // Clamp paging: guard NaN and cap page size so a caller cannot request an
    // unbounded scan (#4/#13).
    const safeIndex = Number.isFinite(pageIndex) && pageIndex > 0 ? Math.floor(pageIndex) : 0;
    const rawSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 25;
    const safeSize = Math.min(rawSize, 100);
    // TODO-189: обычный список отдаёт только живые записи; режим корзины
    // (includeDeleted) — только удалённые. `$ne: null` в Mongo не матчит и
    // отсутствующее поле, поэтому «никогда не удалялась» в корзину не попадёт.
    // Видимость (scope) и ABAC ниже применяются к корзине ровно так же, как к
    // обычному списку: гейт чтения корзины = гейт чтения списка (#4).
    const base: Record<string, unknown> = {
      projectId,
      deletedAt: filters?.includeDeleted ? { $ne: null } : { $in: [null, undefined] },
    };
    this.applyDealListFilters(base, query, pipelineId, stageId, filters, { omitStageDays: true });
    const userNarrow: Record<string, unknown>[] = [];
    if (filters?.withoutAssignee) {
      userNarrow.push({
        $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }],
      });
    }
    const minDays = filters?.minDaysOnStage ?? filters?.stageDaysMin;
    if (minDays != null && Number.isFinite(minDays) && minDays > 0) {
      const cutoffMs = Date.now() - Math.floor(minDays) * DAY_MS;
      userNarrow.push({ stageEnteredAt: { $lt: cutoffMs, $gt: 0 } });
    }
    const and: Record<string, unknown>[] = [base, ...userNarrow];
    const vis = this.buildDealsVisibilityFilter(scope, this.sharedObjectIds(scope));
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter: Record<string, unknown> = and.length === 1 ? and[0] : { $and: and };
    const total = await this.mongo.deals().countDocuments(filter);
    let hiddenByPolicy = 0;
    const restricts =
      scope?.mode !== 'all' ||
      (access?.present &&
        (access.malformed || (access.mongo && Object.keys(access.mongo).length > 0)));
    if (restricts) {
      // Пользовательские фильтры входят в projectTotal — иначе banner
      // «скрыто настройками доступа» раздувается от daysOnStage/withoutAssignee
      // (FR-ACCESS-560: разница только visibility/ABAC, не user filters).
      const projectAnd: Record<string, unknown>[] = [base, ...userNarrow];
      const projectFilter = projectAnd.length === 1 ? projectAnd[0] : { $and: projectAnd };
      const projectTotal = await this.mongo.deals().countDocuments(projectFilter);
      hiddenByPolicy = computeHiddenByPolicy(total, projectTotal);
    }
    const rows = await this.mongo
      .deals()
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip(safeIndex * safeSize)
      .limit(safeSize)
      .toArray();
    // TODO-381: stage names used to be resolved from the funnel of the FIRST row
    // only — every deal of another funnel on the same page fell back to
    // `stage_name = stageId` and the UI printed a raw ObjectId. One query over the
    // distinct funnels of the page builds a (pipelineId, stageId) → name map;
    // an empty page queries nothing (the old code sent `id: undefined`).
    const pipelineIds = [...new Set(rows.map((d) => String(d.pipelineId ?? '')).filter(Boolean))];
    const stageMap = new Map<string, string>();
    const rottingMap = new Map<string, number>();
    if (pipelineIds.length > 0) {
      const pls = await this.mongo
        .pipelines()
        .find({ projectId, id: { $in: pipelineIds } })
        .toArray();
      for (const pl of pls) {
        for (const s of (pl?.stages as
          | { id: string; name: string; rottingDays?: number }[]
          | undefined) ?? []) {
          stageMap.set(`${String(pl.id)}::${s.id}`, s.name);
          rottingMap.set(`${String(pl.id)}::${s.id}`, Number(s.rottingDays ?? 0));
        }
      }
    }
    return {
      list: rows.map((d) => {
        const doc = d as unknown as { pipelineId?: string; stageId?: string };
        const key = `${String(doc.pipelineId ?? '')}::${String(doc.stageId ?? '')}`;
        return this.toDeal(d as Record<string, unknown>, stageMap.get(key), {
          rottingDays: rottingMap.get(key),
        });
      }),
      total,
      hiddenByPolicy,
    };
  }

  async getKanban(
    projectId: string,
    pipelineId?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    filters?: DealListFilters,
    query?: string,
  ) {
    // Read path: never triggers a write (auto-provision is explicit — S2/#2).
    let pl = pipelineId
      ? await this.mongo.pipelines().findOne({ projectId, id: pipelineId })
      : await this.mongo.pipelines().findOne({ projectId, isDefault: true });
    if (!pl) pl = await this.mongo.pipelines().findOne({ projectId });
    if (!pl) throw new RpcException({ code: status.NOT_FOUND, message: 'Pipeline not found' });
    const p = this.toPipeline(pl as Record<string, unknown>);
    const rottingByStage = new Map(
      (p.stages ?? []).map((s) => [s.id, Number(s.rotting_days ?? 0)]),
    );
    const and: Record<string, unknown>[] = [
      { projectId, pipelineId: p.id, deletedAt: { $in: [null, undefined] } },
    ];
    this.applyDealListFilters(and[0], query, undefined, undefined, filters);
    const vis = this.buildDealsVisibilityFilter(scope, this.sharedObjectIds(scope));
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const dealFilter: Record<string, unknown> = and.length === 1 ? and[0] : { $and: and };

    // Perf (#13): never load every deal of the project into memory. One aggregation
    // with a $facet per stage returns only the first N cards per column (sorted like
    // the previous find ordered the docs). The {projectId}+visibility scope lives in
    // $match, so tenant isolation stays enforced by the DB (S7). Response shape is
    // additive (proto KanbanColumn: stage_id/stage_name/deals + total/has_more).
    // A twin count sub-pipeline (`t{i}`) reuses the SAME per-stage $match as the data
    // sub-pipeline (`c{i}`) — both run over the already scoped `dealFilter` output, so
    // `total` reflects exactly the visibility/ABAC-filtered set the column pages over.
    const facet: Record<string, Record<string, unknown>[]> = {};
    p.stages.forEach((st, i) => {
      // Positional facet key: stage ids are arbitrary user strings and $facet keys
      // may not contain '.'/'$'; index keys are always valid and unique.
      facet[`c${i}`] = [
        { $match: { stageId: st.id } },
        { $sort: { updatedAt: -1 } },
        { $limit: PipeService.KANBAN_COLUMN_LIMIT },
      ];
      facet[`t${i}`] = [{ $match: { stageId: st.id } }, { $count: 'n' }];
    });
    const [agg] = await this.mongo
      .deals()
      .aggregate<Record<string, unknown>>([{ $match: dealFilter }, { $facet: facet }])
      .toArray();
    const columns = p.stages.map((st, i) => {
      const cards = (agg?.[`c${i}`] as Record<string, unknown>[]) ?? [];
      const countDoc = (agg?.[`t${i}`] as { n?: number }[])?.[0];
      const total = Number(countDoc?.n ?? 0);
      return {
        stage_id: st.id,
        stage_name: st.name,
        deals: cards.map((d) =>
          this.toDeal(d, st.name, { rottingDays: rottingByStage.get(st.id) }),
        ),
        total,
        has_more: total > cards.length,
      };
    });
    return { pipeline: p, columns };
  }

  async getDeal(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    includeDeleted = false,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    // AND the abac `.mongo` fragment (and deny on malformed) into the read filter.
    const and: Record<string, unknown>[] = [{ _id: new ObjectId(id), projectId }];
    this.applyAccess(and, access);
    const d = await this.mongo
      .deals()
      .findOne((and.length === 1 ? and[0] : { $and: and }) as never);
    if (!d) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    // Soft-deleted records are hidden from normal reads (same 404 masking).
    if (!includeDeleted && d.deletedAt)
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    // Hide records the viewer may not see (same 404 as a missing record).
    if (!this.isDealRecordVisible(d, scope)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    }
    // Re-check with the single-record evalGate gate so get is exactly the contract
    // pair of the list filter (RFC-ABAC §4). Failing the gate is NOT_FOUND, never leak.
    if (!this.passesAccessGate(d as Record<string, unknown>, access)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    }
    const pl = await this.mongo.pipelines().findOne({ projectId, id: d.pipelineId });
    const st = (pl?.stages as { id: string; name: string; rottingDays?: number }[])?.find(
      (s) => s.id === d.stageId,
    );
    return this.toDeal(d as Record<string, unknown>, st?.name, {
      rottingDays: Number(st?.rottingDays ?? 0),
    });
  }

  /**
   * Document variable provider (documents contract §4). Reads the deal scoped to
   * `projectId` AND the caller's visibility (`getDeal` masks a cross-project or
   * invisible record as NOT_FOUND). Returns the flat `deal.*`/`contact.*`/
   * `company.*` variable map (the deal owns its links).
   */
  async resolveDocumentVariables(
    projectId: string,
    recordId: string,
    scope?: VisibilityScope,
  ): Promise<DocumentVariablesResult> {
    const deal = await this.getDeal(projectId, recordId, scope);
    return buildDealDocumentVariables(deal as Record<string, unknown>);
  }

  async createDeal(data: Record<string, unknown>, selfId?: string, scope?: VisibilityScope) {
    const projectId = String(data.project_id ?? '');
    // TODO-075 (defence in depth, the transport guard lives in the gRPC controller):
    // this method reads the project from its own payload, so an empty value here
    // would auto-provision a pipeline in the pseudo-project '' and hide the deal
    // from every scoped read forever.
    if (!projectId.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'projectId обязателен' });
    }
    const assigneeId = String(data.assignee_id ?? '');
    const departmentId = String(data.department_id ?? '');
    let resolvedAssignee = assigneeId;
    if (!resolvedAssignee && !departmentId && selfId) resolvedAssignee = selfId;
    if (resolvedAssignee) {
      await this.projectMembers.assertAssigneeMember(projectId, resolvedAssignee, selfId);
      this.assertAssigneeInScope(resolvedAssignee, scope, selfId);
    }
    await this.ensureProject(projectId);
    const now = Date.now();
    const requestedPipelineId = data.pipeline_id != null ? String(data.pipeline_id) : '';
    const pl = requestedPipelineId
      ? await this.mongo.pipelines().findOne({ projectId, id: requestedPipelineId })
      : null;
    // TODO-182: an unknown pipeline id used to be written verbatim onto the deal
    // while the stages came from the DEFAULT pipeline — the card landed in a funnel
    // that does not exist (invisible on every kanban) or, worse, kept another
    // project's id. Only an absent pipeline_id may fall back to the default.
    if (requestedPipelineId && !pl) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Воронка не найдена в проекте',
      });
    }
    const defaultPl = pl ?? (await this.mongo.pipelines().findOne({ projectId, isDefault: true }));
    const pipelineId = String(requestedPipelineId || defaultPl?.id);
    const stages = (defaultPl?.stages as PipelineStageDoc[]) ?? [];
    const stageId = String(data.stage_id ?? stages[0]?.id ?? 'st1');
    const st = stages.find((s) => s.id === stageId);
    // FR-15: stageId must belong to the pipeline.
    if (data.stage_id && !st) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'stageId не принадлежит воронке',
      });
    }
    const doc = {
      _id: new ObjectId(),
      projectId,
      pipelineId,
      stageId,
      name: String(data.name ?? 'Сделка'),
      amount: Number(data.amount ?? 0),
      currency: String(data.currency ?? 'RUB'),
      contactId: String(data.contact_id ?? ''),
      companyId: String(data.company_id ?? ''),
      productId: String(data.product_id ?? ''),
      assigneeId: resolvedAssignee,
      departmentId: departmentId,
      source: String(data.source ?? ''),
      status: 'open',
      probability: Number(data.probability ?? 0),
      expectedCloseDate: int64ToNumber(data.expected_close_date),
      lightName: String(data.light_name ?? ''),
      lightPhone: String(data.light_phone ?? ''),
      lightEmail: String(data.light_email ?? ''),
      lightCompanyName: String(data.light_company_name ?? ''),
      notes: String(data.notes ?? ''),
      createdAt: now,
      updatedAt: now,
      stageEnteredAt: now,
      // FR-16: initial open stageLog entry.
      stageLog: [{ stageId, enteredAt: now, movedBy: String(data.assignee_id ?? '') }],
    };
    // E3-01 transactional outbox: deal write + `crm.deal.created` row in one
    // Mongo session — no deal without an event, no event without a deal (RFC-4 Р-3).
    const saved = await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo.deals().insertOne(doc, session ? { session } : {});
      const created = await this.mongo
        .deals()
        .findOne({ _id: res.insertedId }, session ? { session } : {});
      const dealId = res.insertedId.toString();
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.created',
          source: 'pipe',
          projectId,
          subject: `deal/${dealId}`,
          idempotencyKey: `deal.created:${dealId}`,
          userId: doc.assigneeId || undefined,
          actorType: doc.assigneeId ? 'user' : 'service',
          payload: {
            dealId,
            pipelineId,
            stageId,
            // TODO-051: flat denormalized name — the search projection reads
            // human-readable fields from the top level of the payload (FR-SEARCH-010).
            name: doc.name,
            assigneeId: doc.assigneeId,
            amount: doc.amount,
            currency: doc.currency,
            contactId: doc.contactId,
            companyId: doc.companyId,
            source: doc.source,
          },
        },
      ];
      // Product catalog usage counter (product domain listener, contract §5.2):
      // a deal created already bound to a product is a product_link fact.
      if (doc.productId) {
        intents.push({
          type: 'crm.deal.product_linked',
          source: 'pipe',
          projectId,
          subject: `deal/${dealId}`,
          idempotencyKey: `deal.product_linked:${dealId}:${doc.productId}`,
          userId: doc.assigneeId || undefined,
          actorType: doc.assigneeId ? 'user' : 'service',
          payload: { dealId, productId: doc.productId, active: doc.status === 'open' },
        });
      }
      return { result: created, intents };
    });
    return this.toDeal(saved as Record<string, unknown>, st?.name);
  }

  async updateDeal(
    projectId: string,
    id: string,
    data: Record<string, unknown>,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const current = await this.getDeal(projectId, id, scope, false, access);
    const closed = current.status === 'won' || current.status === 'lost';
    // FR-14: closed deals are read-only for funnel fields.
    if (closed) {
      const touchesFunnel = Object.keys(data).some((k) => FUNNEL_FIELDS.has(k) && data[k] != null);
      if (touchesFunnel) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'Сделка закрыта: изменение вороночных полей запрещено',
        });
      }
    }
    const now = Date.now();
    const u: Record<string, unknown> = { updatedAt: now };
    // TODO-385: `name` is required, so an explicitly empty value (now reachable
    // through proto3 field presence) is ignored instead of blanking the card —
    // same rule as `currency` and `assignee_id` below. Clearable fields
    // (contact/company/product/source/notes/department) DO accept '' and are
    // unset by it.
    if (data.name != null && String(data.name).trim() !== '') u.name = data.name;
    if (data.amount != null) u.amount = data.amount;
    if (data.contact_id != null) u.contactId = data.contact_id;
    if (data.company_id != null) u.companyId = data.company_id;
    // TODO-385 (доработка): отвязка — это не только обнуление id. Производные от
    // связи данные лежат ОТДЕЛЬНЫМИ полями документа: снимок реквизитов
    // (contactSnapshot/companySnapshot), денормализованное имя
    // (contactName/companyName) и дрейф (driftFlag/driftFields/driftDetail).
    // Пока они не чистились, сделка без contact_id продолжала показывать имя,
    // телефон и e-mail отвязанного человека (toDeal отдаёт contact_name и
    // contact_snapshot безусловно, :323/:350, а buildDealDocumentVariables ещё и
    // подставлял их в генерируемые документы), то есть PII удерживалась после
    // явного действия пользователя «убрать связь». Дрейф при этом зависал
    // навсегда: drift-consumer ищет сделки по `{projectId, contactId}`
    // (drift-consumer.service.ts:216) и после очистки связи такую сделку больше
    // не находит — погасить флаг было нечем.
    const clearsContact = data.contact_id != null && String(data.contact_id) === '';
    const clearsCompany = data.company_id != null && String(data.company_id) === '';
    if (data.product_id != null) u.productId = String(data.product_id);
    if (data.source != null) u.source = String(data.source);
    // Currency is never cleared: an empty string from a peer would leave the card
    // without a unit (createDeal defaults it to RUB), so only a real value applies.
    if (data.currency != null && String(data.currency) !== '') u.currency = String(data.currency);
    if (data.notes != null) u.notes = String(data.notes);
    // Ownership is never cleared (spec §13.2 «no orphan records»): with proto3
    // presence an explicit '' would otherwise leave a deal nobody owns — invisible
    // to every `own`-scope viewer. Reassignment goes through a real user id.
    if (data.assignee_id != null && String(data.assignee_id) !== '') {
      const nextAssignee = String(data.assignee_id);
      await this.projectMembers.assertAssigneeMember(projectId, nextAssignee, userId);
      this.assertAssigneeInScope(nextAssignee, scope, userId);
      u.assigneeId = data.assignee_id;
    }
    if (data.department_id != null) u.departmentId = data.department_id;
    const nextAssignee =
      u.assigneeId !== undefined ? String(u.assigneeId) : String(current.assignee_id ?? '');
    const nextDepartment =
      u.departmentId !== undefined ? String(u.departmentId) : String(current.department_id ?? '');
    if (!nextAssignee && !nextDepartment) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Сделка должна иметь ответственного или отдел',
      });
    }
    if (data.tags != null) u.tags = data.tags;
    if (data.probability != null) u.probability = data.probability;
    // int64 → число ОБЯЗАТЕЛЬНО: сырой Long, записанный в Mongo, читался обратно
    // в toDeal() как `Number(объект)` = NaN → protobuf кодировал 0, и КАЖДОЕ
    // сохранение сделки затирало дату, проставленную при создании (createDeal
    // уже приводил её к числу).
    if (data.expected_close_date != null)
      u.expectedCloseDate = int64ToNumber(data.expected_close_date);
    // TODO-190: changing the funnel must carry the card WITH it. The old code wrote
    // the new pipelineId and left the stageId of the OLD funnel, so the deal
    // belonged to a stage that funnel does not contain — it vanished from the kanban
    // (no column matches) and from stage-name resolution. A funnel switch is now:
    // validate the target funnel inside the project → pick the target stage (the
    // requested one if it belongs to the NEW funnel, else its first stage) → log the
    // move and emit `crm.deal.stage_changed` like any other stage transition.
    const requestedPipelineId = data.pipeline_id != null ? String(data.pipeline_id) : '';
    const switchesPipeline =
      requestedPipelineId !== '' && requestedPipelineId !== String(current.pipeline_id);
    let pipelineMove: { fromStageId: string; toStageId: string } | undefined;
    if (switchesPipeline) {
      const targetPl = await this.mongo.pipelines().findOne({ projectId, id: requestedPipelineId });
      if (!targetPl) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'Воронка не найдена в проекте',
        });
      }
      const targetStages = [...((targetPl.stages as PipelineStageDoc[]) ?? [])].sort(
        (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
      );
      const requestedStageId = data.stage_id != null ? String(data.stage_id) : '';
      const requestedStage = requestedStageId
        ? targetStages.find((s) => s.id === requestedStageId)
        : undefined;
      if (requestedStageId && !requestedStage) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'stageId не принадлежит целевой воронке',
        });
      }
      const toStage = requestedStage ?? targetStages[0];
      if (!toStage) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'В целевой воронке нет стадий',
        });
      }
      u.pipelineId = requestedPipelineId;
      u.stageId = toStage.id;
      u.stageEnteredAt = now;
      pipelineMove = { fromStageId: String(current.stage_id), toStageId: toStage.id };
    } else if (requestedPipelineId !== '') {
      // Same funnel re-sent by the form: keep the AS-IS write, nothing moves.
      u.pipelineId = requestedPipelineId;
    }
    // Stage change via UpdateDeal is normalized into the move path so stageLog/history
    // stay consistent (contract §7: smena stageId tol'ko cherez MoveDealToStage).
    // Skipped when the funnel switch above already relocated the card.
    if (
      !switchesPipeline &&
      data.stage_id != null &&
      String(data.stage_id) !== '' &&
      data.stage_id !== current.stage_id
    ) {
      await this.moveDealToStage(projectId, id, String(data.stage_id), scope, userId);
    }
    // Changed funnel/business fields (snake_case body keys) for the event payload.
    const changed = Object.keys(u).filter((k) => k !== 'updatedAt');
    // Производные от связи поля считаем от СЫРОГО документа: `current` — это уже
    // toDeal-проекция, в ней нет ни driftDetail, ни snapshotHistory. Держим их в
    // отдельных `derived`/`unset`, чтобы служебная зачистка не попала в `changed`
    // события (там перечислено то, что менял пользователь).
    const derived: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};
    let archivedSnapshot: Record<string, unknown> | undefined;
    if (clearsContact || clearsCompany) {
      const raw = (await this.mongo
        .deals()
        .findOne({ _id: new ObjectId(id), projectId })) as Record<string, unknown> | null;
      if (clearsContact) {
        unset.contactSnapshot = '';
        unset.contactName = '';
      }
      if (clearsCompany) {
        unset.companySnapshot = '';
        unset.companyName = '';
      }
      // Дрейф гасим ТОЛЬКО по отвязанной стороне: ключи `company.*` принадлежат
      // компании, остальные — контакту (та же раскладка, что в acceptContactDrift).
      // Отвязка контакта не должна проглатывать несогласованный дрейф компании.
      const driftFields = (raw?.driftFields as string[] | undefined) ?? [];
      const remaining = driftFields.filter((f) =>
        f.startsWith('company.') ? !clearsCompany : !clearsContact,
      );
      if (remaining.length !== driftFields.length) {
        derived.driftFields = remaining;
        // driftFlag пересчитывается по ОСТАТКУ, а не гасится безусловно.
        derived.driftFlag = remaining.length > 0;
        // Деталь снятых полей убираем ТОЧЕЧНЫМ $unset по пути (тем же, каким её
        // пишет консьюмер): пересборка объекта `driftDetail` по литеральным ключам
        // роняла вложенную ветку `driftDetail.company.*` — отвязка контакта уносила
        // с собой ещё не согласованный дрейф компании.
        for (const f of driftFields) {
          if (!remaining.includes(f)) unset[`driftDetail.${f}`] = '';
        }
      }
      // Снимок реквизитов — след состоявшейся связи, поэтому он не выбрасывается
      // молча, а уезжает в snapshotHistory той же outbox-сессией (приём из
      // acceptContactDrift). Пустой истории не пишем.
      if (raw?.contactSnapshot != null || raw?.companySnapshot != null) {
        archivedSnapshot = {
          contactSnapshot: raw?.contactSnapshot ?? null,
          companySnapshot: raw?.companySnapshot ?? null,
          at: now,
          unlinked: [clearsContact ? 'contact' : '', clearsCompany ? 'company' : ''].filter(
            Boolean,
          ),
        };
      }
    }
    // Derived from what is actually WRITTEN (`u`), not from the raw payload: an
    // ignored empty assignee must not emit a phantom `crm.deal.reassigned`.
    const reassigned =
      u.assigneeId !== undefined && String(u.assigneeId) !== String(current.assignee_id ?? '');
    // E3-01 transactional outbox: deal write + `crm.deal.updated` (and `crm.deal.reassigned`
    // on owner change) in one Mongo session — no write without its event (RFC-4 Р-3).
    await this.outbox.withOutbox(async (session) => {
      if (pipelineMove) {
        // TODO-383: keep the embedded trail bounded (older entries → history).
        await this.evictStageLogOverflow(projectId, id, 1, session);
        // Close the entries still open BEFORE this move (enteredAt < now), then
        // append the new one: `$set` on `stageLog.$[]` and `$push` on `stageLog`
        // cannot share one update (Mongo path conflict — the T-036.4 lesson), so
        // the two writes run back-to-back inside the SAME outbox session.
        await this.mongo.deals().updateOne(
          { _id: new ObjectId(id), projectId },
          { $set: { 'stageLog.$[open].exitedAt': now } },
          {
            arrayFilters: [{ 'open.exitedAt': { $exists: false }, 'open.enteredAt': { $lt: now } }],
            ...(session ? { session } : {}),
          },
        );
      }
      // Один $push на оба массива: два оператора $push в одном апдейте Mongo не
      // допускает, а вот две РАЗНЫЕ цели внутри одного — да (конфликта путей нет,
      // в отличие от $set+$push по stageLog выше).
      const push: Record<string, unknown> = {};
      if (pipelineMove) {
        push.stageLog = {
          $each: [
            {
              stageId: pipelineMove.toStageId,
              enteredAt: now,
              movedBy: userId ?? '',
              kind: 'move',
            },
          ],
          $slice: -PipeService.STAGE_LOG_LIMIT,
        };
      }
      if (archivedSnapshot) push.snapshotHistory = archivedSnapshot;
      await this.mongo.deals().updateOne(
        { _id: new ObjectId(id), projectId },
        {
          // Зачистка производных полей связи идёт ТОЙ ЖЕ записью, что и обнуление
          // id: иначе между двумя апдейтами существует окно, в котором карточка
          // уже «без контакта», но всё ещё с его именем/телефоном.
          $set: Object.keys(derived).length > 0 ? { ...u, ...derived } : u,
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          ...(Object.keys(push).length > 0 ? { $push: push } : {}),
        } as never,
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.updated',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.updated:${id}:${u.updatedAt as number}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          // TODO-051: on rename ship the new flat name so the search projection
          // can refresh the indexed title (merge-семантика: absent ≠ blank).
          payload: { dealId: id, changed, ...(u.name != null ? { name: String(u.name) } : {}) },
        },
      ];
      if (reassigned) {
        intents.push({
          type: 'crm.deal.reassigned',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.reassigned:${id}:${u.updatedAt as number}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            fromOwnerId: String(current.assignee_id ?? ''),
            toOwnerId: String(u.assigneeId ?? ''),
          },
        });
      }
      // TODO-190: a funnel switch relocates the card, so it is also a stage change —
      // consumers (automation/notification/statistics/audit) must see the same fact
      // they get from MoveDealToStage, otherwise the card silently teleports.
      if (pipelineMove) {
        intents.push({
          type: 'crm.deal.stage_changed',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.stage_changed:${id}:${now}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            fromStageId: pipelineMove.fromStageId,
            toStageId: pipelineMove.toStageId,
            fromPipelineId: String(current.pipeline_id ?? ''),
            toPipelineId: String(u.pipelineId ?? ''),
            movedBy: userId ?? '',
          },
        });
      }
      // Product link change → catalog counter facts (product domain listener §5.2):
      // unlink the old product, link the new one. Idempotency keys carry the value
      // so a re-applied update never double-counts.
      if (u.productId !== undefined) {
        const oldProduct = String(current.product_id ?? '');
        const newProduct = String(u.productId ?? '');
        if (oldProduct !== newProduct) {
          if (oldProduct) {
            intents.push({
              type: 'crm.deal.product_unlinked',
              source: 'pipe',
              projectId,
              subject: `deal/${id}`,
              idempotencyKey: `deal.product_unlinked:${id}:${oldProduct}:${u.updatedAt as number}`,
              userId: userId || undefined,
              actorType: userId ? 'user' : 'service',
              payload: { dealId: id, productId: oldProduct, active: current.status === 'open' },
            });
          }
          if (newProduct) {
            intents.push({
              type: 'crm.deal.product_linked',
              source: 'pipe',
              projectId,
              subject: `deal/${id}`,
              idempotencyKey: `deal.product_linked:${id}:${newProduct}:${u.updatedAt as number}`,
              userId: userId || undefined,
              actorType: userId ? 'user' : 'service',
              payload: { dealId: id, productId: newProduct, active: current.status === 'open' },
            });
          }
        }
      }
      return { result: undefined, intents };
    });
    return this.getDeal(projectId, id, scope, false, access);
  }

  async deleteDeal(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const current = await this.getDeal(projectId, id, scope, false, access);
    const now = Date.now();
    // FR-51: soft-delete (was hard deleteOne). Idempotent re-delete is a no-op.
    // E3-01 transactional outbox: soft-delete + `crm.deal.deleted` row in one
    // Mongo session — soft-delete and audit/search event commit together (RFC-4 Р-3).
    await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo
        .deals()
        .updateOne(
          { _id: new ObjectId(id), projectId, deletedAt: { $in: [null, undefined] } },
          { $set: { deletedAt: now, deletedBy: userId ?? '', updatedAt: now } },
          session ? { session } : {},
        );
      // Only emit on an actual state change (idempotent re-delete = no event).
      const intents: EmitIntent[] =
        res.modifiedCount > 0
          ? [
              {
                type: 'crm.deal.deleted',
                source: 'pipe',
                projectId,
                subject: `deal/${id}`,
                idempotencyKey: `deal.deleted:${id}`,
                userId: userId || undefined,
                actorType: userId ? 'user' : 'service',
                payload: {
                  dealId: id,
                  ownerId: String(current.assignee_id ?? ''),
                },
              },
            ]
          : [];
      // Deleting a deal that was bound to a product unlinks it (product counter §5.2).
      if (res.modifiedCount > 0 && current.product_id) {
        intents.push({
          type: 'crm.deal.product_unlinked',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.product_unlinked:${id}:${String(current.product_id)}:deleted`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            productId: String(current.product_id),
            active: current.status === 'open',
          },
        });
      }
      return { result: undefined, intents };
    });
    const doc = await this.mongo.deals().findOne({ _id: new ObjectId(id), projectId });
    return this.toDeal(doc as Record<string, unknown>);
  }

  async restoreDeal(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const doc = await this.getDeal(projectId, id, scope, true, access);
    if (!doc.deleted_at) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Сделка не была удалена',
      });
    }
    const now = Date.now();
    // E3-01 transactional outbox: restore + `crm.deal.restored` row in one session.
    // The un-delete transition has its own registered key (RFC-4 §Р-3, be-event-keys-rfc4)
    // so audit reads it as a restore fact and search re-indexes the revived deal.
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .deals()
        .updateOne(
          { _id: new ObjectId(id), projectId },
          { $set: { deletedAt: null, deletedBy: '', updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.restored',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.restored:${id}:${now}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { dealId: id, changed: ['deletedAt'], restored: true },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getDeal(projectId, id, scope, false, access);
  }

  async moveDealToStage(
    projectId: string,
    dealId: string,
    stageId: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
    autoCascadeDepth = 0,
  ) {
    const current = await this.getDeal(projectId, dealId, scope, false, access);
    // FR-14: cannot move a closed deal.
    if (current.status === 'won' || current.status === 'lost') {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Сделка закрыта',
      });
    }
    // FR-15: target stage must belong to the deal's pipeline.
    const { pipeline: plDoc, stage } = await this.resolveStage(
      projectId,
      current.pipeline_id,
      stageId,
    );
    if (!stage) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'stageId не принадлежит воронке сделки',
      });
    }
    // FR-17: moving onto the same stage is a no-op (debounce).
    if (current.stage_id === stageId) {
      return current;
    }
    const now = Date.now();
    const fromStageId = current.stage_id;
    const debounceMs = Number(plDoc?.debounceMs ?? 5000);
    const raw = await this.mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
    const stageLog = (raw?.stageLog as DealStageLogEntry[]) ?? [];
    const debouncedReturn = this.isDebouncedStageReturn(
      stageLog,
      fromStageId,
      stageId,
      now,
      debounceMs,
    );
    // E3-01 transactional outbox: stage move + `crm.deal.stage_changed` row in one
    // Mongo session — audit/automation/notification listeners (RFC-4 Р-3).
    // TOCTOU (#21): the open/from-stage invariants live in the updateOne filter so a
    // concurrent close/move loses the race deterministically (matchedCount===0).
    const matched = await this.outbox.withOutbox(async (session) => {
      if (debouncedReturn) {
        // TODO-382 / FR-DEALS-170: bounce-back within pipeline.debounceMs collapses
        // the intermediate hop instead of appending another log row (EC-2, FR-17).
        // The `crm.deal.stage_changed` event is still emitted below: search/reports/
        // automation project the current stage from `toStageId`, so a silent move
        // would leave them stuck on the intermediate stage forever.
        const collapsed = stageLog.slice(0, -1);
        const reopened = collapsed[collapsed.length - 1];
        const restoredEnteredAt = Number(reopened?.enteredAt ?? now);
        const res = await this.mongo.deals().updateOne(
          {
            _id: new ObjectId(dealId),
            projectId,
            status: { $nin: ['won', 'lost'] },
            stageId: fromStageId,
          },
          {
            $set: {
              stageId,
              stageEnteredAt: restoredEnteredAt,
              stageLog: collapsed.map((entry, idx) =>
                idx === collapsed.length - 1
                  ? {
                      stageId: entry.stageId,
                      enteredAt: entry.enteredAt,
                      movedBy: entry.movedBy ?? '',
                      kind: entry.kind ?? 'move',
                    }
                  : entry,
              ),
              updatedAt: now,
            },
          },
          session ? { session } : {},
        );
        if (res.matchedCount === 0) {
          return { result: 0, intents: [] };
        }
        const debouncedIntents: EmitIntent[] = [
          {
            type: 'crm.deal.stage_changed',
            source: 'pipe',
            projectId,
            subject: `deal/${dealId}`,
            idempotencyKey: `deal.stage_changed:${dealId}:${now}`,
            userId: userId || undefined,
            actorType: userId ? 'user' : 'service',
            payload: {
              dealId,
              fromStageId,
              toStageId: stageId,
              movedBy: userId ?? '',
              autoCascadeDepth,
            },
          },
        ];
        return { result: res.matchedCount, intents: debouncedIntents };
      }
      // TODO-383: bound the embedded trail — entries pushed out by the $slice below
      // are archived into `crm_deal_stage_history` in this same session.
      await this.evictStageLogOverflow(projectId, dealId, 1, session);
      const res = await this.mongo.deals().updateOne(
        {
          _id: new ObjectId(dealId),
          projectId,
          status: { $nin: ['won', 'lost'] },
          stageId: fromStageId,
        },
        // Atomic: close the previous open log entry + push the new one (NFR-7).
        // QA-CI T-036.4: a classic update that both `$set`s the array-element path
        // `stageLog.$[open].exitedAt` AND `$push`es to `stageLog` is rejected by
        // MongoDB ("Updating the path 'stageLog' would create a conflict at
        // 'stageLog'") — every real stage move failed. An aggregation-pipeline
        // update ($set + $concatArrays) performs the same close-previous +
        // append-new atomically without the path conflict.
        [
          {
            $set: {
              // TODO-383: `$slice` keeps only the last STAGE_LOG_LIMIT entries so the
              // array cannot grow towards the 16 MB BSON ceiling; the dropped head was
              // just copied into `crm_deal_stage_history` (evictStageLogOverflow).
              stageLog: {
                $slice: [
                  {
                    $concatArrays: [
                      {
                        $map: {
                          input: { $ifNull: ['$stageLog', []] },
                          as: 's',
                          in: {
                            $cond: [
                              { $eq: [{ $type: '$$s.exitedAt' }, 'missing'] },
                              { $mergeObjects: ['$$s', { exitedAt: now }] },
                              '$$s',
                            ],
                          },
                        },
                      },
                      [{ stageId, enteredAt: now, movedBy: userId ?? '', kind: 'move' }],
                    ],
                  },
                  -PipeService.STAGE_LOG_LIMIT,
                ],
              },
              stageId,
              stageEnteredAt: now,
              updatedAt: now,
            },
          },
        ],
        session ? { session } : {},
      );
      if (res.matchedCount === 0) {
        // Nothing changed: emit no event (do not leak a phantom stage change).
        return { result: 0, intents: [] };
      }
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.stage_changed',
          source: 'pipe',
          projectId,
          subject: `deal/${dealId}`,
          idempotencyKey: `deal.stage_changed:${dealId}:${now}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId,
            fromStageId,
            toStageId: stageId,
            movedBy: userId ?? '',
            autoCascadeDepth:
              userId === 'auto-transition' ? autoCascadeDepth + 1 : autoCascadeDepth,
          },
        },
      ];
      return { result: res.matchedCount, intents };
    });
    if (matched === 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Сделка была изменена другим процессом',
      });
    }
    return this.getDeal(projectId, dealId, scope, false, access);
  }

  async getDashboard(
    projectId: string,
    scope?: VisibilityScope,
    opts?: { from?: number; to?: number; pipelineId?: string },
    access?: AccessPredicate,
  ) {
    // Read path: never triggers a write (auto-provision is explicit — S2/#2).
    const and: Record<string, unknown>[] = [{ projectId, deletedAt: { $in: [null, undefined] } }];
    if (opts?.pipelineId) and.push({ pipelineId: opts.pipelineId });
    const vis = this.buildDealsVisibilityFilter(scope, this.sharedObjectIds(scope));
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const dealFilter: Record<string, unknown> = and.length === 1 ? and[0] : { $and: and };
    const pl = await this.mongo
      .pipelines()
      .findOne(
        opts?.pipelineId ? { projectId, id: opts.pipelineId } : { projectId, isDefault: true },
      );
    const stages = (pl?.stages as { id: string; name: string }[]) ?? [];
    const stageNameById = new Map(stages.map((s) => [s.id, s.name]));

    // Period window for won/lost/conversion/timeline (0 = all time, FR-40).
    // int64ToNumber, а не Number(): сырой Long дал бы NaN → `$gte: NaN` не
    // матчит ни одной сделки и дашборд молча показывает нули.
    const from = int64ToNumber(opts?.from);
    const to = int64ToNumber(opts?.to) || Date.now();
    const dayMs = 86_400_000;

    // Perf (#13): the whole dashboard is computed by the DB in one aggregation over
    // the scoped {projectId}+visibility $match — no deals are streamed into heap.
    // Each analytics slice is its own $facet branch ($group / $bucket-by-day / topN).
    const [agg] = await this.mongo
      .deals()
      .aggregate<Record<string, unknown>>([
        { $match: dealFilter },
        {
          $facet: {
            // Open deals grouped by stage (count + amount). A missing status counts
            // as open, matching the previous `(status ?? 'open') === 'open'` logic.
            byStage: [
              { $match: { status: { $nin: ['won', 'lost'] } } },
              {
                $group: {
                  _id: '$stageId',
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                },
              },
            ],
            // Won deals in period: count, amount, and average cycle time (days).
            won: [
              { $match: { status: 'won', wonAt: { $gte: from, $lte: to } } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                  cycleSum: {
                    $sum: {
                      $let: {
                        vars: {
                          d: {
                            $divide: [
                              {
                                $subtract: [
                                  { $ifNull: ['$wonAt', 0] },
                                  { $ifNull: ['$createdAt', 0] },
                                ],
                              },
                              dayMs,
                            ],
                          },
                        },
                        in: { $cond: [{ $gte: ['$$d', 0] }, '$$d', 0] },
                      },
                    },
                  },
                  cycleCount: {
                    $sum: {
                      $cond: [
                        {
                          $gte: [
                            {
                              $subtract: [
                                { $ifNull: ['$wonAt', 0] },
                                { $ifNull: ['$createdAt', 0] },
                              ],
                            },
                            0,
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            lost: [
              { $match: { status: 'lost', lostAt: { $gte: from, $lte: to } } },
              { $group: { _id: null, count: { $sum: 1 } } },
            ],
            openTotal: [{ $match: { status: { $nin: ['won', 'lost'] } } }, { $count: 'count' }],
            // All-scope totals (deals count + summed amount).
            totals: [
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                },
              },
            ],
            // Created deals bucketed by day across the period (FR-40).
            timeline: [
              { $match: { createdAt: { $gte: from, $lte: to } } },
              {
                $group: {
                  _id: {
                    $multiply: [
                      { $floor: { $divide: [{ $ifNull: ['$createdAt', 0] }, dayMs] } },
                      dayMs,
                    ],
                  },
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ],
            // Top managers by owned amount (FR-40): count, amount, won count.
            managers: [
              { $match: { assigneeId: { $nin: [null, ''] } } },
              {
                $group: {
                  _id: '$assigneeId',
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                  won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                },
              },
              { $sort: { amount: -1 } },
              { $limit: 10 },
            ],
            // Most-recently created deals for the preview list.
            recent: [{ $sort: { createdAt: -1 } }, { $limit: 5 }],
            // FR-DEALS-400: weighted forecast (open deals × probability).
            forecast: [
              { $match: { status: { $nin: ['won', 'lost'] } } },
              {
                $group: {
                  _id: null,
                  amount: {
                    $sum: {
                      $multiply: [
                        { $ifNull: ['$amount', 0] },
                        { $divide: [{ $ifNull: ['$probability', 0] }, 100] },
                      ],
                    },
                  },
                },
              },
            ],
            byDepartment: [
              { $match: { status: { $nin: ['won', 'lost'] }, departmentId: { $nin: [null, ''] } } },
              {
                $group: {
                  _id: '$departmentId',
                  count: { $sum: 1 },
                  amount: { $sum: { $ifNull: ['$amount', 0] } },
                },
              },
              { $sort: { amount: -1 } },
            ],
          },
        },
      ])
      .toArray();

    const rottingByStage = new Map<string, number>();
    for (const s of stages) {
      const raw = (pl?.stages as { id: string; rottingDays?: number }[] | undefined)?.find(
        (x) => x.id === s.id,
      );
      rottingByStage.set(s.id, Number(raw?.rottingDays ?? 0));
    }
    const openForStalled = await this.mongo
      .deals()
      .find(
        {
          ...(dealFilter as object),
          status: { $nin: ['won', 'lost'] },
        },
        { projection: { stageId: 1, stageEnteredAt: 1, createdAt: 1 } },
      )
      .toArray();
    const now = Date.now();
    let stalledCount = 0;
    for (const d of openForStalled) {
      const rotting = rottingByStage.get(String(d.stageId ?? '')) ?? 0;
      if (rotting <= 0) continue;
      const entered = Number(d.stageEnteredAt ?? d.createdAt ?? 0);
      const days = entered > 0 ? Math.floor((now - entered) / DAY_MS) : 0;
      if (days > rotting) stalledCount += 1;
    }

    const firstOf = <T>(arr: unknown, fallback: T): T =>
      Array.isArray(arr) && arr.length ? (arr[0] as T) : fallback;
    const num = (v: unknown) => Number(v ?? 0);

    const byStageAgg = (agg?.byStage as { _id: string; count: number; amount: number }[]) ?? [];
    const byStageMap = new Map(byStageAgg.map((s) => [String(s._id), s]));
    const byStage = stages.map((s) => {
      const row = byStageMap.get(s.id);
      return {
        stage_id: s.id,
        stage_name: s.name,
        count: num(row?.count),
        amount: num(row?.amount),
      };
    });

    const wonAgg = firstOf<{
      count?: number;
      amount?: number;
      cycleSum?: number;
      cycleCount?: number;
    }>(agg?.won, {});
    const lostAgg = firstOf<{ count?: number }>(agg?.lost, {});
    const openCount = num(firstOf<{ count?: number }>(agg?.openTotal, {}).count);
    const totalsAgg = firstOf<{ count?: number; amount?: number }>(agg?.totals, {});

    const wonCount = num(wonAgg.count);
    const lostCount = num(lostAgg.count);
    const closedTotal = wonCount + lostCount;
    const cycleCount = num(wonAgg.cycleCount);
    const avgCycle = cycleCount ? num(wonAgg.cycleSum) / cycleCount : 0;
    const conversion = {
      won_count: wonCount,
      lost_count: lostCount,
      conversion_rate: closedTotal > 0 ? wonCount / closedTotal : 0,
      won_amount: num(wonAgg.amount),
      avg_cycle_days: Math.round(avgCycle * 10) / 10,
      open_count: openCount,
    };

    const deals_timeline = (
      (agg?.timeline as { _id: number; count: number; amount: number }[]) ?? []
    ).map((v) => ({ t: num(v._id), count: num(v.count), amount: num(v.amount) }));

    const top_managers = (
      (agg?.managers as { _id: string; count: number; amount: number; won: number }[]) ?? []
    ).map((v) => ({
      id: String(v._id),
      name: '', // name resolved on gateway/BFF (id→displayName)
      deals_count: num(v.count),
      amount: num(v.amount),
      won_count: num(v.won),
    }));

    const totalDeals = num(totalsAgg.count);
    const totalAmount = num(totalsAgg.amount);
    const forecastAgg = firstOf<{ amount?: number }>(agg?.forecast, {});
    const byDepartmentAgg =
      (agg?.byDepartment as { _id: string; count: number; amount: number }[]) ?? [];
    return {
      statistics: [
        { key: 'deals', label: 'Сделки', value: totalDeals, previous_value: 0, growth_rate: 0 },
        { key: 'amount', label: 'Сумма', value: totalAmount, previous_value: 0, growth_rate: 0 },
        { key: 'won', label: 'Выиграно', value: wonCount, previous_value: 0, growth_rate: 0 },
        {
          key: 'conversion',
          label: 'Конверсия',
          value: Math.round(conversion.conversion_rate * 1000) / 10,
          previous_value: 0,
          growth_rate: 0,
        },
      ],
      deals_by_stage: byStage,
      deals_timeline,
      top_managers,
      conversion,
      from,
      to,
      recent_deals: ((agg?.recent as Record<string, unknown>[]) ?? []).map((d) =>
        this.toDeal(d, stageNameById.get(String(d.stageId ?? ''))),
      ),
      stalled_count: stalledCount,
      forecast_amount: num(forecastAgg.amount),
      by_department: byDepartmentAgg.map((row) => ({
        department_id: String(row._id ?? ''),
        count: num(row.count),
        amount: num(row.amount),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // TO-BE deal lifecycle
  // ---------------------------------------------------------------------------

  /**
   * FR-27: real diff between the deal's PII snapshot and the current contact/company
   * values recorded by the drift-detection listener. The listener (on `crm.contact.updated`)
   * stores per-field detail in `driftDetail[field] = {currentValue, changedBy, changedAt}`
   * alongside the `driftFields` list; this method joins snapshot ⨝ detail so the FE gets a
   * fully-populated diff without a synchronous contact hop (gateway may still enrich).
   */
  async getDealDrift(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    // getDeal applies the abac gate/filter (NOT_FOUND-masks a denied record).
    const deal = await this.getDeal(projectId, id, scope, false, access);
    const raw = await this.mongo.deals().findOne({ _id: new ObjectId(id), projectId });
    const driftFields = (raw?.driftFields as string[]) ?? [];
    const contactSnap = (raw?.contactSnapshot as Record<string, unknown>) ?? {};
    const companySnap = (raw?.companySnapshot as Record<string, unknown>) ?? {};
    const detail = (raw?.driftDetail as Record<string, unknown>) ?? {};
    const drift = driftFields.map((field) => {
      // Деталь лежит по ПУТИ поля ('company.name' → detail.company.name) — см.
      // driftDetailEntry: точечный $set консьюмера создаёт вложенный документ.
      const dd = driftDetailEntry(detail, field) ?? {};
      // Company fields prefix with 'company.'; everything else is a contact field.
      const isCompany = field.startsWith('company.');
      const snapKey = isCompany ? field.slice('company.'.length) : field;
      const snapVal = (isCompany ? companySnap[snapKey] : contactSnap[snapKey]) ?? '';
      return {
        field,
        snapshot_value: String(dd.snapshotValue ?? snapVal),
        current_value: String(dd.currentValue ?? ''),
        changed_by: String(dd.changedBy ?? ''),
        changed_at: Number(dd.changedAt ?? 0),
      };
    });
    const contactDeleted = !!raw?.contactSourceDeleted;
    const companyDeleted = !!raw?.companySourceDeleted;
    return {
      deal_id: deal.id,
      drift,
      source_deleted: contactDeleted || companyDeleted,
      contact_source_deleted: contactDeleted,
      company_source_deleted: companyDeleted,
    };
  }

  /** FR-10/11/12: close as won or lost. */
  async closeDeal(
    projectId: string,
    id: string,
    result: string,
    lostReasonId?: string,
    lostReasonComment?: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const current = await this.getDeal(projectId, id, scope, false, access);
    if (current.status === 'won' || current.status === 'lost') {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'Сделка уже закрыта' });
    }
    if (result !== 'won' && result !== 'lost') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'result: won|lost' });
    }
    const now = Date.now();
    const raw = await this.mongo.deals().findOne({ _id: new ObjectId(id), projectId });
    const stages = (await this.mongo.pipelines().findOne({ projectId, id: current.pipeline_id }))
      ?.stages as PipelineStageDoc[] | undefined;
    const u: Record<string, unknown> = { updatedAt: now, status: result };
    if (result === 'won') {
      u.wonAt = now;
      u.wonVersion = Number(raw?.wonVersion ?? 0) + 1;
      const wonStage = stages?.find((s) => s.kind === 'won');
      if (wonStage) {
        u.stageId = wonStage.id;
        u.stageEnteredAt = now;
      }
    } else {
      // FR-11: lost reason required when the per-project dictionary is non-empty.
      const reasonsCount = await this.mongo.lostReasons().countDocuments({ projectId });
      if (reasonsCount > 0 && !lostReasonId) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'Укажите причину проигрыша',
        });
      }
      if (lostReasonId) {
        const lr = await this.mongo.lostReasons().findOne({ projectId, id: lostReasonId });
        if (!lr) {
          throw new RpcException({
            code: status.INVALID_ARGUMENT,
            message: 'Неизвестная причина проигрыша',
          });
        }
      }
      u.lostAt = now;
      u.lostReasonId = lostReasonId ?? '';
      u.lostReasonComment = lostReasonComment ?? '';
      const lostStage = stages?.find((s) => s.kind === 'lost');
      if (lostStage) {
        u.stageId = lostStage.id;
        u.stageEnteredAt = now;
      }
    }
    // E3-01 transactional outbox: close + win/lose event in one Mongo session.
    // won idempotencyKey=`dealId:wonVersion` is the business dedup that protects
    // orders from a duplicate order on close/retry (contract §9.6, RFC-4 Р-3).
    // TOCTOU (#21): the still-open invariant lives in the updateOne filter so a
    // concurrent close loses the race deterministically (matchedCount===0).
    const matched = await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo
        .deals()
        .updateOne(
          { _id: new ObjectId(id), projectId, status: { $nin: ['won', 'lost'] } },
          { $set: u },
          session ? { session } : {},
        );
      if (res.matchedCount === 0) {
        return { result: 0, intents: [] };
      }
      let intent: EmitIntent;
      if (result === 'won') {
        intent = {
          type: 'crm.deal.won',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          // Business dedup so a repeated close(won)/retry yields one order (orders listener).
          idempotencyKey: `${id}:${u.wonVersion as number}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            // Links the auto-created sale (orders `crm.deal.won` consumer, §3.4)
            // to the same contact/company/assignee as the deal, so the order is
            // faithful (assignee, contact/company snapshot baseline) — not just a
            // bare product row. Snapshots stay for the deal-level drift record.
            contactId: String(raw?.contactId ?? ''),
            companyId: String(raw?.companyId ?? ''),
            assigneeId: String(raw?.assigneeId ?? ''),
            contactSnapshot: raw?.contactSnapshot ?? null,
            companySnapshot: raw?.companySnapshot ?? null,
            productId: String(raw?.productId ?? ''),
            productName: String(raw?.productName ?? ''),
            amount: Number(current.amount ?? 0),
            currency: String(current.currency ?? 'RUB'),
            wonVersion: u.wonVersion as number,
          },
        };
      } else {
        intent = {
          type: 'crm.deal.lost',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.lost:${id}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            productId: String(raw?.productId ?? ''),
            assigneeId: String(raw?.assigneeId ?? ''),
            lostReasonId: lostReasonId ?? '',
            comment: lostReasonComment ?? '',
          },
        };
      }
      return { result: 1, intents: [intent] };
    });
    if (matched === 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Сделка была закрыта другим процессом',
      });
    }
    return this.getDeal(projectId, id, scope, false, access);
  }

  /** FR-13: reopen a closed deal onto an active stage. manager+ gate enforced upstream. */
  async reopenDeal(
    projectId: string,
    id: string,
    reason: string,
    targetStageId: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const current = await this.getDeal(projectId, id, scope, false, access);
    if (current.status !== 'won' && current.status !== 'lost') {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'Сделка уже открыта' });
    }
    if (!reason?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Укажите причину' });
    }
    const { stage } = await this.resolveStage(projectId, current.pipeline_id, targetStageId);
    if (!stage || (stage.kind && stage.kind !== 'active')) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'targetStageId должен быть активной стадией воронки',
      });
    }
    const now = Date.now();
    const fromStageId = current.stage_id;
    // E3-01 transactional outbox. `crm.deal.reopened` (pipe.md §5.1) is now a registered
    // key (RFC-4 §Р-3, be-event-keys-rfc4): a reopen is a closed(won/lost)→open transition,
    // emitted as its own fact so audit/automation do NOT conflate it with a plain stage move.
    // TOCTOU (#21): only a still-closed deal may reopen; the status invariant lives
    // in the updateOne filter so a concurrent reopen/update loses the race.
    const matched = await this.outbox.withOutbox(async (session) => {
      // TODO-383: archive whatever the bounded push is about to drop (same session).
      await this.evictStageLogOverflow(projectId, id, 1, session);
      const res = await this.mongo.deals().updateOne(
        { _id: new ObjectId(id), projectId, status: { $in: ['won', 'lost'] } },
        {
          $set: {
            status: 'open',
            stageId: targetStageId,
            stageEnteredAt: now,
            updatedAt: now,
            wonAt: 0,
            lostAt: 0,
            lostReasonId: '',
            lostReasonComment: '',
          },
          // TODO-383: `$each` + `$slice` keeps the embedded trail at the last N
          // entries (the dropped head is already archived above).
          $push: {
            stageLog: {
              $each: [
                {
                  stageId: targetStageId,
                  enteredAt: now,
                  movedBy: userId ?? '',
                  kind: 'reopen',
                },
              ],
              $slice: -PipeService.STAGE_LOG_LIMIT,
            },
          },
        },
        session ? { session } : {},
      );
      if (res.matchedCount === 0) {
        return { result: 0, intents: [] };
      }
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.reopened',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.reopened:${id}:${now}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            productId: String(current.product_id ?? ''),
            assigneeId: String(current.assignee_id ?? ''),
            fromStageId,
            toStageId: targetStageId,
            movedBy: userId ?? '',
            reopened: true,
            reason,
          },
        },
      ];
      return { result: res.matchedCount, intents };
    });
    if (matched === 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Сделка была изменена другим процессом',
      });
    }
    return this.getDeal(projectId, id, scope, false, access);
  }

  /** FR-5: attach a contact + snapshot. snapshot fields are resolved upstream (gateway). */
  async linkContact(
    projectId: string,
    id: string,
    contactId: string,
    snapshot: { name?: string; phone?: string; email?: string } | undefined,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    await this.getDeal(projectId, id, scope, false, access);
    if (!contactId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'contactId обязателен' });
    }
    // The snapshot is not decoration: it is the caller's proof that the donor was
    // actually READ (the gateway builds it from `ContactGrpc.GetContact` under the
    // caller's own visibility). Accepting a link without it wrote an empty snapshot,
    // which drift detection later filled with the live contact's name/phone/email —
    // handing PII of an invisible contact to anyone holding `deals:write`. An empty
    // snapshot is therefore no longer a legitimate state. Presence, not content: a
    // genuinely blank contact still arrives as a present (empty) message, while an
    // unset one decodes to undefined (loader without `defaults`, see
    // pipe.proto-contract.spec.ts).
    if (snapshot == null) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'snapshot обязателен: контакт должен быть разрешён вызывающим (gateway)',
      });
    }
    const now = Date.now();
    // E3-01 transactional outbox: link + `crm.contact.deal_attached` row in one
    // session — feeds the contact's deal history (audit/search, RFC-4 Р-3).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.deals().updateOne(
        { _id: new ObjectId(id), projectId },
        {
          $set: {
            contactId,
            contactSnapshot: {
              name: snapshot?.name ?? '',
              phone: snapshot?.phone ?? '',
              email: snapshot?.email ?? '',
              linkedAt: now,
              linkedBy: userId ?? '',
            },
            driftFlag: false,
            driftFields: [],
            updatedAt: now,
          },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.contact.deal_attached',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `contact.deal_attached:${contactId}:${id}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { contactId, dealId: id },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getDeal(projectId, id, scope, false, access);
  }

  /** FR-5: attach a company + snapshot. */
  async linkCompany(
    projectId: string,
    id: string,
    companyId: string,
    snapshot: { name?: string; inn?: string } | undefined,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    await this.getDeal(projectId, id, scope, false, access);
    if (!companyId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'companyId обязателен' });
    }
    // Тот же инвариант, что и в linkContact: нет снимка ⇒ донора не резолвили ⇒ отказ.
    if (snapshot == null) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'snapshot обязателен: компания должна быть разрешена вызывающим (gateway)',
      });
    }
    const now = Date.now();
    // E3-01 transactional outbox: link + drift reset + `crm.company.deal_attached` in one
    // session — mirrors linkContact (TODO-380).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.deals().updateOne(
        { _id: new ObjectId(id), projectId },
        {
          $set: {
            companyId,
            companySnapshot: {
              name: snapshot?.name ?? '',
              inn: snapshot?.inn ?? '',
              linkedAt: now,
              linkedBy: userId ?? '',
            },
            driftFlag: false,
            driftFields: [],
            updatedAt: now,
          },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.company.deal_attached',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `company.deal_attached:${companyId}:${id}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { companyId, dealId: id },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getDeal(projectId, id, scope, false, access);
  }

  /** FR-28: accept drifted contact/company data into the snapshot, archiving the old one. */
  async acceptContactDrift(
    projectId: string,
    id: string,
    target: string | undefined,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    const raw = await this.mongo.deals().findOne({ _id: new ObjectId(id), projectId });
    await this.getDeal(projectId, id, scope, false, access);
    if (!raw?.driftFlag) {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'Нет активного дрейфа' });
    }
    const now = Date.now();
    // TODO-178: "accept the changes" now MATERIALIZES the live values the drift
    // listener recorded in `driftDetail[field].currentValue` onto the snapshot —
    // previously it only cleared the flag, so the card kept showing the stale PII
    // and the very next contact edit re-raised the same drift forever.
    // `target` selects a partial accept: 'contact' | 'company' (anything else = both).
    const wanted = String(target ?? '')
      .trim()
      .toLowerCase();
    const acceptContact = wanted !== 'company';
    const acceptCompany = wanted !== 'contact';
    const detail = (raw.driftDetail as Record<string, unknown> | undefined) ?? {};
    const contactSnapshot: Record<string, unknown> = {
      ...((raw.contactSnapshot as Record<string, unknown> | undefined) ?? {}),
    };
    const companySnapshot: Record<string, unknown> = {
      ...((raw.companySnapshot as Record<string, unknown> | undefined) ?? {}),
    };
    const CONTACT_KEYS = new Set(['name', 'phone', 'email']);
    const accepted: string[] = [];
    const remaining: string[] = [];
    let contactTouched = false;
    let companyTouched = false;
    for (const field of (raw.driftFields as string[] | undefined) ?? []) {
      const isCompany = field.startsWith('company.');
      if (isCompany ? !acceptCompany : !acceptContact) {
        remaining.push(field);
        continue;
      }
      const key = isCompany ? field.slice('company.'.length) : field;
      // Деталь читается по ПУТИ (driftDetailEntry), иначе company-сторона всегда
      // приходила пустой и снимок компании не материализовался (TODO-178).
      const currentValue = driftDetailEntry(detail, field)?.currentValue;
      if (currentValue !== undefined) {
        if (isCompany && key === 'name') {
          companySnapshot.name = String(currentValue ?? '');
          companyTouched = true;
        } else if (!isCompany && CONTACT_KEYS.has(key)) {
          contactSnapshot[key] = String(currentValue ?? '');
          contactTouched = true;
        }
      }
      accepted.push(field);
    }
    if (accepted.length === 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Нет активного дрейфа для указанной стороны',
      });
    }
    if (contactTouched) {
      contactSnapshot.linkedAt = now;
      contactSnapshot.linkedBy = userId ?? '';
    }
    if (companyTouched) {
      companySnapshot.linkedAt = now;
      companySnapshot.linkedBy = userId ?? '';
    }
    // Only the accepted fields leave `driftDetail`; a partial accept keeps the rest
    // pending (and `driftFlag` stays true) instead of silently discarding it.
    // Снимаем ТОЧЕЧНЫМ $unset по тому же пути, каким деталь пишет консьюмер
    // (`driftDetail.company.name`): пересборка всего объекта `driftDetail` по
    // литеральным ключам теряла вложенную company-ветку целиком и вдобавок
    // затирала дрейф, приехавший между чтением и записью.
    const unsetDetail: Record<string, ''> = {};
    for (const field of accepted) unsetDetail[`driftDetail.${field}`] = '';
    const set: Record<string, unknown> = {
      driftFlag: remaining.length > 0,
      driftFields: remaining,
      updatedAt: now,
    };
    if (contactTouched) set.contactSnapshot = contactSnapshot;
    if (companyTouched) set.companySnapshot = companySnapshot;
    // E3-01 transactional outbox: snapshot re-capture + `crm.deal.drift_accepted` in one
    // session. The accept is a legally significant fact with its own registered key
    // (RFC-4 §Р-3, be-event-keys-rfc4; audit chains it via `crm.#`). Prev snapshot archived.
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.deals().updateOne(
        { _id: new ObjectId(id), projectId },
        {
          $set: set,
          $unset: unsetDetail,
          $push: {
            snapshotHistory: {
              contactSnapshot: raw.contactSnapshot,
              companySnapshot: raw.companySnapshot,
              at: now,
            },
          },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.deal.drift_accepted',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.drift_accepted:${id}:${now}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            dealId: id,
            acceptedBy: userId ?? '',
            acceptedFields: accepted,
            target: wanted || 'all',
            pending: remaining,
          },
        },
      ];
      return { result: undefined, intents };
    });
    return this.getDeal(projectId, id, scope, false, access);
  }

  /** FR-DEALS-290: mass accept drift across multiple deals. */
  async bulkAcceptDrift(
    projectId: string,
    dealIds: string[],
    target?: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    if (!Array.isArray(dealIds) || dealIds.length === 0) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'dealIds пуст' });
    }
    const accepted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of dealIds) {
      try {
        await this.acceptContactDrift(projectId, id, target, scope, userId, access);
        accepted.push(id);
      } catch (err) {
        const wrapped = err as { error?: { code?: number }; code?: number };
        const code = wrapped.error?.code ?? wrapped.code;
        if (code === status.NOT_FOUND || code === 5) {
          skipped.push({ id, reason: 'not_visible' });
        } else if (code === status.FAILED_PRECONDITION || code === 9) {
          skipped.push({ id, reason: 'no_drift' });
        } else {
          skipped.push({ id, reason: 'conflict' });
        }
      }
    }
    return { accepted, skipped };
  }

  /**
   * BX-OFFB-2: reassign EVERY deal owned by a departing member (in one project) to
   * the new responsible — the service-triggered offboard cascade (no visibility
   * scope; caller is control via the bus). Emits one `crm.deal.reassigned` per
   * deal so search/denorm/statistics stay in sync — never a blunt `updateMany`
   * without events. Natural idempotency: a redelivery finds nothing still owned by
   * `fromUserId` → 0 reassigned. `offboardTs` keeps the per-record event
   * idempotency keys stable across an at-least-once redelivery.
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
      // rows actually moved (phantom or missed `crm.deal.reassigned`).
      const affected = (await this.mongo
        .deals()
        .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
        .toArray()) as { _id: ObjectId }[];
      if (!affected.length) return { result: undefined, intents: [] };
      const res = await this.mongo
        .deals()
        .updateMany(
          filter,
          { $set: { assigneeId: to, updatedAt: now } },
          session ? { session } : {},
        );
      reassigned = res.modifiedCount;
      const intents: EmitIntent[] = affected.map((d) => {
        const id = d._id.toString();
        return {
          type: 'crm.deal.reassigned',
          source: 'pipe',
          projectId,
          subject: `deal/${id}`,
          idempotencyKey: `deal.reassigned:${id}:${offboardTs}`,
          actorType: 'service',
          payload: { dealId: id, fromOwnerId: from, toOwnerId: to },
        };
      });
      return { result: undefined, intents };
    });
    return { reassigned };
  }

  /** FR-PROJ-215 */
  async countOwnedRecords(projectId: string, userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!projectId || !uid) return 0;
    return this.mongo.deals().countDocuments({ projectId, assigneeId: uid });
  }

  /**
   * FR-33/34: bulk reassign/move. own-only filtering for non-privileged callers is
   * enforced upstream (gateway PEP); here visibility + closed/missing checks gate each item.
   * NFR-DEALS-060: >200 ids → async job.
   */
  async bulkUpdateDeals(
    projectId: string,
    dealIds: string[],
    change: { assigneeId?: string; departmentId?: string; stageId?: string; pipelineId?: string },
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    if (!Array.isArray(dealIds) || dealIds.length === 0) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'dealIds пуст' });
    }
    if (dealIds.length > BULK_SYNC_LIMIT) {
      const jobId = new ObjectId();
      await this.mongo.bulkJobs().insertOne({
        _id: jobId,
        projectId,
        dealIds,
        change,
        visibilityScope: scope,
        userId,
        accessPredicate: access,
        status: 'pending',
        createdAt: Date.now(),
      });
      return { updated: [], skipped: [], async: true, job_id: jobId.toString() };
    }
    const sync = await this.bulkUpdateDealsSync(projectId, dealIds, change, scope, userId, access);
    return { ...sync, async: false, job_id: '' };
  }

  async bulkUpdateDealsSync(
    projectId: string,
    dealIds: string[],
    change: { assigneeId?: string; departmentId?: string; stageId?: string; pipelineId?: string },
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
  ) {
    if (!Array.isArray(dealIds) || dealIds.length === 0) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'dealIds пуст' });
    }
    const keys = Object.entries(change).filter(([, v]) => v != null && v !== '');
    if (keys.length !== 1) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'change: ровно одно поле',
      });
    }
    if (change.assigneeId != null) {
      await this.projectMembers.assertAssigneeMember(projectId, change.assigneeId, userId);
      this.assertAssigneeInScope(change.assigneeId, scope, userId);
    }
    const skipped: { id: string; reason: string }[] = [];
    const now = Date.now();
    // TODO-379 (N+1): malformed ids are filtered out first, then the whole batch is
    // read with ONE `find({_id: {$in}})` instead of a findOne per deal.
    const validIds: string[] = [];
    for (const id of dealIds) {
      if (ObjectId.isValid(id)) validIds.push(id);
      else skipped.push({ id, reason: 'not_visible' });
    }
    // TODO-112: the batch read is the record-read gate of the bulk path — AND the
    // ABAC predicate in at the DB level; excluded deals fall out of `byId` and are
    // reported `not_visible`, exactly like scope-invisible ones.
    const batchAnd: Record<string, unknown>[] = [
      { _id: { $in: validIds.map((i) => new ObjectId(i)) }, projectId },
    ];
    this.applyAccess(batchAnd, access);
    const docs = validIds.length
      ? await this.mongo
          .deals()
          .find((batchAnd.length === 1 ? batchAnd[0] : { $and: batchAnd }) as never)
          .toArray()
      : [];
    const byId = new Map(docs.map((d) => [String(d._id), d]));

    // TODO-190: a bulk funnel switch used to write the new pipelineId and keep the
    // stage of the OLD funnel (the stage check below even validated against the old
    // one) — every moved card fell out of the kanban. The target funnel is resolved
    // and validated ONCE for the batch; each deal lands on its first stage.
    const targetPipelineId = change.pipelineId != null ? String(change.pipelineId) : '';
    let switchStageId = '';
    if (targetPipelineId !== '') {
      const targetPl = await this.mongo.pipelines().findOne({ projectId, id: targetPipelineId });
      if (!targetPl) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'Воронка не найдена в проекте',
        });
      }
      const targetStages = [...((targetPl.stages as PipelineStageDoc[]) ?? [])].sort(
        (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
      );
      if (!targetStages[0]) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'В целевой воронке нет стадий',
        });
      }
      switchStageId = targetStages[0].id;
    }
    // Stage membership per funnel, read once per distinct funnel of the batch
    // (was one `resolveStage` — i.e. one pipelines().findOne — per deal).
    const stageMembers = new Map<string, Set<string>>();
    if (change.stageId != null && change.stageId !== '' && docs.length > 0) {
      const pipelineIds = [...new Set(docs.map((d) => String(d.pipelineId ?? '')).filter(Boolean))];
      const pls = pipelineIds.length
        ? await this.mongo
            .pipelines()
            .find({ projectId, id: { $in: pipelineIds } })
            .toArray()
        : [];
      for (const pl of pls) {
        stageMembers.set(
          String(pl.id),
          new Set(((pl.stages as PipelineStageDoc[]) ?? []).map((s) => s.id)),
        );
      }
    }

    // TODO-379: ONE outbox session for the whole batch — the writes and their events
    // now commit together. Previously every updateOne committed on its own and the
    // events were flushed only after the loop, so a crash in between left deals
    // reassigned/moved with nobody notified (search/audit/automation desynced).
    const applied = await this.outbox.withOutbox(async (session) => {
      const intents: EmitIntent[] = [];
      const updated: string[] = [];
      const skippedInTx: { id: string; reason: string }[] = [];
      const historyRows: Record<string, unknown>[] = [];
      for (const id of validIds) {
        const d = byId.get(id);
        if (!d || d.deletedAt) {
          skippedInTx.push({ id, reason: 'not_visible' });
          continue;
        }
        if (!this.isDealRecordVisible(d, scope, scope?.sharedRecordIds.includes(id) ?? false)) {
          skippedInTx.push({ id, reason: 'not_visible' });
          continue;
        }
        if (scope?.mode !== 'all' && userId && String(d.assigneeId ?? '') !== userId) {
          skippedInTx.push({ id, reason: 'not_visible' });
          continue;
        }
        if (d.status === 'won' || d.status === 'lost') {
          skippedInTx.push({ id, reason: 'closed' });
          continue;
        }
        const u: Record<string, unknown> = { updatedAt: now };
        if (change.assigneeId != null) u.assigneeId = change.assigneeId;
        if (change.departmentId != null) u.departmentId = change.departmentId;
        let movedToStageId = '';
        // Перенос воронки — только для сделок, которые в ней ещё НЕ лежат (тот же
        // noop-контракт, что у одиночного updateDeal: `switchesPipeline`). Иначе
        // батч откатывал уже приехавшие карточки на первую стадию, обнулял
        // stageEnteredAt («время в стадии») и слал ложный crm.deal.stage_changed.
        const switchesPipeline =
          switchStageId !== '' && String(d.pipelineId ?? '') !== targetPipelineId;
        if (switchesPipeline) {
          u.pipelineId = targetPipelineId;
          u.stageId = switchStageId;
          u.stageEnteredAt = now;
          movedToStageId = switchStageId;
        }
        if (change.stageId != null && change.stageId !== '') {
          // `change` несёт РОВНО одно поле (проверка выше), поэтому здесь воронка
          // сделки уже финальная — стадию проверяем по её собственной воронке.
          if (!stageMembers.get(String(d.pipelineId ?? ''))?.has(change.stageId)) {
            skippedInTx.push({ id, reason: 'conflict' });
            continue;
          }
          u.stageId = change.stageId;
          u.stageEnteredAt = now;
          movedToStageId = change.stageId;
        }
        const push = movedToStageId
          ? {
              $push: {
                stageLog: {
                  $each: [
                    {
                      stageId: movedToStageId,
                      enteredAt: now,
                      movedBy: userId ?? '',
                      kind: 'move',
                    },
                  ],
                  // TODO-383: bounded trail; the dropped head goes to history below.
                  $slice: -PipeService.STAGE_LOG_LIMIT,
                },
              },
            }
          : {};
        if (movedToStageId) {
          historyRows.push(
            ...this.stageLogOverflowRows(
              projectId,
              id,
              String(d.pipelineId ?? ''),
              (d.stageLog as DealStageLogEntry[] | undefined) ?? [],
              1,
            ),
          );
          // Закрываем предыдущую ОТКРЫТУЮ запись stageLog перед $push — ровно тот же
          // двухшаговый апдейт, что в одиночном пути (`$set` по stageLog.$[open] и
          // `$push` по stageLog не живут в одном апдейте: конфликт путей в Mongo).
          // Без него батч оставлял в логе 2+ записей без exitedAt, и «время в стадии»
          // (FR-DEALS-190) считалось по пересекающимся интервалам.
          await this.mongo.deals().updateOne(
            { _id: new ObjectId(id), projectId },
            { $set: { 'stageLog.$[open].exitedAt': now } },
            {
              arrayFilters: [
                { 'open.exitedAt': { $exists: false }, 'open.enteredAt': { $lt: now } },
              ],
              ...(session ? { session } : {}),
            },
          );
        }
        await this.mongo
          .deals()
          .updateOne(
            { _id: new ObjectId(id), projectId },
            { $set: u, ...push } as never,
            session ? { session } : {},
          );
        updated.push(id);
        // `crm.deal.bulk_updated` (pipe.md §5.1) is a RESERVED aggregate key (RFC-4 §Р-3,
        // status `planned`, be-event-keys-rfc4): the bulk path deliberately emits per-record
        // SEMANTIC events so consumers keep the richer per-deal detail — assignee change →
        // `crm.deal.reassigned` (X-20 legitimized in RFC-4), stage change → `crm.deal.stage_changed`.
        // No aggregate `bulk_updated` emit today; the key is registered for a future roll-up.
        if (change.assigneeId != null) {
          intents.push({
            type: 'crm.deal.reassigned',
            source: 'pipe',
            projectId,
            subject: `deal/${id}`,
            idempotencyKey: `deal.reassigned:${id}:${now}`,
            userId: userId || undefined,
            actorType: userId ? 'user' : 'service',
            payload: {
              dealId: id,
              fromOwnerId: String(d.assigneeId ?? ''),
              toOwnerId: String(change.assigneeId),
            },
          });
        } else if (movedToStageId) {
          intents.push({
            type: 'crm.deal.stage_changed',
            source: 'pipe',
            projectId,
            subject: `deal/${id}`,
            idempotencyKey: `deal.stage_changed:${id}:${now}`,
            userId: userId || undefined,
            actorType: userId ? 'user' : 'service',
            payload: {
              dealId: id,
              fromStageId: String(d.stageId ?? ''),
              toStageId: movedToStageId,
              ...(switchesPipeline
                ? {
                    fromPipelineId: String(d.pipelineId ?? ''),
                    toPipelineId: targetPipelineId,
                  }
                : {}),
              movedBy: userId ?? '',
            },
          });
        }
      }
      if (historyRows.length > 0) {
        await this.mongo.dealStageHistory().insertMany(historyRows, session ? { session } : {});
      }
      return { result: { updated, skippedInTx }, intents };
    });
    return { updated: applied.updated, skipped: [...skipped, ...applied.skippedInTx] };
  }

  // ---------------------------------------------------------------------------
  // Pipelines CRUD (FR-20/21/22)
  // ---------------------------------------------------------------------------

  private normalizeStages(stages?: Record<string, unknown>[]): PipelineStageDoc[] {
    return (stages ?? []).map((s, i) => ({
      id: String(s.id ?? new ObjectId().toString()),
      name: String(s.name ?? ''),
      color: String(s.color ?? '#3b82f6'),
      order: Number(s.order ?? i),
      kind: String(s.kind ?? 'active'),
      probability: Number(s.probability ?? 0),
      rottingDays: Number(s.rotting_days ?? 0),
    }));
  }

  /** FR-DEALS-220: reject cyclic or invalid auto-transition graphs at save time. */
  private assertValidAutoTransitions(
    stages: PipelineStageDoc[],
    rawTransitions: unknown,
  ): { fromStageId: string; toStageId: string }[] {
    const transitions = normalizeAutoTransitions(rawTransitions);
    const issue = validateAutoTransitions(
      stages.map((s) => s.id),
      transitions,
    );
    if (issue?.code === 'CYCLE') {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Цикл в авто-переходах стадий',
        details: { path: issue.path },
      });
    }
    if (issue?.code === 'SAME_STAGE') {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Авто-переход не может вести в ту же стадию',
      });
    }
    if (issue?.code === 'UNKNOWN_STAGE') {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `Неизвестная стадия в авто-переходе: ${issue.stageId}`,
      });
    }
    return transitions;
  }

  /**
   * Run a default-pipeline switch atomically (#21): the "demote current default"
   * and the "promote the new one" writes must commit together so a project never
   * ends up with zero or two default pipelines. Falls back to sequential writes on
   * a standalone Mongo without transaction support (best-effort, like the outbox).
   */
  private async withDefaultSwitchTx(
    work: (session?: ClientSession) => Promise<void>,
  ): Promise<void> {
    const session = this.mongo.getClient().startSession();
    try {
      await session.withTransaction(async () => {
        await work(session);
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const noTx =
        msg.includes('Transaction numbers') ||
        msg.includes('replica set') ||
        msg.includes('not supported') ||
        msg.includes('IllegalOperation') ||
        msg.includes('mongos');
      if (!noTx) throw err;
    } finally {
      await session.endSession();
    }
    await work(undefined);
  }

  async createPipeline(projectId: string, data: Record<string, unknown>) {
    if (!String(data.name ?? '').trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Имя обязательно' });
    }
    const id = new ObjectId().toString();
    const isDefault = !!data.is_default;
    const stages = this.normalizeStages(data.stages as Record<string, unknown>[]);
    const autoTransitions =
      data.auto_transitions != null
        ? this.assertValidAutoTransitions(stages, data.auto_transitions)
        : [];
    const insert = {
      _id: new ObjectId(),
      id,
      projectId,
      name: String(data.name),
      isDefault,
      debounceMs: Number(data.debounce_ms ?? 5000),
      defaultRottingDays: Number(data.default_rotting_days ?? 0),
      stages,
      autoTransitions,
    };
    if (isDefault) {
      await this.withDefaultSwitchTx(async (session) => {
        await this.mongo
          .pipelines()
          .updateMany(
            { projectId, isDefault: true },
            { $set: { isDefault: false } },
            session ? { session } : {},
          );
        await this.mongo.pipelines().insertOne(insert, session ? { session } : {});
      });
    } else {
      await this.mongo.pipelines().insertOne(insert);
    }
    const doc = await this.mongo.pipelines().findOne({ projectId, id });
    return this.toPipeline(doc as Record<string, unknown>);
  }

  async updatePipeline(projectId: string, id: string, data: Record<string, unknown>) {
    const existing = await this.mongo.pipelines().findOne({ projectId, id });
    if (!existing) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const u: Record<string, unknown> = {};
    if (data.name != null) u.name = data.name;
    if (data.debounce_ms != null) u.debounceMs = data.debounce_ms;
    if (data.default_rotting_days != null) u.defaultRottingDays = data.default_rotting_days;
    if (data.stages != null) {
      const nextStages = this.normalizeStages(data.stages as Record<string, unknown>[]);
      // TODO-181: the stage array used to be overwritten wholesale — deleting a stage
      // in the funnel editor orphaned every deal standing on it (the card kept a
      // stageId no column matches: invisible on the kanban, raw id in the list).
      // Same guard `deletePipeline` already had, one level down: a stage that still
      // holds live deals cannot be removed; the UI gets the blocking counts.
      const nextIds = new Set(nextStages.map((s) => s.id));
      const removed = ((existing.stages as PipelineStageDoc[] | undefined) ?? [])
        .map((s) => s.id)
        .filter((sid) => !nextIds.has(sid));
      const blocking: { stageId: string; count: number }[] = [];
      for (const stageId of removed) {
        const count = await this.mongo.deals().countDocuments({
          projectId,
          pipelineId: id,
          stageId,
          deletedAt: { $in: [null, undefined] },
        });
        if (count > 0) blocking.push({ stageId, count });
      }
      if (blocking.length > 0) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'Нельзя удалить стадию с активными сделками',
          details: { pipelineId: id, stages: blocking },
        });
      }
      u.stages = nextStages;
    }
    if (data.auto_transitions != null) {
      const stageSet =
        (u.stages as PipelineStageDoc[] | undefined) ??
        (existing.stages as PipelineStageDoc[] | undefined) ??
        [];
      u.autoTransitions = this.assertValidAutoTransitions(stageSet, data.auto_transitions);
    }
    if (data.is_default === true) {
      u.isDefault = true;
      await this.withDefaultSwitchTx(async (session) => {
        await this.mongo
          .pipelines()
          .updateMany(
            { projectId, isDefault: true },
            { $set: { isDefault: false } },
            session ? { session } : {},
          );
        await this.mongo
          .pipelines()
          .updateOne({ projectId, id }, { $set: u }, session ? { session } : {});
      });
    } else {
      await this.mongo.pipelines().updateOne({ projectId, id }, { $set: u });
    }
    const doc = await this.mongo.pipelines().findOne({ projectId, id });
    return this.toPipeline(doc as Record<string, unknown>);
  }

  async deletePipeline(projectId: string, id: string) {
    const total = await this.mongo.pipelines().countDocuments({ projectId });
    if (total <= 1) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Нельзя удалить единственную воронку',
      });
    }
    // FR-21: guard against orphaning active deals.
    const active = await this.mongo
      .deals()
      .countDocuments({ projectId, pipelineId: id, deletedAt: { $in: [null, undefined] } });
    if (active > 0) {
      // FR-21: surface the blocking count so the UI can offer to move deals first.
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Нельзя удалить воронку с активными сделками',
        details: { pipelineId: id, count: active },
      });
    }
    await this.mongo.pipelines().deleteOne({ projectId, id });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Deal sources CRUD (FR-23)
  // ---------------------------------------------------------------------------

  async createDealSource(projectId: string, name: string, color: string) {
    if (!name?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Имя обязательно' });
    }
    const dup = await this.mongo.dealSources().findOne({ projectId, name });
    if (dup) {
      throw new RpcException({ code: status.ALREADY_EXISTS, message: 'Источник уже существует' });
    }
    const id = new ObjectId().toString();
    await this.mongo
      .dealSources()
      .insertOne({ _id: new ObjectId(), id, projectId, name, color: color ?? '#6366f1' });
    return { id, name, color: color ?? '#6366f1' };
  }

  async updateDealSource(projectId: string, id: string, name?: string, color?: string) {
    const existing = await this.mongo.dealSources().findOne({ projectId, id });
    if (!existing) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    if (name != null && String(name).trim() !== '' && String(name) !== String(existing.name)) {
      const inUse = await this.mongo.deals().countDocuments({
        projectId,
        source: String(existing.name),
        deletedAt: { $in: [null, undefined] },
      });
      if (inUse > 0) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION,
          message: 'Источник используется в сделках — переименование запрещено',
        });
      }
    }
    const u: Record<string, unknown> = {};
    if (name != null) u.name = name;
    if (color != null) u.color = color;
    await this.mongo.dealSources().updateOne({ projectId, id }, { $set: u });
    const doc = await this.mongo.dealSources().findOne({ projectId, id });
    return { id, name: String(doc?.name), color: String(doc?.color) };
  }

  async deleteDealSource(projectId: string, id: string) {
    const existing = await this.mongo.dealSources().findOne({ projectId, id });
    if (!existing) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const inUse = await this.mongo.deals().countDocuments({
      projectId,
      source: String(existing.name),
      deletedAt: { $in: [null, undefined] },
    });
    if (inUse > 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Источник используется в сделках',
      });
    }
    await this.mongo.dealSources().deleteOne({ projectId, id });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Lost reasons CRUD (FR-24)
  // ---------------------------------------------------------------------------

  async listLostReasons(projectId: string, activeOnly?: boolean) {
    const filter: Record<string, unknown> = { projectId };
    if (activeOnly) filter.active = true;
    const rows = await this.mongo.lostReasons().find(filter).sort({ order: 1 }).toArray();
    return {
      list: rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        order: Number(r.order ?? 0),
        active: r.active !== false,
      })),
    };
  }

  async createLostReason(projectId: string, name: string, order?: number, active?: boolean) {
    if (!name?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Имя обязательно' });
    }
    const dup = await this.mongo.lostReasons().findOne({ projectId, name });
    if (dup) {
      throw new RpcException({ code: status.ALREADY_EXISTS, message: 'Причина уже существует' });
    }
    const id = new ObjectId().toString();
    await this.mongo.lostReasons().insertOne({
      _id: new ObjectId(),
      id,
      projectId,
      name,
      order: Number(order ?? 0),
      active: active !== false,
    });
    return { id, name, order: Number(order ?? 0), active: active !== false };
  }

  async updateLostReason(
    projectId: string,
    id: string,
    name?: string,
    order?: number,
    active?: boolean,
  ) {
    const existing = await this.mongo.lostReasons().findOne({ projectId, id });
    if (!existing) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const u: Record<string, unknown> = {};
    if (name != null) u.name = name;
    if (order != null) u.order = order;
    if (active != null) u.active = active;
    await this.mongo.lostReasons().updateOne({ projectId, id }, { $set: u });
    const doc = await this.mongo.lostReasons().findOne({ projectId, id });
    return {
      id,
      name: String(doc?.name),
      order: Number(doc?.order ?? 0),
      active: doc?.active !== false,
    };
  }

  async deleteLostReason(projectId: string, id: string) {
    // Deactivation is preferred to keep references intact; hard delete supported too.
    await this.mongo.lostReasons().deleteOne({ projectId, id });
    return { ok: true };
  }

  /**
   * TODO-170 / FR-CONTACTS-210: when contacts merge, deals still linked to the
   * source tombstone must be repointed at the surviving contact. Emits one
   * `crm.deal.updated` per moved row (same contract as a manual contact edit).
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
      let moved = 0;
      const intents: EmitIntent[] = [];
      for (const sourceId of sources) {
        const filter = { projectId, contactId: sourceId };
        const affected = await this.mongo
          .deals()
          .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
          .toArray();
        if (affected.length === 0) continue;
        const res = await this.mongo
          .deals()
          .updateMany(
            filter,
            { $set: { contactId: target, updatedAt: now } },
            session ? { session } : {},
          );
        moved += res.modifiedCount;
        for (const doc of affected) {
          const dealId = (doc as { _id: ObjectId })._id.toString();
          intents.push({
            type: 'crm.deal.updated',
            source: 'pipe',
            projectId,
            subject: `deal/${dealId}`,
            idempotencyKey: `deal.contact_merged:${dealId}:${mergeIdempotencyKey}`,
            actorType: 'service',
            payload: {
              dealId,
              changed: ['contactId'],
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
   * FR-COMPANIES-140: when companies merge, deals still linked to the loser
   * tombstone must be repointed at the surviving master. Emits one
   * `crm.deal.updated` per moved row (same contract as a manual company edit).
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
        .deals()
        .find(filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })
        .toArray();
      if (affected.length === 0) return { result: 0, intents: [] };
      const res = await this.mongo
        .deals()
        .updateMany(
          filter,
          { $set: { companyId: master, updatedAt: now } },
          session ? { session } : {},
        );
      moved += res.modifiedCount;
      for (const doc of affected) {
        const dealId = (doc as { _id: ObjectId })._id.toString();
        intents.push({
          type: 'crm.deal.updated',
          source: 'pipe',
          projectId,
          subject: `deal/${dealId}`,
          idempotencyKey: `deal.company_merged:${dealId}:${mergeIdempotencyKey}`,
          actorType: 'service',
          payload: {
            dealId,
            changed: ['companyId'],
            before: { companyId: loser },
            after: { companyId: master },
          },
        });
      }
      return { result: moved, intents };
    });
    return { rewritten };
  }
}
