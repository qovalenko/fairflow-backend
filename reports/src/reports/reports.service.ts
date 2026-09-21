import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { firstValueFrom, timeout } from 'rxjs';
import {
  buildServiceOutboundMetadata,
  buildVisibilityFilter,
  serializeVisibilityScope,
  serializeCompiledPredicate,
  GW_METADATA,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { StatisticsRollupStore } from '../rollup/statistics-rollup.store';
import { StatisticsRollupCoverageStore } from '../rollup/statistics-rollup-coverage';
import {
  canUseRollupRead,
  rollupSalesSeries,
  rollupTrustedForRange,
  sumRollupMetric,
  utcDayOf,
} from '../rollup/statistics-rollup-read';
import { StageTransitionsStore } from '../stage-transitions/stage-transitions.store';
import type { AggregateAccessPredicate } from './access-predicate-bundle';
import {
  catalogForRun,
  DEPARTMENT_BENCHMARK_MANAGER_ID,
} from './reports-preset-catalog';
import {
  accessCacheKey,
  buildAggregateCacheKey,
  dashboardCacheMaxEntries,
  dashboardCacheTtlMs,
  modulesCacheKey,
  StatisticsAggregateCache,
  type DashboardAggregate,
} from './statistics-aggregate-cache';

type ReportDoc = {
  _id: ObjectId;
  projectId: string;
  name: string;
  description: string;
  kind: string;
  /** builtin presetKey (sales/funnel/...) or null for custom. */
  presetKey?: string | null;
  /** declarative ReportSpec (FR-MREP-10), serialized opaque object. */
  spec?: Record<string, unknown> | null;
  /**
   * TODO-466 (FR-REPORTS-390): уровень доступа ОПРЕДЕЛЕНИЯ отчёта —
   * 'personal' (виден только автору) | 'project' (виден участникам проекта).
   * Отсутствующее/иное значение читается как 'project': ровно так вели себя все
   * документы до правки, поэтому апгрейд ничего не прячет задним числом.
   */
  visibility?: string | null;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

/**
 * TODO-466: закрытый словарь уровней доступа определения отчёта. Единственное
 * «сужающее» значение — 'personal'; всё прочее (включая пустую строку с
 * провода, `null` и легаси-документы без поля) — 'project'.
 */
const REPORT_VISIBILITY_PERSONAL = 'personal';
const REPORT_VISIBILITY_PROJECT = 'project';

/** Значение из документа/запроса → значение словаря. Нераспознанное → 'project'. */
function normalizeReportVisibility(v: unknown): string {
  return typeof v === 'string' && v.trim() === REPORT_VISIBILITY_PERSONAL
    ? REPORT_VISIBILITY_PERSONAL
    : REPORT_VISIBILITY_PROJECT;
}

/**
 * Closed vocabulary of run/drill/export `params_json` (P2.f). Every field is
 * optional; unknown keys are dropped by {@link ReportsService.parseParams} and a
 * present-but-wrong-typed known key raises INVALID_ARGUMENT.
 */
interface ReportParams {
  /** period preset ('today'|'week'|'month'|'quarter'|'year'|'custom'). */
  period?: string;
  /** custom-window bounds (epoch ms). `customFrom/customTo` is the FE spelling. */
  from?: number;
  to?: number;
  customFrom?: number;
  customTo?: number;
  /** narrow to one pipeline / one stage. */
  pipelineId?: string;
  stageId?: string;
  /** narrow to a set of managers / one department / one source (never widens). */
  managerIds?: string[];
  departmentId?: string;
  source?: string;
  /** Порог «зависшей» сделки в днях (openapi RunParams.stalledDays, FR-REPORTS-140). */
  stalledDays?: number;
  /** NFR-020: страница агрегатных строк (0-based). */
  pageIndex?: number;
  /** NFR-020: размер страницы агрегата (1..100). */
  pageSize?: number;
  /** FR-REPORTS-380: контекст мини-отчёта в карточке сущности. */
  entityType?: string;
  entityId?: string;
}

/** Модули-источники встроенного пресета (FR-REPORTS-190 / FE PRESETS.requiresModulesAny). */
const PRESET_SOURCE_MODULES: Record<string, { allOf?: string[]; anyOf?: string[] }> = {
  sales: { allOf: ['deals'] },
  funnel: { allOf: ['deals'] },
  clients: { anyOf: ['contacts', 'companies'] },
  activity: { allOf: ['activities'] },
  sources: { allOf: ['deals'] },
  by_managers: { allOf: ['deals'] },
  my_overdue: { anyOf: ['activities', 'deals'] },
};

/** Source entity of an aggregation — decides which owner/date fields a filter uses. */
type SourceEntity = 'deals' | 'orders' | 'contacts' | 'companies' | 'activities';

/** Одна воронка из `PipeGrpc.ListPipelines` (только нужные поля контракта). */
interface PipelineRow {
  id?: string;
  name?: string;
  is_default?: boolean;
  stages?: Array<{ id?: string; name?: string; order?: number; kind?: string }>;
}

/** stageId → место в воронке (порядок для сортировки, имя для подписи). */
type StageMap = Map<string, { name: string; order: number }>;

/**
 * Owner field per source domain (matches each domain's OWNER_FIELD). reports
 * pushes the viewer's visibility scope into the `$match` of every aggregation
 * (FR-MREP-2): scope is the FIRST stage, before `$group`.
 */
const OWNER_FIELD: Record<string, string> = {
  deals: 'assigneeId',
  orders: 'assigneeId',
  contacts: 'ownerId',
  companies: 'ownerId',
  // activity владеет полем assigneeId (activity.service.ts:16 OWNER_FIELD) —
  // предикат видимости по несуществующему ownerId матчил ноль записей.
  activities: 'assigneeId',
};

/**
 * Terminal activity statuses — copied from the activity domain
 * (`activity/src/activity/activity.service.ts:20 TERMINAL`). «Просроченные» и
 * «ближайшие» считаются по НЕтерминальным статусам; набор нельзя угадывать.
 */
const ACTIVITY_TERMINAL = ['completed', 'cancelled'];

/**
 * Order statuses that mean «в работе» — copied from the orders domain
 * (`orders/src/orders/orders.service.ts:27 ACTIVE_STATUSES`). Без этого фильтра
 * KPI «Продажи в работе» считал в том числе CANCELLED/DONE.
 */
const ORDER_ACTIVE_STATUSES = ['ACTIVE', 'SENDING', 'SEND_ERROR'];

/** Closed deal statuses (pipe closeDeal writes status win/lose) — FR-MSTAT-5. */
const DEAL_CLOSED_STATUSES = ['won', 'lost'];

/**
 * Потолок набора «контакты, у которых есть сделка» в пресете `clients`.
 * Метрика «контакты без сделок» справочная, и ради неё нельзя тянуть в память
 * неограниченный список идентификаторов: набор больше предела → метрика не
 * отдаётся вовсе (лучше без цифры, чем цифра по обрезанному набору).
 */
const CLIENTS_LINKED_LIMIT = 5_000;

/**
 * NFR-020 (statistics canon §NFR-020): per-metric-block time budget. When a
 * provider block exceeds the deadline it is dropped (fallback) and the aggregate
 * is marked `partial=true` — never hang the dashboard waiting on one slice.
 */
const METRIC_BLOCK_DEADLINE_MS = Number(process.env.REPORTS_METRIC_BLOCK_MS) || 8_000;

async function withMetricDeadline<T>(
  fn: () => Promise<T>,
  ms = METRIC_BLOCK_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(fn);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`metric block deadline exceeded (${ms}ms)`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Deadline won → `fn()` is still running. Attach a handler so a later
    // reject does not surface as an unhandledRejection (Node may abort).
    void work.catch(() => undefined);
  }
}

/**
 * TODO-467: indexable overdue predicate — `$expr` + `$ifNull` is not covered by
 * compound indexes on `dueDate`/`due_date`. Match any canonical due field in range.
 */
function overdueDueMatch(now: number): Record<string, unknown> {
  const inPast = { $gt: 0, $lt: now };
  return {
    $or: [{ dueDate: inPast }, { due_date: inPast }, { dueAt: inPast }],
  };
}

/**
 * Табличные срезы в CSV-экспорте: `[секция, поле-измерение, числовые колонки]`.
 * Формат строки прежний — `section,key,value` с двоеточием между числами, — так
 * что уже написанные парсеры выгрузки не ломаются, а новые секции просто
 * добавляются в конец файла.
 */
const CSV_PRESET_SECTIONS: Array<[string, string, string[]]> = [
  ['sales_dynamics', 'bucket', ['count', 'amount']],
  ['funnel_stages', 'stage_id', ['count', 'amount', 'conversion', 'stalled']],
  ['top_companies', 'company_id', ['count', 'amount']],
  ['activities_by_type', 'type', ['count', 'completed', 'overdue', 'open']],
  ['activities_by_manager', 'manager_id', ['count', 'completed', 'overdue', 'open']],
  ['deals_by_source', 'source', ['count', 'amount', 'won', 'conversion', 'avg_check']],
  ['deals_by_manager', 'manager_id', ['count', 'amount', 'won', 'lost']],
  ['deals_by_department', 'department_id', ['count', 'amount', 'won', 'lost', 'conversion']],
  ['my_overdue_activities', 'activity_id', ['due_at']],
  ['my_inactive_deals', 'deal_id', ['amount', 'days_inactive']],
];

/** Скалярные блоки пресетов — выгружаются как `totals` (ключ → значение). */
const CSV_PRESET_TOTALS = [
  'sales_totals',
  'clients_totals',
  'activity_totals',
  'my_overdue_totals',
];

/** NFR-020: основной массив групп пресета для пагинации в `run()`. */
const PRESET_AGGREGATE_ROWS: Record<string, string> = {
  sales: 'sales_dynamics',
  funnel: 'funnel_stages',
  clients: 'top_companies',
  activity: 'activities_by_type',
  sources: 'deals_by_source',
  by_managers: 'deals_by_manager',
  my_overdue: 'my_overdue_activities',
};

/**
 * Пустая корзина среза: у документа нет значения НИ в одном из написаний поля.
 * `{ $in: [null, ''] }` матчит null, отсутствующее поле и пустую строку; связка
 * через `$and` — зеркало группировок `$ifNull(a, b, '')`: в корзину `''` документ
 * попадает, только когда пусты ОБА поля (иначе он уже в корзине непустого).
 */
const noneOf = (...fields: string[]): Record<string, unknown> => ({
  $and: fields.map((f) => ({ [f]: { $in: [null, ''] } })),
});

/**
 * Измерения, по которым домен умеет разворачивать ячейку отчёта в список записей
 * (`drill`). У каждого измерения — своя сущность-источник: сделки, активности
 * и т.д. Сравнение — обычным `$or` по обоим написаниям поля: `$expr`
 * планировщик Mongo не покрывает индексом (TODO-467).
 *
 * Пустое значение = клик по корзине «без значения» (`$ifNull(..., '')` в
 * группировках срезов) — матчим документы, где пусты оба написания поля, иначе
 * drill по этой строке возвращал бы пусто при ненулевом агрегате.
 *
 * Набор — контракт с фронтом: таблица пресета кликабельна ровно тогда, когда её
 * `primaryDimension` есть здесь (иначе клик уходил бы в INVALID_ARGUMENT).
 */
const DRILL_DIMENSIONS: Record<
  string,
  { entity: SourceEntity; match: (value: string) => Record<string, unknown> }
> = {
  stage_id: {
    entity: 'deals',
    match: (v) =>
      v.trim() ? { $or: [{ stageId: v }, { stage_id: v }] } : noneOf('stageId', 'stage_id'),
  },
  stageId: {
    entity: 'deals',
    match: (v) =>
      v.trim() ? { $or: [{ stageId: v }, { stage_id: v }] } : noneOf('stageId', 'stage_id'),
  },
  manager_id: {
    entity: 'deals',
    match: (v) =>
      v.trim() ? { $or: [{ assigneeId: v }, { ownerId: v }] } : noneOf('assigneeId', 'ownerId'),
  },
  department_id: {
    entity: 'deals',
    match: (v) =>
      v.trim()
        ? { $or: [{ departmentId: v }, { department_id: v }] }
        : noneOf('departmentId', 'department_id'),
  },
  source: {
    entity: 'deals',
    match: (v) =>
      v.trim() ? { $or: [{ sourceId: v }, { source: v }] } : noneOf('sourceId', 'source'),
  },
  company_id: {
    entity: 'deals',
    match: (v) =>
      v.trim()
        ? { $or: [{ companyId: v }, { company_id: v }] }
        : noneOf('companyId', 'company_id'),
  },
  type: {
    entity: 'activities',
    // Зеркало группировки `$ifNull ['$type', 'task']` (activitySlice): корзина
    // «task» включает и документы без типа (`$in: [null]` матчит null и
    // отсутствующее поле); прочие значения — как есть.
    match: (v) => (v.trim() === 'task' ? { type: { $in: [null, 'task'] } } : { type: v }),
  },
  activity_manager_id: {
    entity: 'activities',
    match: (v) =>
      v.trim() ? { $or: [{ assigneeId: v }, { ownerId: v }] } : noneOf('assigneeId', 'ownerId'),
  },
};

/**
 * Усечение списков дашборда (FR-MSTAT-12/30): просроченные/предстоящие/зависшие
 * — 5 строк, недавние — 10. Рядом с каждым усечённым списком отдаётся его полный
 * размер (`*_total`, TODO-498), иначе виджет не может показать «+ ещё N».
 */
/**
 * FR-STAT-360: порог свёртки среза «команда» в подразделения. Наблюдатель,
 * которому видно больше N_OWNER владельцев (руководитель региона, топ), получает
 * пофамильный список, который невозможно ни отрисовать, ни осмыслить, — и цена
 * которого линейна по размеру организации. За порогом та же выборка группируется
 * по departmentId: строк столько, сколько подразделений.
 */
const N_OWNER = 1000;

const DASHBOARD_LIST_LIMIT = 5;
const DASHBOARD_RECENT_LIMIT = 10;

/**
 * Встроенные пресеты отчётов (ключи = `PresetKey` фронта: sales/funnel/clients/
 * activity/sources/by_managers). `presetKey` — то, по чему фронт сопоставляет
 * вкладку с определением отчёта, и то, по чему {@link ReportsService.isBuiltin}
 * защищает пресет от переименования/удаления. `legacyKind` — вид, которым сид
 * писал документ ДО появления presetKey: такие документы лечатся на месте.
 */
const BUILTIN_PRESETS: Array<{
  presetKey: string;
  name: string;
  description: string;
  legacyKind?: string;
}> = [
  {
    presetKey: 'sales',
    name: 'По продажам',
    description: 'Сводка по сделкам и продажам за период',
    legacyKind: 'sales_snapshot',
  },
  {
    presetKey: 'funnel',
    name: 'По воронке',
    description: 'Сделки по стадиям воронки с конверсией',
    legacyKind: 'deals_by_stage',
  },
  {
    presetKey: 'clients',
    name: 'По клиентам',
    description: 'Покрытие контактами и компаниями',
    legacyKind: 'crm_coverage',
  },
  {
    presetKey: 'activity',
    name: 'По активности',
    description: 'Активность менеджеров по задачам и сделкам',
  },
  {
    presetKey: 'sources',
    name: 'По источникам',
    description: 'Распределение сделок по источникам',
  },
  {
    presetKey: 'by_managers',
    name: 'По менеджерам',
    description: 'Сделки и выручка в разрезе менеджеров и отделов',
  },
  {
    presetKey: 'my_overdue',
    name: 'Мои просрочки',
    description: 'Персональный срез: просроченные активности и сделки без активности',
  },
];

/** Visibility-level → human label for the "viewing: …" UI hint (FR-MSTAT-26). */
const SCOPE_LEVEL_LABEL: Record<string, string> = {
  all: 'весь проект',
  own_and_department: 'мой отдел',
  own_and_subordinates: 'я и подчинённые',
  own_and_shared: 'мои и доступные',
  only_own: 'только мои',
};

/** Resolved [from, to) window in epoch ms for a dashboard period (FR-MSTAT-7). */
type PeriodRange = { period: string; from: number; to: number };

/**
 * Escape user input before it goes into a RegExp (avoids ReDoS / regex injection
 * via the `query` filter — reports.md §3.1 S3 / OQ-REP-7). Length is also capped
 * by the caller to bound backtracking.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly logger = new Logger(ReportsService.name);

  /**
   * pipe-домен — порядок и имена стадий воронки (FR-MSTAT-17 funnel / FR-MREP-11).
   * contact-домен — агрегаты качества базы для среза clients (FR-CONTACTS-440).
   * Остальные агрегации идут по общим Mongo-вьюхам.
   */
  private pipe!: {
    listPipelines(
      d: { project_id: string },
      metadata?: Metadata,
    ): import('rxjs').Observable<{ list?: PipelineRow[] }>;
  };

  private contactGrpc!: {
    getContactQualityMetrics(
      d: { project_id: string },
      metadata?: Metadata,
    ): import('rxjs').Observable<{
      total_contacts?: number;
      filled_both_pct?: number;
      duplicate_candidate_pairs?: number;
      open_drift_links?: number;
    }>;
  };

  /** Кэш карты стадий на проект (порядок/имена меняются редко). */
  private readonly stageCache = new Map<string, { at: number; stages: StageMap }>();
  private readonly stageCacheTtlMs = Number(process.env.REPORTS_STAGE_CACHE_TTL_MS ?? 60_000);
  /** NFR-050: кэш агрегатов прогона (ключ включает scopeHash). */
  private readonly aggregateCache = new Map<string, { at: number; payload: Record<string, unknown> }>();
  private readonly aggregateCacheTtlMs = Number(
    process.env.REPORTS_AGGREGATE_CACHE_TTL_MS ?? 60_000,
  );
  /**
   * FR-MSTAT-18 / FR-STAT-350: response-cache дашборда по
   * `(projectId, metric=dashboard, scopeHash, period)` (NFR-MSTAT-2 TTL ~60 с).
   */
  private readonly dashboardCache = new StatisticsAggregateCache<DashboardAggregate>(
    dashboardCacheTtlMs(),
    dashboardCacheMaxEntries(),
  );
  /** Окно «не ходить в pipe» после неудачи (fail-soft, без штурма недоступного домена). */
  private stageFailUntil = 0;
  private readonly stageFailCooldownMs = Number(process.env.REPORTS_STAGE_FAIL_COOLDOWN_MS ?? 10_000);

  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('CONTACT_GRPC') private readonly contactClient: ClientGrpcProxy,
    private readonly rollupStore: StatisticsRollupStore,
    private readonly rollupCoverage: StatisticsRollupCoverageStore,
    private readonly stageTransitions: StageTransitionsStore,
  ) {}

  /**
   * Stable, low-cardinality hash of the viewer's visibility scope for the event
   * payload (no PII, no record ids) — lets consumers correlate runs by scope
   * without leaking who-sees-what (RFC-4 §Р-1 "no secrets").
   */
  /**
   * TODO-475: детерминированный ключ дедупликации факта аудита. Собирается из
   * полей, одинаковых у любого повтора ОДНОГО вызова: тип факта, отчёт, срез
   * видимости и `callId` — серверный `x-gw-call-id`, который gateway чеканит
   * (randomUUID) на КАЖДЫЙ исходящий вызов и который клиент подделать не может.
   *
   * Клиентские `x-request-id`/`idempotency-key` сюда попадать не должны: audit
   * дедуплицирует по этому ключу против ledger'а с TTL 7 суток, и фиксированный
   * клиентский заголовок схлопнул бы сотню осознанных выгрузок в один факт
   * `statistics.exported` (регресс неотказуемости FR-MSTAT-23).
   *
   * Без callId ключа нет — шина падает на messageId, то есть на прежнее «каждый
   * вызов уникален» (лучше дубль факта, чем пропавший факт).
   */
  private factKey(
    type: 'report.generated' | 'statistics.exported',
    reportId: string,
    scope: VisibilityScope,
    callId?: string,
    suffix?: string,
  ): string | undefined {
    const cid = callId?.trim();
    if (!cid) return undefined;
    const tail = suffix ? `:${suffix}` : '';
    return `${type}:${reportId}:${this.scopeHash(scope)}:${cid}${tail}`;
  }

  private scopeHash(scope: VisibilityScope): string {
    const owners = [...scope.ownerIds].sort().join(',');
    const shared = [...scope.sharedRecordIds].sort().join(',');
    let h = 0;
    const s = `${scope.level}|${scope.mode}|${owners}|${shared}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  /**
   * Emit a `report.*` fact via the transactional outbox (RFC-4 §Р-3, E3-01).
   * Best-effort & non-blocking for the caller: a broker/outbox hiccup must never
   * fail the report (the user already got their data) — the emit is logged and
   * swallowed. The routing-key is validated by `buildOutboxRow` (illegal key
   * throws and is caught here).
   */
  private async emit(
    type: 'report.generated' | 'statistics.exported',
    projectId: string,
    reportId: string,
    payload: Record<string, unknown>,
    userId?: string,
    // TODO-475: ключ дедупликации собирается ВЫЗЫВАЮЩИМ из детерминированных
    // полей вызова (см. factKey). `Date.now()` внутри emit() делал
    // ключ уникальным на каждый вызов: повтор ОДНОГО И ТОГО ЖЕ прогона (ретрай
    // транспорта) уезжал в аудит вторым фактом. `undefined` — легальное
    // значение: шина падает обратно на messageId (shared/src/outbox.ts:149),
    // то есть ровно на прежнее поведение «каждый вызов уникален».
    idempotencyKey?: string,
  ): Promise<void> {
    try {
      await this.outbox.enqueue({
        type,
        source: 'reports',
        projectId,
        subject: `report/${reportId}`,
        idempotencyKey,
        userId: userId || undefined,
        actorType: userId ? 'user' : 'system',
        payload,
      });
    } catch (err) {
      // Non-fatal: data was already returned to the caller. НО молчать нельзя —
      // без строки в логе потерянный факт аудита невозможно расследовать.
      this.logger.warn(
        `outbox enqueue failed: type=${type} project=${projectId} report=${reportId}: ${String(err)}`,
      );
    }
  }

  onModuleInit() {
    this.pipe = this.pipeClient.getService('PipeGrpc');
    this.contactGrpc = this.contactClient.getService('ContactGrpc');
    // TODO-463: индексы коллекции определений. Fire-and-forget: их отсутствие не
    // должно ронять старт сервиса (в проде индекс мог не создаться из-за старых
    // дублей), поэтому ошибка только логируется — гонку сида дополнительно
    // страхует upsert в ensureSeed().
    void this.ensureReportIndexes();
  }

  /**
   * TODO-463: у `reports_definitions` не было ни одного индекса. list() ходит по
   * (projectId, deletedAt) с сортировкой по updatedAt, а сид — по
   * (projectId, presetKey); последний делаем УНИКАЛЬНЫМ (partial по строковому
   * presetKey, чтобы пользовательские отчёты с presetKey=null не конфликтовали
   * друг с другом) — это и есть замок от параллельного двойного сида.
   */
  private async ensureReportIndexes(): Promise<void> {
    try {
      const coll = this.mongo.reports();
      await coll.createIndex(
        { projectId: 1, presetKey: 1 },
        {
          unique: true,
          name: 'reports_def_preset_uk',
          partialFilterExpression: { presetKey: { $type: 'string' } },
        },
      );
      await coll.createIndex({ projectId: 1, deletedAt: 1, updatedAt: -1 }, { name: 'reports_def_list' });
      // TODO-466: list() теперь сужается ещё и предикатом доступа
      // (`visibility != 'personal'` OR `createdBy = <viewer>`). Ветки `$or`
      // Mongo обслуживает индексным объединением, поэтому у «личной» ветки
      // должен быть свой индекс. Отдельным ИМЕНЕМ, а не расширением
      // reports_def_list: createIndex с тем же именем и другим ключом падает
      // IndexKeySpecsConflict, и (из-за catch ниже) правка тихо не применилась
      // бы на существующих БД.
      await coll.createIndex(
        { projectId: 1, deletedAt: 1, createdBy: 1, updatedAt: -1 },
        { name: 'reports_def_owner' },
      );
    } catch (err) {
      this.logger.warn(`reports_definitions index setup failed: ${String(err)}`);
    }
  }

  /** true для E11000 (в т.ч. внутри BulkWriteError) — «кто-то уже вставил». */
  private static isDuplicateKey(err: unknown): boolean {
    const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
    if (e?.code === 11000) return true;
    const we = e?.writeErrors;
    return Array.isArray(we) && we.length > 0 && we.every((w) => (w?.code ?? w?.err?.code) === 11000);
  }

  /**
   * FR-MREP-5: normalized on a single field name (legacy {project_id} kept read-only).
   *
   * TODO-467 (требование к индексам, а не к коду reports). Фрагмент попадает в
   * ПЕРВЫЙ `$match` каждой агрегации, поэтому от него зависит, возьмёт ли
   * планировщик Mongo индекс: `$or` покрывается индексом только если ОБЕ ветви
   * индексированы по отдельности — иначе весь конвейер деградирует в COLLSCAN
   * по чужой коллекции. Владеющим доменам нужны парные индексы (или единое
   * написание поля) на:
   *   crm_deals, crm_orders (pipe/orders) — {projectId,...} И {project_id,...}
   *   contacts, companies (contact/company), crm_activities (activity) — то же.
   * Убрать вторую ветвь из reports нельзя: это чужие коллекции, и пока в них
   * встречается legacy-написание, отказ от него молча урезал бы выдачу
   * (аналитика показала бы неполные данные, а не ошибку). Каноническое решение —
   * миграция project_id→projectId у доменов-владельцев либо переход на их
   * Aggregate()-RPC (TODO-468), после чего `$or` уходит вместе с проблемой.
   */
  private projectFilter(projectId: string): Record<string, unknown> {
    return { $or: [{ projectId }, { project_id: projectId }] };
  }

  /**
   * Combine independent match fragments with `$and`. Spreading two fragments that
   * both carry an `$or` (e.g. the project filter `{$or:[{projectId},{project_id}]}`
   * and a visibility/date `$or`) silently DROPS the first — a tenant-isolation hole
   * (the project scope vanishes, aggregates leak across projects). `$and` keeps
   * every fragment; empty/null fragments are ignored, a single fragment is returned
   * as-is (no redundant `$and`).
   */
  private andMatch(
    ...fragments: (Record<string, unknown> | null | undefined)[]
  ): Record<string, unknown> {
    const parts = fragments.filter(
      (f): f is Record<string, unknown> => !!f && Object.keys(f).length > 0,
    );
    if (parts.length === 0) return {};
    if (parts.length === 1) return parts[0];
    return { $and: parts };
  }

  private assertProjectId(projectId: string): void {
    if (!projectId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'project_id is required' });
    }
  }

  /**
   * FR-MREP-3 fail-closed: an executing method (run/export/drill) MUST receive a
   * resolved visibility scope from the gateway. Missing scope → PERMISSION_DENIED,
   * never "see everything". (s2s/internal calls with mode 'all' still pass.)
   */
  private assertScope(scope: VisibilityScope | undefined): VisibilityScope {
    if (!scope) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Не удалось определить область видимости',
      });
    }
    return scope;
  }

  /**
   * «Живая запись» — общий фрагмент для всех источников. Домены удаляют мягко и
   * пишут разное «пусто»: pipe/activity — null/отсутствие поля, orders — 0
   * (`orders.service.ts:445 {deletedAt:{$in:[null,0]}}`). Без этого фрагмента
   * удалённые сделки/продажи/активности попадали во все агрегаты статистики.
   */
  private static readonly NOT_DELETED: Record<string, unknown> = {
    deletedAt: { $in: [null, undefined, 0] },
  };

  /** ObjectId, которого не бывает — «не матчит ничего» для fail-closed ABAC. */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Трёхсостоянийный ABAC-предикат (`x-access-predicate`), скомпилированный на
   * gateway, как ещё один фрагмент `$match` (RFC-5 §1.4 / RFC-ABAC §4):
   *  - отсутствует → null (никакого сужения; projectId + видимость остаются);
   *  - malformed  → deny-all (сломанное deny-правило не должно РАСШИРЯТЬ доступ);
   *  - есть `.mongo` → сам фрагмент.
   * Предикат уходит в БД предикатом, а не фильтрацией в памяти (INV-4).
   */
  private predicateFragment(access?: AccessPredicate): Record<string, unknown> | null {
    // (tsconfig домена собирается со strictNullChecks:false, поэтому сужение
    // размеченного union'а делаем через явное представление, а не по флагу.)
    const view = access as
      | { present?: boolean; malformed?: boolean; mongo?: Record<string, unknown> | null }
      | undefined;
    if (!view?.present) return null;
    if (view.malformed) return { _id: ReportsService.DENY_ALL_ID };
    return view.mongo && Object.keys(view.mongo).length > 0 ? view.mongo : null;
  }

  /**
   * Предикат ИСТОЧНИКА (`bySubject`) — второй фрагмент ABAC, скомпилированный
   * gateway по subject'у самой коллекции (`deals`/`orders`/…), а не маршрута.
   * Без него правило политики на `deals` не применялось в агрегатах вовсе
   * (в списке сделок запись скрыта, а её сумма видна в статистике), а маршрутный
   * фрагмент с `record.ownerId` уезжал в том числе в activities, где владелец
   * называется `assigneeId`, и срез молча пустел. См.
   * `gateway/src/guards/access-predicate.aggregate.ts`.
   */
  private sourcePredicate(
    access: AccessPredicate | undefined,
    entity: SourceEntity,
  ): AccessPredicate | undefined {
    const view = access as AggregateAccessPredicate | undefined;
    if (!view) return undefined;
    // Набор прислан, но нечитаем → fail-closed по КАЖДОМУ источнику.
    if (view.bySubjectMalformed) return { present: true, malformed: true };
    return view.bySubject?.[entity];
  }

  /**
   * Итоговый ABAC-фрагмент коллекции: маршрутный предикат И предикат источника.
   * Оба только сужают, поэтому порядок неважен; `entity` не задан (или набора нет)
   * → поведение прежнее, один маршрутный фрагмент.
   */
  private accessMatch(
    access?: AccessPredicate,
    entity?: SourceEntity,
  ): Record<string, unknown> | null {
    const route = this.predicateFragment(access);
    const source = entity ? this.predicateFragment(this.sourcePredicate(access, entity)) : null;
    if (!route) return source;
    if (!source) return route;
    return this.andMatch(route, source);
  }

  /**
   * Фрагменты `$match` из разобранных `params` (P2.f → реально применяются).
   * Только СУЖАЮТ выборку в пределах уже наложенных projectId + видимости +
   * ABAC: период по дате создания, воронка/стадия, менеджеры/отдел/источник.
   */
  private paramFragments(params: ReportParams, entity: SourceEntity): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const range = this.paramsRange(params);
    if (range) out.push(this.dateMatch(range));

    const ownerField = OWNER_FIELD[entity];
    if (params.managerIds?.length && ownerField) {
      out.push({ [ownerField]: { $in: params.managerIds } });
    }
    if (entity === 'deals' || entity === 'orders') {
      if (params.pipelineId) {
        out.push({ $or: [{ pipelineId: params.pipelineId }, { pipeline_id: params.pipelineId }] });
      }
      if (params.stageId) {
        out.push({ $or: [{ stageId: params.stageId }, { stage_id: params.stageId }] });
      }
    }
    if (params.departmentId) {
      out.push({
        $or: [{ departmentId: params.departmentId }, { department_id: params.departmentId }],
      });
    }
    if (entity === 'deals' && params.source) {
      out.push({ $or: [{ sourceId: params.source }, { source: params.source }] });
    }
    return out;
  }

  /**
   * Окно периода из `params`, или null когда период не задан (тогда отчёт, как и
   * раньше, покрывает весь проект в рамках видимости). `customFrom/customTo` —
   * написание фронта (`RunParams`), `from/to` — контрактное.
   */
  private paramsRange(params: ReportParams): PeriodRange | null {
    const from = params.from ?? params.customFrom;
    const to = params.to ?? params.customTo;
    if (!params.period && from === undefined && to === undefined) return null;
    if (!params.period) return this.resolvePeriod('custom', from, to);
    return this.resolvePeriod(params.period, from, to);
  }

  /** Scope `$match` fragment for a source entity, or null (mode 'all'). FR-MREP-2. */
  private visMatch(entity: string, scope: VisibilityScope): Record<string, unknown> | null {
    const ownerField = OWNER_FIELD[entity];
    if (!ownerField) return null;
    const sharedIds = scope.sharedRecordIds
      .filter((x) => ObjectId.isValid(x))
      .map((x) => new ObjectId(x));
    return buildVisibilityFilter<ObjectId>(scope, ownerField, sharedIds);
  }

  /**
   * TODO-466: предикат доступа к ОПРЕДЕЛЕНИЮ отчёта — Mongo-фрагментом, а не
   * фильтрацией в памяти (инвариант «ABAC пушится в БД предикатом»). Ровно этот
   * фрагмент стоит и в чтении (list/get), и в загрузке под запись
   * (update/remove через loadDoc): гейт записи = гейт чтения.
   *
   * `{ visibility: { $ne: 'personal' } }` намеренно матчит документы БЕЗ поля
   * (легаси и встроенные пресеты) — они были проектными и такими остаются.
   * Пустой `viewerId` (s2s-вызов мимо gateway) → видны только проектные:
   * fail-closed, а не «показать всё».
   */
  private reportVisibilityMatch(viewerId?: string): Record<string, unknown> {
    const self = viewerId?.trim();
    const clauses: Record<string, unknown>[] = [
      { visibility: { $ne: REPORT_VISIBILITY_PERSONAL } },
    ];
    if (self) clauses.push({ visibility: REPORT_VISIBILITY_PERSONAL, createdBy: self });
    return { $or: clauses };
  }

  private toReport(doc: ReportDoc) {
    const presetKey = doc.presetKey ?? '';
    return {
      id: doc._id.toString(),
      project_id: doc.projectId,
      name: doc.name,
      description: doc.description,
      kind: doc.kind,
      // FR-MREP-8: ключ встроенного пресета — то, по чему фронт сопоставляет
      // вкладку с определением отчёта (без него он падал в эвристику по индексу).
      preset_key: presetKey,
      // FR-REPORTS-190: модули-источники пресета для Contextual UI и wire-контракта.
      requires_modules: this.requiresModulesForPreset(presetKey || null),
      // TODO-466: уровень доступа определения отчёта. До правки выбор
      // радиокнопки «Личный/Проектный» уезжал СТРОКОЙ ОПИСАНИЯ и нигде не
      // хранился, поэтому «личный» отчёт видел весь проект.
      visibility: normalizeReportVisibility(doc.visibility),
      spec_json: doc.spec ? JSON.stringify(doc.spec) : '',
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  }

  private isBuiltin(doc: ReportDoc): boolean {
    return doc.kind === 'builtin' || !!doc.presetKey;
  }

  /**
   * Typed run/drill/export parameters (P2.f). Previously `params_json` was an
   * opaque `Record<string, unknown>` echoed verbatim; it is now parsed into a
   * closed set of known filter knobs. Unknown keys are dropped (never echoed),
   * and a present-but-wrong-typed known key is a hard INVALID_ARGUMENT.
   *
   * The known set mirrors the report/dashboard filter vocabulary the FE sends
   * (`RunParams`: period/customFrom/customTo/managerIds/pipelineId/departmentId/
   * source). Каждое значение РЕАЛЬНО доезжает до `$match` через
   * {@link ReportsService.paramFragments} — фильтры на экране отчётов сужают
   * выборку, а не только возвращаются эхом.
   */
  private parseParams(paramsJson?: string): ReportParams {
    if (!paramsJson?.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(paramsJson);
    } catch {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'params_json must be valid JSON object',
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // A non-object (null/array/scalar) collapses to "no params", as before.
      return {};
    }
    const raw = parsed as Record<string, unknown>;
    const out: ReportParams = {};
    const invalid = (key: string, expected: string): never => {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `params.${key} must be ${expected}`,
      });
    };
    const asString = (key: keyof ReportParams): void => {
      const v = raw[key];
      if (v === undefined || v === null) return;
      if (typeof v !== 'string') invalid(key, 'a string');
      const s = (v as string).trim();
      if (s) (out as Record<string, unknown>)[key] = s;
    };
    const asNumber = (key: keyof ReportParams): void => {
      const v = raw[key];
      if (v === undefined || v === null) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) invalid(key, 'a finite number');
      (out as Record<string, unknown>)[key] = v;
    };
    const asStringArray = (key: keyof ReportParams): void => {
      const v = raw[key];
      if (v === undefined || v === null) return;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        invalid(key, 'an array of strings');
      }
      const list = (v as string[]).map((x) => x.trim()).filter(Boolean);
      if (list.length) (out as Record<string, unknown>)[key] = list;
    };
    asString('period');
    asNumber('from');
    asNumber('to');
    asNumber('customFrom');
    asNumber('customTo');
    asString('pipelineId');
    asString('stageId');
    asStringArray('managerIds');
    asString('departmentId');
    asString('source');
    asNumber('stalledDays');
    asNumber('pageIndex');
    asNumber('pageSize');
    asString('entityType');
    asString('entityId');
    // Unknown keys are intentionally dropped (closed vocabulary).
    return out;
  }

  /** FR-REPORTS-190: модули-источники встроенного пресета для API-модели Report. */
  private requiresModulesForPreset(presetKey: string | null | undefined): string[] {
    if (!presetKey?.trim()) return [];
    const req = PRESET_SOURCE_MODULES[presetKey];
    if (!req) return [];
    if (req.allOf) return [...req.allOf];
    if (req.anyOf) return [...req.anyOf];
    return [];
  }

  /** NFR-050: детерминированный хэш фильтров прогона (без пагинации). */
  private filtersHash(params: ReportParams): string {
    const { pageIndex: _pi, pageSize: _ps, ...rest } = params;
    const keys = Object.keys(rest).sort();
    const norm = keys.map((k) => `${k}:${JSON.stringify((rest as Record<string, unknown>)[k])}`);
    let h = 0;
    const s = norm.join('|');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  private aggregateCacheKey(
    projectId: string,
    reportId: string,
    presetKey: string | null | undefined,
    scope: VisibilityScope,
    params: ReportParams,
  ): string {
    return `${projectId}:${reportId}:${presetKey ?? ''}:${this.scopeHash(scope)}:${this.filtersHash(params)}`;
  }

  /** NFR-020: пагинация основного массива групп в payload прогона. */
  private applyAggregatePagination(
    payload: Record<string, unknown>,
    presetKey: string | null | undefined,
    params: ReportParams,
  ): Record<string, unknown> {
    const rowKey = presetKey ? PRESET_AGGREGATE_ROWS[presetKey] : undefined;
    if (!rowKey) return payload;
    const rows = payload[rowKey];
    if (!Array.isArray(rows)) return payload;
    const pageSize = Math.max(1, Math.min(Math.floor(params.pageSize ?? 25), 100));
    const pageIndex = Math.max(0, Math.floor(params.pageIndex ?? 0));
    const totalGroups = rows.length;
    const start = pageIndex * pageSize;
    const page = rows.slice(start, start + pageSize);
    return {
      ...payload,
      [rowKey]: page,
      aggregate_pagination: {
        page_index: pageIndex,
        page_size: pageSize,
        total_groups: totalGroups,
      },
    };
  }

  /**
   * Порог «зависшей» сделки: параметр прогона с дефолтом из env
   * (`STATISTICS_STALLED_DAYS`, FR-REPORTS-260).
   */
  private stalledDaysValue(params: ReportParams): number {
    const env = Number(process.env.STATISTICS_STALLED_DAYS ?? 7);
    const n = params.stalledDays;
    if (n !== undefined && Number.isFinite(n) && n > 0) return Math.floor(n);
    return env > 0 ? env : 7;
  }

  /**
   * FR-REPORTS-190: прямой вызов run по пресету, чей модуль-источник выключен,
   * → FAILED_PRECONDITION (Contextual UI на FE не заменяет fail-closed на wire).
   */
  private assertPresetModules(presetKey: string | null | undefined, enabledModules?: string[]): void {
    if (!presetKey?.trim() || !enabledModules?.length) return;
    const req = PRESET_SOURCE_MODULES[presetKey];
    if (!req) return;
    const on = (m: string) => enabledModules.includes(m);
    if (req.anyOf && !req.anyOf.some(on)) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: `Preset "${presetKey}" requires module: ${req.anyOf.join(' or ')}`,
      });
    }
    if (req.allOf && !req.allOf.every(on)) {
      const missing = req.allOf.filter((m) => !on(m));
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: `Preset "${presetKey}" requires module: ${missing.join(', ')}`,
      });
    }
  }

  /** Окно той же длины непосредственно перед текущим периодом (PoP KPI). */
  private previousParamsRange(params: ReportParams): PeriodRange | null {
    const range = this.paramsRange(params);
    if (!range) return null;
    const span = range.to - range.from;
    if (span <= 0) return null;
    return {
      period: range.period,
      from: range.from - span,
      to: range.from,
    };
  }

  /** params с датами предыдущего окна (остальные фильтры сохраняются). */
  private paramsForRange(params: ReportParams, range: PeriodRange): ReportParams {
    return {
      ...params,
      period: 'custom',
      from: range.from,
      to: range.to,
      customFrom: range.from,
      customTo: range.to,
    };
  }

  /**
   * FR-REPORTS-280: охват scope — сколько менеджеров/отделов видны в срезе
   * против всего проекта (без предиката видимости, но с теми же params).
   */
  private async computeScopeCoverage(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<{
    managers?: { covered: number; total: number };
    departments?: { covered: number; total: number };
  }> {
    const scopedMatch = this.sourceMatch('deals', projectId, scope, params, access);
    const projectDeals = this.andMatch(
      this.projectFilter(projectId),
      ReportsService.NOT_DELETED,
      ...this.paramFragments(params, 'deals'),
    );
    const countDistinct = async (
      match: Record<string, unknown>,
      fieldExpr: Record<string, unknown>,
    ): Promise<number> => {
      const rows = await this.mongo
        .deals()
        .aggregate([
          { $match: match },
          { $group: { _id: fieldExpr } },
          { $match: { _id: { $nin: [null, '', undefined] } } },
          { $count: 'n' },
        ])
        .toArray();
      return Number(rows[0]?.n ?? 0);
    };
    const managerId = { $ifNull: ['$assigneeId', '$ownerId', ''] };
    const departmentId = { $ifNull: ['$departmentId', '$department_id', ''] };
    const [coveredManagers, totalManagers, coveredDepartments, totalDepartments] =
      await Promise.all([
        countDistinct(scopedMatch, managerId),
        countDistinct(projectDeals, managerId),
        countDistinct(scopedMatch, departmentId),
        countDistinct(projectDeals, departmentId),
      ]);
    const out: {
      managers?: { covered: number; total: number };
      departments?: { covered: number; total: number };
    } = {};
    if (totalManagers > 0) {
      out.managers = { covered: coveredManagers, total: totalManagers };
    }
    if (totalDepartments > 0) {
      out.departments = { covered: coveredDepartments, total: totalDepartments };
    }
    return out;
  }

  private parseSpec(specJson?: string): Record<string, unknown> | null {
    if (!specJson?.trim()) return null;
    try {
      const parsed = JSON.parse(specJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not-object');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'spec must be a valid JSON object',
      });
    }
  }

  /**
   * Идемпотентный сид встроенных пресетов (FR-MREP-8, INV-1). Каждый пресет
   * заводится РОВНО один раз на проект и опознаётся по `presetKey` — именно он
   * делает {@link ReportsService.isBuiltin} истинным (иначе пресет можно было
   * переименовать и удалить, а после soft-удаления он не восстанавливался).
   *
   * Ранее засеянные проекты лечатся на месте: документ со старым `kind`
   * ('sales_snapshot'/'deals_by_stage'/'crm_coverage') и `presetKey: null`
   * получает свой ключ, а мягко удалённый пресет — восстанавливается.
   */
  private async ensureSeed(projectId: string): Promise<void> {
    const coll = this.mongo.reports();
    const existing = (await coll
      .find({ projectId })
      .project({ presetKey: 1, kind: 1, deletedAt: 1 })
      .toArray()) as Array<{
      _id: ObjectId;
      presetKey?: string | null;
      kind?: string;
      deletedAt?: number | null;
    }>;
    const byPreset = new Map<string, (typeof existing)[number]>();
    const byLegacyKind = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      if (row.presetKey) byPreset.set(row.presetKey, row);
      else if (row.kind) byLegacyKind.set(row.kind, row);
    }

    const now = Date.now();
    const ops: AnyBulkWriteOperation[] = [];
    for (const preset of BUILTIN_PRESETS) {
      const hit = byPreset.get(preset.presetKey);
      if (hit) {
        // Пресет есть: восстановить, если его успели мягко удалить до фикса.
        const presetPatch: Record<string, unknown> = { updatedAt: now };
        if (hit.deletedAt) presetPatch.deletedAt = null;
        // DM-kind / NFR-REPORTS-080: нормализуем kind на builtin без затрагивания custom.
        if (hit.kind !== 'builtin') presetPatch.kind = 'builtin';
        if (Object.keys(presetPatch).length > 1) {
          ops.push({
            updateOne: {
              filter: { _id: hit._id },
              update: { $set: presetPatch },
            },
          });
        }
        continue;
      }
      const legacy = preset.legacyKind ? byLegacyKind.get(preset.legacyKind) : undefined;
      if (legacy) {
        ops.push({
          updateOne: {
            filter: { _id: legacy._id },
            update: {
              $set: {
                presetKey: preset.presetKey,
                kind: 'builtin',
                deletedAt: null,
                updatedAt: now,
              },
            },
          },
        });
        continue;
      }
      // TODO-463: upsert по (projectId, presetKey), а не insertOne. Два
      // параллельных первых запроса в проекте засевали пресеты ДВАЖДЫ — в
      // списке появлялись по две «Продажи»/«Воронки», и вкладка сопоставлялась
      // с произвольным дублем. `projectId`/`presetKey` в документ добавляет сам
      // Mongo из equality-условий фильтра, поэтому в $setOnInsert их нет
      // (иначе конфликт путей при вставке).
      ops.push({
        updateOne: {
          filter: { projectId, presetKey: preset.presetKey },
          update: {
            $setOnInsert: {
              name: preset.name,
              description: preset.description,
              kind: 'builtin',
              spec: null,
              // TODO-466: встроенные пресеты — всегда проектные.
              visibility: REPORT_VISIBILITY_PROJECT,
              createdBy: null,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) {
      try {
        await coll.bulkWrite(ops, { ordered: false });
      } catch (err) {
        // Гонку выиграл соседний запрос: документ уже есть — это успех сида,
        // а не ошибка запроса пользователя.
        if (!ReportsService.isDuplicateKey(err)) throw err;
      }
    }
  }

  async list(
    projectId: string,
    pageIndex: number,
    pageSize: number,
    query?: string,
    viewerId?: string,
  ) {
    this.assertProjectId(projectId);
    await this.ensureSeed(projectId);
    const limit = Math.max(1, Math.min(pageSize || 25, 100));
    const filter: Record<string, unknown> = { projectId, deletedAt: { $in: [null, undefined] } };
    // TODO-466: предикат доступа и поисковый `$or` конфликтуют на верхнем уровне
    // (второй `$or` молча затирает первый — та же грабля, что в `andMatch`
    // агрегаций), поэтому оба живут внутри `$and`.
    const and: Record<string, unknown>[] = [this.reportVisibilityMatch(viewerId)];
    if (query?.trim()) {
      // S3 (OQ-REP-7): escape + length-cap before building the RegExp.
      const rx = new RegExp(escapeRegExp(query.trim().slice(0, 128)), 'i');
      and.push({ $or: [{ name: rx }, { description: rx }] });
    }
    filter.$and = and;
    const total = await this.mongo.reports().countDocuments(filter);
    const rows = (await this.mongo
      .reports()
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip(pageIndex * limit)
      .limit(limit)
      .toArray()) as ReportDoc[];
    return { list: rows.map((row) => this.toReport(row)), total };
  }

  /**
   * TODO-466: единственная точка загрузки определения — и для чтения (get/run/
   * export), и для записи (update/remove). Предикат доступа стоит ЗДЕСЬ, чтобы
   * гейт записи совпал с гейтом чтения: чужой личный отчёт не только не виден,
   * но и не редактируется/не удаляется (NOT_FOUND, а не PERMISSION_DENIED — не
   * подтверждаем существование чужого объекта).
   */
  private async loadDoc(projectId: string, id: string, viewerId?: string): Promise<ReportDoc> {
    this.assertProjectId(projectId);
    if (!ObjectId.isValid(id)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Report not found' });
    }
    const doc = (await this.mongo.reports().findOne({
      _id: new ObjectId(id),
      projectId,
      ...this.reportVisibilityMatch(viewerId),
    })) as ReportDoc | null;
    if (!doc || doc.deletedAt) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Report not found' });
    }
    return doc;
  }

  async get(projectId: string, id: string, viewerId?: string) {
    return this.toReport(await this.loadDoc(projectId, id, viewerId));
  }

  async create(
    projectId: string,
    name?: string,
    description?: string,
    kind?: string,
    specJson?: string,
    createdBy?: string,
    /** TODO-466: 'personal' | что угодно иное (в т.ч. '' с провода) = 'project'. */
    visibility?: string,
  ) {
    this.assertProjectId(projectId);
    if (!name?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'name is required' });
    }
    // INV-1/INV-3: API never creates builtin; custom always presetKey:null.
    const spec = this.parseSpec(specJson);
    const now = Date.now();
    const doc: ReportDoc = {
      _id: new ObjectId(),
      projectId,
      name: name.trim(),
      description: description?.trim() ?? '',
      kind: kind?.trim() && kind.trim() !== 'builtin' ? kind.trim() : 'custom',
      presetKey: null,
      spec,
      // TODO-466: уровень доступа хранится полем. Личный отчёт без автора
      // (s2s-вызов без x-user-id) был бы невидим вообще никому — такой вызов
      // создаёт проектный отчёт, а не «сироту».
      visibility:
        normalizeReportVisibility(visibility) === REPORT_VISIBILITY_PERSONAL && createdBy?.trim()
          ? REPORT_VISIBILITY_PERSONAL
          : REPORT_VISIBILITY_PROJECT,
      createdBy: createdBy?.trim() || null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.mongo.reports().insertOne(doc);
    return this.toReport(doc);
  }

  /** TO-BE (FR-MREP-28): edit custom only; builtin is immutable (INV-1). */
  async update(
    projectId: string,
    id: string,
    name?: string,
    description?: string,
    specJson?: string,
    /**
     * TODO-466: пусто/undefined = «не менять» (та же семантика, что у остальных
     * полей UpdateReportRequest) — PATCH без поля не расшаривает личный отчёт.
     */
    visibility?: string,
    viewerId?: string,
  ) {
    const doc = await this.loadDoc(projectId, id, viewerId);
    if (this.isBuiltin(doc)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Встроенный отчёт нельзя изменять',
      });
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name?.trim()) patch.name = name.trim();
    if (description !== undefined) patch.description = description.trim();
    if (specJson !== undefined) patch.spec = this.parseSpec(specJson);
    if (visibility?.trim()) {
      const next = normalizeReportVisibility(visibility);
      // «Сделать личным» без известного автора оставило бы отчёт невидимым для
      // всех (включая того, кто нажал кнопку) — тогда автором становится он.
      const owner = doc.createdBy?.trim() || viewerId?.trim() || null;
      if (next === REPORT_VISIBILITY_PERSONAL && owner) {
        patch.visibility = REPORT_VISIBILITY_PERSONAL;
        patch.createdBy = owner;
      } else {
        patch.visibility = REPORT_VISIBILITY_PROJECT;
      }
    }
    await this.mongo
      .reports()
      .updateOne({ _id: doc._id, projectId }, { $set: patch });
    return this.toReport({ ...doc, ...patch } as ReportDoc);
  }

  /** TO-BE: soft-delete custom only; builtin is undeletable (INV-1). */
  async remove(projectId: string, id: string, viewerId?: string) {
    const doc = await this.loadDoc(projectId, id, viewerId);
    if (this.isBuiltin(doc)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Встроенный отчёт нельзя удалить',
      });
    }
    const deletedAt = Date.now();
    await this.mongo
      .reports()
      .updateOne({ _id: doc._id, projectId }, { $set: { deletedAt, updatedAt: deletedAt } });
    return { id, deleted: true, deleted_at: deletedAt };
  }

  /**
   * BR-REPORTS-060: проектные custom-отчёты ушедшего участника переназначаются
   * на Admin/Owner (`reassignToUserId` из `control.member.offboarded`).
   */
  async reassignOrphanedSharedReports(
    projectId: string,
    departingUserId: string,
    reassignToUserId: string,
  ): Promise<{ reassigned: number }> {
    this.assertProjectId(projectId);
    const from = departingUserId.trim();
    const to = reassignToUserId.trim();
    if (!from || !to || from === to) return { reassigned: 0 };
    const now = Date.now();
    const result = await this.mongo.reports().updateMany(
      {
        projectId,
        createdBy: from,
        visibility: { $ne: REPORT_VISIBILITY_PERSONAL },
        presetKey: null,
        deletedAt: { $in: [null, undefined] },
      },
      { $set: { createdBy: to, updatedAt: now } },
    );
    return { reassigned: result.modifiedCount ?? 0 };
  }

  /**
   * v1 scope-aware aggregation over the shared Mongo views. Each `$match` starts
   * with the project filter AND the viewer's visibility predicate (FR-MREP-2),
   * so a Member/Viewer's totals cover only records they may see.
   *
   * TODO(FR-MREP §6.4): replace direct view access with owner-domain
   * `Aggregate(scope-in-metadata)` RPCs (removes cross-domain Mongo coupling, долг #3).
   *
   * NOTE(P2.f): a materialized `statistics_rollup` fact table is now kept warm by
   * {@link StatisticsRollupConsumer}; this on-the-fly summary is still the read
   * path (no backfill yet — read-switch is a follow-up).
   */
  private async buildSummary(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams = {},
    access?: AccessPredicate,
  ) {
    // ABAC — по КАЖДОМУ источнику отдельно: маршрутный предикат (subject
    // `reports`/`statistics`) И предикат самой коллекции из `bySubject`.
    // Сборка `$match` — общая с резолверами пресетов (`sourceMatch`), чтобы
    // KPI-шапка и срез пресета считались по одному и тому же множеству записей.
    const dealsMatch = this.sourceMatch('deals', projectId, scope, params, access);
    const ordersMatch = this.sourceMatch('orders', projectId, scope, params, access);
    const contactsMatch = this.sourceMatch('contacts', projectId, scope, params, access);
    const companiesMatch = this.sourceMatch('companies', projectId, scope, params, access);

    const [dealsCount, ordersCount, contactsCount, companiesCount] = await Promise.all([
      this.mongo.deals().countDocuments(dealsMatch),
      this.mongo.orders().countDocuments(ordersMatch),
      this.mongo.contacts().countDocuments(contactsMatch),
      this.mongo.companies().countDocuments(companiesMatch),
    ]);

    const prevRange = this.previousParamsRange(params);
    let totals_previous: Record<string, number> | undefined;
    if (prevRange && prevRange.from > 0) {
      const prevParams = this.paramsForRange(params, prevRange);
      const prevDealsMatch = this.sourceMatch('deals', projectId, scope, prevParams, access);
      const prevOrdersMatch = this.sourceMatch('orders', projectId, scope, prevParams, access);
      const prevContactsMatch = this.sourceMatch('contacts', projectId, scope, prevParams, access);
      const prevCompaniesMatch = this.sourceMatch('companies', projectId, scope, prevParams, access);
      const [pDeals, pOrders, pContacts, pCompanies, pDealAmount] = await Promise.all([
        this.mongo.deals().countDocuments(prevDealsMatch),
        this.mongo.orders().countDocuments(prevOrdersMatch),
        this.mongo.contacts().countDocuments(prevContactsMatch),
        this.mongo.companies().countDocuments(prevCompaniesMatch),
        this.mongo
          .deals()
          .aggregate([
            { $match: prevDealsMatch },
            { $group: { _id: null, amount: { $sum: '$amount' } } },
          ])
          .toArray(),
      ]);
      totals_previous = {
        deals_count: pDeals,
        deals_amount: Number(pDealAmount[0]?.amount ?? 0),
        orders_count: pOrders,
        contacts_count: pContacts,
        companies_count: pCompanies,
      };
    }

    const [dealAmountAgg, dealsByStage, ordersByStage, dealsByManager, dealsByDepartment] =
      await Promise.all([
        this.mongo
          .deals()
          .aggregate([{ $match: dealsMatch }, { $group: { _id: null, amount: { $sum: '$amount' } } }])
          .toArray(),
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            {
              $group: {
                _id: { $ifNull: ['$stageId', '$stage_id'] },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
              },
            },
            { $sort: { count: -1, _id: 1 } },
          ])
          .toArray(),
        this.mongo
          .orders()
          .aggregate([
            { $match: ordersMatch },
            { $group: { _id: { $ifNull: ['$stageId', '$stage_id'] }, count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ])
          .toArray(),
        // FR-MREP-8: срез «по менеджерам» — тот же scope-`$match`, группировка по
        // владельцу сделки (assigneeId, OWNER_FIELD домена pipe).
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            {
              $group: {
                _id: { $ifNull: ['$assigneeId', '$ownerId'] },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
                won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
              },
            },
            { $sort: { amount: -1, _id: 1 } },
          ])
          .toArray(),
        // FR-MREP-25: срез «сравнение отделов» — та же группировка, что в
        // getMetrics.by_department (переиспользована, не продублирована логика).
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            {
              $group: {
                _id: { $ifNull: ['$departmentId', '$department_id', ''] },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
                won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
                managers: { $addToSet: { $ifNull: ['$assigneeId', '$ownerId'] } },
              },
            },
            { $sort: { amount: -1, _id: 1 } },
          ])
          .toArray(),
      ]);

    const stageMap = await this.loadStages(projectId, params.pipelineId).catch(() => null);
    const stageLabel = (id: string) => {
      const hit = stageMap?.get(id);
      return hit?.name?.trim() || id;
    };

    let managerRows: Array<{
      manager_id: string;
      manager_name?: string;
      row_kind?: string;
      count: number;
      amount: number;
      won: number;
      lost: number;
    }> = dealsByManager.map((row) => ({
      manager_id: String(row._id ?? ''),
      count: Number(row.count ?? 0),
      amount: Number(row.amount ?? 0),
      won: Number(row.won ?? 0),
      lost: Number(row.lost ?? 0),
    }));
    // FR-REPORTS-100: only_own — строка «я» + обезличенный бенчмарк отдела.
    if (scope.level === 'only_own') {
      const selfId = scope.selfId?.trim();
      if (selfId) {
        managerRows = managerRows.filter((r) => r.manager_id === selfId);
        const bench = await this.buildDepartmentBenchmarkRow(
          projectId,
          params,
          access,
          selfId,
        );
        if (bench) {
          managerRows.push({
            manager_id: String(bench.manager_id ?? ''),
            manager_name: String(bench.manager_name ?? ''),
            row_kind: String(bench.row_kind ?? ''),
            count: Number(bench.count ?? 0),
            amount: Number(bench.amount ?? 0),
            won: Number(bench.won ?? 0),
            lost: Number(bench.lost ?? 0),
          });
        }
      }
    }

    return {
      totals: {
        deals_count: dealsCount,
        deals_amount: Number(dealAmountAgg[0]?.amount ?? 0),
        orders_count: ordersCount,
        contacts_count: contactsCount,
        companies_count: companiesCount,
      },
      totals_previous,
      coverage: await this.computeScopeCoverage(projectId, scope, params, access),
      deals_by_stage: dealsByStage.map((row) => {
        const stageId = String(row._id ?? '');
        return {
          stage_id: stageId,
          stage_name: stageLabel(stageId),
          count: Number(row.count ?? 0),
          amount: Number(row.amount ?? 0),
        };
      }),
      orders_by_stage: ordersByStage.map((row) => {
        const stageId = String(row._id ?? '');
        return {
          stage_id: stageId,
          stage_name: stageLabel(stageId),
          count: Number(row.count ?? 0),
        };
      }),
      // FR-MREP-8 / FR-MREP-25: срезы, которые фронт умеет рисовать (вкладка
      // «По менеджерам» и режим «Сравнение отделов») — раньше они не приходили.
      deals_by_manager: managerRows,
      deals_by_department: dealsByDepartment.map((row) => {
        const count = Number(row.count ?? 0);
        const amount = Number(row.amount ?? 0);
        const won = Number(row.won ?? 0);
        const managers = Array.isArray(row.managers)
          ? (row.managers as unknown[]).filter((m) => m != null && m !== '').length
          : 0;
        return {
          department_id: String(row._id ?? ''),
          count,
          amount,
          won,
          lost: Number(row.lost ?? 0),
          // доля выигранных сделок отдела, % (колонка таблицы с суффиксом '%').
          conversion: count > 0 ? Math.round((won / count) * 1000) / 10 : 0,
          avg_check: count > 0 ? amount / count : 0,
          managers_count: managers,
        };
      }),
    };
  }

  /**
   * Полный `$match` источника: проект + видимость + ABAC источника + «живая
   * запись» + фильтры экрана. Один сборщик на все агрегации прогона: резолвер
   * пресета обязан сужать выборку РОВНО тем же набором фрагментов, что и общая
   * сводка, иначе KPI-шапка и таблица под ней посчитаются по разным множествам.
   */
  private sourceMatch(
    entity: SourceEntity,
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Record<string, unknown> {
    return this.andMatch(
      this.projectFilter(projectId),
      this.visMatch(entity, scope),
      this.accessMatch(access, entity),
      ReportsService.NOT_DELETED,
      ...this.paramFragments(params, entity),
    );
  }

  /**
   * Гейт ЧТЕНИЯ записи источника БЕЗ фильтров экрана — для подстановки имён к
   * идентификаторам, пришедшим из другого среза (компания из сделки). Гейт тот
   * же, что у списка (INV-4: гейт записи = гейт чтения): имя записи вне
   * видимости актора не подставляется, строка деградирует до id.
   */
  private readableMatch(
    entity: SourceEntity,
    projectId: string,
    scope: VisibilityScope,
    access?: AccessPredicate,
  ): Record<string, unknown> {
    return this.andMatch(
      this.projectFilter(projectId),
      this.visMatch(entity, scope),
      this.accessMatch(access, entity),
      ReportsService.NOT_DELETED,
    );
  }

  // =========================================================================
  // Резолверы пресетов (FR-REPORTS-090 / TODO-253)
  //
  // До этого `run()` звал один `buildSummary()` на любой отчёт, а `preset_key`
  // ехал только метаданными ответа — шесть вкладок («По продажам», «По
  // воронке», «По клиентам», «По активности», «По источникам», «По менеджерам»)
  // рисовали одну и ту же таблицу «Стадия / Сделок / Сумма».
  //
  // Резолвер ДОПОЛНЯЕТ общую сводку, а не заменяет её: `totals` остаются
  // KPI-шапкой экрана, `deals_by_stage`/`orders_by_stage` — тем, что читают уже
  // выпущенные клиенты и CSV-экспорт. Контракт `data_json` аддитивен, поэтому
  // proto-контракт прогона не меняется.
  //
  // `by_managers` обслуживается срезом `deals_by_manager` из `buildSummary`, а
  // custom-отчёт — самой сводкой, поэтому своего резолвера у них нет.
  // =========================================================================

  private presetResolver(
    presetKey: string,
  ):
    | ((
        projectId: string,
        scope: VisibilityScope,
        params: ReportParams,
        access?: AccessPredicate,
      ) => Promise<Record<string, unknown>>)
    | null {
    switch (presetKey) {
      case 'sales':
        return (p, s, q, a) => this.salesSlice(p, s, q, a);
      case 'funnel':
        return (p, s, q, a) => this.funnelSlice(p, s, q, a);
      case 'clients':
        return (p, s, q, a) => this.clientsSlice(p, s, q, a);
      case 'activity':
        return (p, s, q, a) => this.activitySlice(p, s, q, a);
      case 'sources':
        return (p, s, q, a) => this.sourcesSlice(p, s, q, a);
      case 'my_overdue':
        return (p, s, q, a) => this.myOverdueSlice(p, s, q, a);
      default:
        return null;
    }
  }

  /**
   * Срез пресета поверх общей сводки. Fail-soft, как у дашборда: упавший срез
   * не роняет прогон (KPI-шапка уже посчитана), клиент получает метку
   * `preset_partial` и деградирует до общей сводки.
   */
  private async buildPresetSlice(
    presetKey: string | undefined,
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const resolver = presetKey ? this.presetResolver(presetKey) : null;
    if (!resolver) return {};
    try {
      return await resolver(projectId, scope, params, access);
    } catch (err) {
      this.logger.warn(
        `preset '${presetKey}' slice failed (project=${projectId}): ${String(err)}`,
      );
      return { preset_partial: true };
    }
  }

  /**
   * FR-REPORTS-100: обезличенный бенчмарк отдела для `only_own` — средние
   * показатели на менеджера без имён коллег.
   */
  private async buildDepartmentBenchmarkRow(
    projectId: string,
    params: ReportParams,
    access: AccessPredicate | undefined,
    selfId: string,
  ): Promise<Record<string, unknown> | null> {
    const ownerField = OWNER_FIELD.deals;
    const selfDeal = await this.mongo.deals().findOne(
      this.andMatch(this.projectFilter(projectId), ReportsService.NOT_DELETED, {
        [ownerField]: selfId,
      }),
      { projection: { departmentId: 1, department_id: 1 } },
    );
    const deptId = String(selfDeal?.departmentId ?? selfDeal?.department_id ?? '').trim();
    if (!deptId) return null;

    const deptMatch = this.andMatch(
      this.projectFilter(projectId),
      this.accessMatch(access, 'deals'),
      ReportsService.NOT_DELETED,
      ...this.paramFragments(params, 'deals'),
      { $or: [{ departmentId: deptId }, { department_id: deptId }] },
    );
    const agg = await this.mongo
      .deals()
      .aggregate([
        { $match: deptMatch },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
            won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
            managers: { $addToSet: { $ifNull: ['$assigneeId', '$ownerId'] } },
          },
        },
      ])
      .toArray();
    const row = agg[0];
    if (!row) return null;
    const mgrCount = Array.isArray(row.managers)
      ? (row.managers as unknown[]).filter((m) => m != null && m !== '').length
      : 0;
    const denom = Math.max(1, mgrCount);
    const count = Number(row.count ?? 0);
    const amount = Number(row.amount ?? 0);
    const won = Number(row.won ?? 0);
    const lost = Number(row.lost ?? 0);
    return {
      manager_id: DEPARTMENT_BENCHMARK_MANAGER_ID,
      manager_name: 'Среднее по отделу',
      row_kind: 'department_benchmark',
      count: Math.round((count / denom) * 10) / 10,
      amount: Math.round((amount / denom) * 100) / 100,
      won: Math.round((won / denom) * 10) / 10,
      lost: Math.round((lost / denom) * 10) / 10,
    };
  }

  /** TODO-473: срез order_types в прогоне (зеркало getMetrics). */
  private async orderTypesSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const match = this.sourceMatch('orders', projectId, scope, params, access);
    const rows = await this.mongo
      .orders()
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ['$typeId', '$type_id', ''] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray();
    return {
      order_types: rows.map((r) => ({
        order_type_id: String(r._id ?? ''),
        orders_count: Number(r.count ?? 0),
      })),
    };
  }

  private specEntity(spec: Record<string, unknown>): SourceEntity {
    const raw = String(spec.entity ?? 'deals').trim().toLowerCase();
    if (raw === 'order' || raw === 'orders') return 'orders';
    if (raw === 'contact' || raw === 'contacts') return 'contacts';
    if (raw === 'company' || raw === 'companies') return 'companies';
    if (raw === 'activity' || raw === 'activities') return 'activities';
    return 'deals';
  }

  /** Имя поля spec не должно становиться Mongo-оператором (`$where` и т.п.). */
  private static isSafeMongoField(field: string): boolean {
    if (!field || field.includes('\0')) return false;
    return field.split('.').every((p) => p.length > 0 && !p.startsWith('$'));
  }

  /** FR-REPORTS-360: фильтры custom spec → Mongo-фрагменты (только eq/ne). */
  private specFilterFragments(
    spec: Record<string, unknown>,
    entity: SourceEntity,
  ): Record<string, unknown>[] {
    const filters = spec.filters;
    if (!Array.isArray(filters)) return [];
    const out: Record<string, unknown>[] = [];
    for (const raw of filters) {
      if (!raw || typeof raw !== 'object') continue;
      const f = raw as { field?: string; operator?: string; value?: unknown };
      const field = String(f.field ?? '').trim();
      const op = String(f.operator ?? 'eq').trim().toLowerCase();
      const value = f.value;
      if (!field || !ReportsService.isSafeMongoField(field)) continue;
      if (value === undefined || value === null || value === '') continue;
      const dual = (camel: string, snake: string, v: unknown) => ({
        $or: [{ [camel]: v }, { [snake]: v }],
      });
      const scalar = typeof value === 'number' ? value : String(value);
      if (field === 'stage' || field === 'stageId' || field === 'stage_id') {
        out.push(dual('stageId', 'stage_id', scalar));
      } else if (field === 'manager' || field === 'managerId' || field === 'manager_id') {
        const ownerField = OWNER_FIELD[entity];
        if (ownerField) out.push({ [ownerField]: scalar });
      } else if (field === 'department' || field === 'departmentId' || field === 'department_id') {
        out.push(dual('departmentId', 'department_id', scalar));
      } else if (field === 'source' || field === 'sourceId') {
        out.push(dual('sourceId', 'source', scalar));
      } else if (op === 'ne' || op === 'neq') {
        out.push({ [field]: { $ne: scalar } });
      } else {
        out.push({ [field]: scalar });
      }
    }
    const dr = spec.dateRange;
    if (dr && typeof dr === 'object' && !Array.isArray(dr)) {
      const from = Number((dr as { from?: number }).from);
      const to = Number((dr as { to?: number }).to);
      if (Number.isFinite(from) && Number.isFinite(to) && from <= to) {
        out.push(this.dateMatch({ period: 'custom', from, to }));
      }
    }
    return out;
  }

  /**
   * FR-REPORTS-360: прогон custom-отчёта по declarative spec (конструктор).
   */
  private async customSlice(
    projectId: string,
    spec: Record<string, unknown>,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const entity = this.specEntity(spec);
    const groupField = String(
      (spec.groupBy as Array<{ field?: string }> | undefined)?.[0]?.field ?? '',
    ).trim();
    if (!groupField || !ReportsService.isSafeMongoField(groupField)) {
      return { custom_partial: true };
    }
    const measure = (spec.measures as Array<{ fn?: string; field?: string }> | undefined)?.[0];
    const fn = String(measure?.fn ?? 'count').toLowerCase();
    const measureField = String(measure?.field ?? 'amount').trim();
    if (measureField && !ReportsService.isSafeMongoField(measureField)) {
      return { custom_partial: true };
    }

    const match = this.andMatch(
      this.sourceMatch(entity, projectId, scope, params, access),
      ...this.specFilterFragments(spec, entity),
    );

    const groupId =
      groupField === 'stage' || groupField === 'stageId'
        ? { $ifNull: ['$stageId', '$stage_id', ''] }
        : groupField === 'manager' || groupField === 'managerId'
          ? { $ifNull: ['$assigneeId', '$ownerId', ''] }
          : groupField === 'department' || groupField === 'departmentId'
            ? { $ifNull: ['$departmentId', '$department_id', ''] }
            : groupField === 'source'
              ? { $ifNull: ['$sourceId', '$source', ''] }
              : `$${groupField}`;

    const valueExpr =
      fn === 'sum'
        ? { $sum: `$${measureField}` }
        : fn === 'avg'
          ? { $avg: `$${measureField}` }
          : { $sum: 1 };

    const collection =
      entity === 'activities'
        ? this.mongo.activities()
        : entity === 'contacts'
          ? this.mongo.contacts()
          : entity === 'companies'
            ? this.mongo.companies()
            : entity === 'orders'
              ? this.mongo.orders()
              : this.mongo.deals();

    const rows = await collection
      .aggregate([
        { $match: match },
        { $group: { _id: groupId, value: valueExpr } },
        { $sort: { value: -1, _id: 1 } },
      ])
      .toArray();

    return {
      custom_table: {
        group_field: groupField,
        measure_fn: fn,
        rows: rows.map((r) => ({
          key: String(r._id ?? ''),
          value: Number(r.value ?? 0),
        })),
      },
    };
  }

  /** Процент с одним знаком (та же шкала, что у `deals_by_department.conversion`). */
  private static percent(part: number, whole: number): number {
    return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
  }

  /**
   * `sales` — динамика по дням, средний чек и исход сделок (FR-REPORTS-080,
   * каталог пресетов: new/Won/Lost, сумма, средний чек, конверсия, динамика).
   * День считается на стороне Mongo в ЗОНЕ СТАТИСТИКИ — той же, в которой
   * резолвятся границы периода, иначе крайние дни окна отваливаются.
   */
  private async salesSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const match = this.sourceMatch('deals', projectId, scope, params, access);
    const [dynamics, byStatus] = await Promise.all([
      this.mongo
        .deals()
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: { $toDate: { $ifNull: ['$createdAt', '$created_at'] } },
                  timezone: this.statisticsTz(),
                },
              },
              count: { $sum: 1 },
              amount: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      this.mongo
        .deals()
        .aggregate([
          { $match: match },
          { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
        ])
        .toArray(),
    ]);

    let count = 0;
    let amount = 0;
    let wonCount = 0;
    let wonAmount = 0;
    let lostCount = 0;
    for (const row of byStatus) {
      const c = Number(row.count ?? 0);
      const a = Number(row.amount ?? 0);
      count += c;
      amount += a;
      if (String(row._id ?? '') === 'won') {
        wonCount += c;
        wonAmount += a;
      }
      if (String(row._id ?? '') === 'lost') lostCount += c;
    }

    return {
      // Записи без распознаваемой даты создания в серию не попадают (bucket=null),
      // но в средний чек и итоги — да: они считаются по статусам, а не по дням.
      sales_dynamics: dynamics
        .filter((row) => typeof row._id === 'string' && row._id)
        .map((row) => ({
          bucket: String(row._id),
          count: Number(row.count ?? 0),
          amount: Number(row.amount ?? 0),
        })),
      sales_totals: {
        count,
        amount,
        won_count: wonCount,
        won_amount: wonAmount,
        lost_count: lostCount,
        open_count: Math.max(0, count - wonCount - lostCount),
        avg_check: count > 0 ? amount / count : 0,
        // доля выигранных сделок среди попавших в окно, %
        conversion: ReportsService.percent(wonCount, count),
      },
    };
  }

  /**
   * `funnel` — стадии В ПОРЯДКЕ ВОРОНКИ с конверсией от входной стадии и от
   * предыдущей, плюс «зависшие» (нет движения по стадии дольше N дней —
   * тот же порог `STATISTICS_STALLED_DAYS`, что у виджета дашборда).
   * Порядок и имена стадий — у домена-владельца (pipe); pipe недоступен →
   * прежняя деградация: порядок по количеству, подпись = id стадии.
   */
  private async funnelSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const match = this.sourceMatch('deals', projectId, scope, params, access);
    const staleDays = this.stalledDaysValue(params);
    const stalledBefore = Date.now() - staleDays * 86_400_000;
    // Момент входа в стадию: `$ifNull` возвращает ПЕРВОЕ не-null значение, а не
    // «последнее как замену», поэтому 0-заглушка нужна явным последним звеном —
    // иначе `$lt: [null, X]` считал бы «зависшими» записи вообще без дат.
    const enteredAt = { $ifNull: ['$stageEnteredAt', '$stage_entered_at', '$updatedAt', 0] };
    const rows = await this.mongo
      .deals()
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ['$stageId', '$stage_id'] },
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
            stalled: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $not: [{ $in: ['$status', DEAL_CLOSED_STATUSES] }] },
                      { $gt: [enteredAt, 0] },
                      { $lt: [enteredAt, stalledBefore] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray();

    // Карта стадий — best-effort: отчёт не должен падать из-за недоступного pipe.
    const stages = await this.loadStages(projectId, params.pipelineId).catch((err: unknown) => {
      this.logger.warn(`funnel preset: pipe stages unavailable (project=${projectId}): ${String(err)}`);
      return null;
    });
    const ordered = this.orderByStage(
      rows.map((row) => ({
        key: String(row._id ?? ''),
        label: String(row._id ?? ''),
        count: Number(row.count ?? 0),
        amount: Number(row.amount ?? 0),
        stalled: Number(row.stalled ?? 0),
      })),
      stages,
    );
    const entry = ordered[0]?.count ?? 0;
    let prev = 0;
    const funnelStages = ordered.map((row, i) => {
      const fromPrev = i === 0 ? 100 : ReportsService.percent(row.count, prev);
      prev = row.count;
      return {
        stage_id: row.key,
        stage_name: row.label,
        count: row.count,
        amount: row.amount,
        stalled: row.stalled,
        // от входной стадии воронки и от предыдущей стадии, %
        conversion: ReportsService.percent(row.count, entry),
        conversion_from_prev: fromPrev,
      };
    });
    return { funnel_stages: funnelStages, stalled_days: staleDays };
  }

  /**
   * `clients` — новые контакты/компании за окно, топ-10 компаний по выручке и
   * контакты без сделок (каталог пресетов: contact+company+pipe).
   * Имена компаний резолвятся ТЕМ ЖЕ гейтом чтения, что список компаний:
   * компания вне видимости актора остаётся идентификатором.
   */
  private async clientsSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const contactsMatch = this.sourceMatch('contacts', projectId, scope, params, access);
    const companiesMatch = this.sourceMatch('companies', projectId, scope, params, access);
    const dealsMatch = this.sourceMatch('deals', projectId, scope, params, access);

    const [contactsNew, companiesNew, byCompany, linkedRows] = await Promise.all([
      this.mongo.contacts().countDocuments(contactsMatch),
      this.mongo.companies().countDocuments(companiesMatch),
      this.mongo
        .deals()
        .aggregate([
          { $match: dealsMatch },
          {
            $group: {
              _id: { $ifNull: ['$companyId', '$company_id', ''] },
              count: { $sum: 1 },
              amount: { $sum: '$amount' },
            },
          },
          { $sort: { amount: -1, _id: 1 } },
          { $limit: 10 },
        ])
        .toArray(),
      // Контакты, у которых есть хоть одна сделка в этом же срезе. Набор
      // ограничен сверху: «контакты без сделок» — справочная метрика, ради
      // которой нельзя тянуть в память неограниченный список идентификаторов.
      this.mongo
        .deals()
        .aggregate([
          { $match: dealsMatch },
          { $group: { _id: { $ifNull: ['$contactId', '$contact_id', ''] } } },
          { $limit: CLIENTS_LINKED_LIMIT + 1 },
        ])
        .toArray(),
    ]);

    const linkedIds = linkedRows.map((row) => String(row._id ?? '')).filter(Boolean);
    let contactsWithoutDeals: number | undefined;
    if (linkedIds.length <= CLIENTS_LINKED_LIMIT) {
      const oids = linkedIds.filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
      contactsWithoutDeals = await this.mongo
        .contacts()
        .countDocuments(
          this.andMatch(contactsMatch, oids.length ? { _id: { $nin: oids } } : null),
        );
    }

    const companyIds = byCompany.map((row) => String(row._id ?? '')).filter(Boolean);
    const names = await this.companyNames(projectId, scope, access, companyIds);

    const contactQuality = await this.fetchContactQualityMetrics(projectId, scope, access).catch(
      () => null,
    );

    return {
      clients_totals: {
        contacts_new: contactsNew,
        companies_new: companiesNew,
        // Поля нет, когда связей больше предела — лучше не показать метрику,
        // чем показать посчитанную по обрезанному набору.
        ...(contactsWithoutDeals === undefined
          ? {}
          : { contacts_without_deals: contactsWithoutDeals }),
      },
      ...(contactQuality
        ? {
            contact_quality: {
              total_contacts: contactQuality.totalContacts,
              filled_both_pct: contactQuality.filledBothPct,
              duplicate_candidate_pairs: contactQuality.duplicateCandidatePairs,
              open_drift_links: contactQuality.openDriftLinks,
            },
          }
        : {}),
      top_companies: byCompany.map((row) => {
        const id = String(row._id ?? '');
        return {
          company_id: id,
          company_name: names.get(id) ?? '',
          count: Number(row.count ?? 0),
          amount: Number(row.amount ?? 0),
        };
      }),
    };
  }

  /** id компании → название (только те, что актор вправе видеть). */
  private async companyNames(
    projectId: string,
    scope: VisibilityScope,
    access: AccessPredicate | undefined,
    ids: string[],
  ): Promise<Map<string, string>> {
    const oids = ids.filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (oids.length === 0) return new Map();
    const rows = await this.mongo
      .companies()
      .find(
        this.andMatch(this.readableMatch('companies', projectId, scope, access), {
          _id: { $in: oids },
        }),
      )
      .limit(oids.length)
      .toArray();
    const byId = new Map<string, string>();
    for (const row of rows) {
      const name = String(row.name ?? '').trim();
      if (name) byId.set(String(row._id ?? ''), name);
    }
    return byId;
  }

  /**
   * `activity` — активности по типам и по менеджерам + просрочки (каталог
   * пресетов, домен-источник activity). «Просрочено» считается по НЕтерминальным
   * статусам и наступившему сроку — так же, как виджет просрочек дашборда.
   */
  private async activitySlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const match = this.sourceMatch('activities', projectId, scope, params, access);
    const now = Date.now();
    const dueAt = { $ifNull: ['$dueDate', '$due_date', '$dueAt', 0] };
    const overdue = {
      $sum: {
        $cond: [
          {
            $and: [
              { $not: [{ $in: ['$status', ACTIVITY_TERMINAL] }] },
              { $gt: [dueAt, 0] },
              { $lt: [dueAt, now] },
            ],
          },
          1,
          0,
        ],
      },
    };
    const completed = { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } };
    const open = {
      $sum: { $cond: [{ $not: [{ $in: ['$status', ACTIVITY_TERMINAL] }] }, 1, 0] },
    };

    const [byType, byManager] = await Promise.all([
      this.mongo
        .activities()
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: { $ifNull: ['$type', 'task'] },
              count: { $sum: 1 },
              completed,
              overdue,
              open,
            },
          },
          { $sort: { count: -1, _id: 1 } },
        ])
        .toArray(),
      this.mongo
        .activities()
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: { $ifNull: ['$assigneeId', '$ownerId', ''] },
              count: { $sum: 1 },
              completed,
              overdue,
              open,
            },
          },
          { $sort: { count: -1, _id: 1 } },
        ])
        .toArray(),
    ]);

    const totals = { count: 0, completed: 0, overdue: 0, open: 0 };
    for (const row of byType) {
      totals.count += Number(row.count ?? 0);
      totals.completed += Number(row.completed ?? 0);
      totals.overdue += Number(row.overdue ?? 0);
      totals.open += Number(row.open ?? 0);
    }

    const shape = (row: Record<string, unknown>, key: 'type' | 'manager_id') => ({
      [key]: String(row._id ?? ''),
      count: Number(row.count ?? 0),
      completed: Number(row.completed ?? 0),
      overdue: Number(row.overdue ?? 0),
      open: Number(row.open ?? 0),
    });

    return {
      activity_totals: totals,
      activities_by_type: byType.map((row) => shape(row, 'type')),
      activities_by_manager: byManager.map((row) => shape(row, 'manager_id')),
    };
  }

  /**
   * FR-REPORTS-110 / FR-MREP-9: персональный срез просрочек для Member —
   * просроченные активности в scope исполнителя и сделки без связанной активности
   * дольше `stalledDays`.
   */
  private async myOverdueSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const now = Date.now();
    const staleDays = this.stalledDaysValue(params);
    const inactiveBefore = now - staleDays * 86_400_000;

    const overdueActMatch = this.andMatch(
      this.sourceMatch('activities', projectId, scope, params, access),
      { status: { $nin: ACTIVITY_TERMINAL } },
      overdueDueMatch(now),
    );

    const overdueActivities = await this.mongo
      .activities()
      .find(overdueActMatch)
      .sort({ dueDate: 1, due_date: 1, _id: 1 })
      .limit(500)
      .toArray();

    const dealsMatch = this.andMatch(
      this.sourceMatch('deals', projectId, scope, params, access),
      { status: { $nin: DEAL_CLOSED_STATUSES } },
    );

    const recentLinked = await this.mongo
      .activities()
      .aggregate([
        {
          $match: this.andMatch(
            this.projectFilter(projectId),
            this.visMatch('activities', scope),
            this.accessMatch(access, 'activities'),
            ReportsService.NOT_DELETED,
            {
              $or: [
                { updatedAt: { $gte: inactiveBefore } },
                { updated_at: { $gte: inactiveBefore } },
              ],
            },
            { links: { $elemMatch: { entityType: 'deal' } } },
          ),
        },
        { $unwind: '$links' },
        { $match: { 'links.entityType': 'deal', 'links.entityId': { $nin: [null, ''] } } },
        { $group: { _id: '$links.entityId' } },
      ])
      .toArray();
    const activeDealIds = new Set(recentLinked.map((r) => String(r._id ?? '')));

    const candidateDeals = await this.mongo
      .deals()
      .find(
        this.andMatch(dealsMatch, {
          $or: [
            { updatedAt: { $lt: inactiveBefore } },
            { updated_at: { $lt: inactiveBefore } },
          ],
        }),
      )
      .sort({ amount: -1, _id: 1 })
      .limit(500)
      .toArray();

    const inactiveDeals = candidateDeals
      .filter((d) => !activeDealIds.has(String(d._id ?? '')))
      .map((d) => {
        const updated = Number(d.updatedAt ?? d.updated_at ?? now);
        return {
          deal_id: String(d._id ?? ''),
          name: String(d.name ?? d.title ?? ''),
          amount: Number(d.amount ?? 0),
          stage_id: String(d.stageId ?? d.stage_id ?? ''),
          days_inactive: Math.max(0, Math.floor((now - updated) / 86_400_000)),
        };
      });

    return {
      my_overdue_totals: {
        overdue_activities: overdueActivities.length,
        inactive_deals: inactiveDeals.length,
        stalled_days: staleDays,
      },
      my_overdue_activities: overdueActivities.map((a) => ({
        activity_id: String(a._id ?? ''),
        title: String(a.title ?? a.name ?? ''),
        type: String(a.type ?? 'task'),
        due_at: Number(a.dueDate ?? a.due_date ?? 0),
        assignee_id: String(a.assigneeId ?? a.ownerId ?? ''),
      })),
      my_inactive_deals: inactiveDeals,
    };
  }

  /**
   * FR-REPORTS-380: компактный срез для виджета в карточке deal/company.
   */
  private async buildEntityMiniSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const entityType = params.entityType?.trim();
    const entityId = params.entityId?.trim();
    if (!entityType || !entityId) return {};

    const now = Date.now();
    if (entityType === 'deal') {
      if (!ObjectId.isValid(entityId)) {
        return { entity_mini: { entity_type: 'deal', entity_id: entityId, found: false } };
      }
      const deal = await this.mongo.deals().findOne(
        this.andMatch(
          this.projectFilter(projectId),
          this.visMatch('deals', scope),
          this.accessMatch(access, 'deals'),
          ReportsService.NOT_DELETED,
          { _id: new ObjectId(entityId) },
        ),
      );
      if (!deal) {
        return { entity_mini: { entity_type: 'deal', entity_id: entityId, found: false } };
      }
      const actMatch = this.andMatch(
        this.projectFilter(projectId),
        this.visMatch('activities', scope),
        this.accessMatch(access, 'activities'),
        ReportsService.NOT_DELETED,
        { links: { $elemMatch: { entityType: 'deal', entityId } } },
      );
      const [totalAct, overdueAct] = await Promise.all([
        this.mongo.activities().countDocuments(actMatch),
        this.mongo.activities().countDocuments(
          this.andMatch(actMatch, { status: { $nin: ACTIVITY_TERMINAL } }, {
            $or: [
              { dueDate: { $gt: 0, $lt: now } },
              { due_date: { $gt: 0, $lt: now } },
            ],
          }),
        ),
      ]);
      return {
        entity_mini: {
          entity_type: 'deal',
          entity_id: entityId,
          found: true,
          name: String(deal.name ?? ''),
          amount: Number(deal.amount ?? 0),
          stage_id: String(deal.stageId ?? deal.stage_id ?? ''),
          status: String(deal.status ?? ''),
          activities_total: totalAct,
          activities_overdue: overdueAct,
        },
      };
    }

    if (entityType === 'company') {
      if (!ObjectId.isValid(entityId)) {
        return { entity_mini: { entity_type: 'company', entity_id: entityId, found: false } };
      }
      const company = await this.mongo.companies().findOne(
        this.andMatch(
          this.projectFilter(projectId),
          this.visMatch('companies', scope),
          this.accessMatch(access, 'companies'),
          ReportsService.NOT_DELETED,
          { _id: new ObjectId(entityId) },
        ),
      );
      if (!company) {
        return { entity_mini: { entity_type: 'company', entity_id: entityId, found: false } };
      }
      const dealsMatch = this.andMatch(
        this.projectFilter(projectId),
        this.visMatch('deals', scope),
        this.accessMatch(access, 'deals'),
        ReportsService.NOT_DELETED,
        {
          $or: [{ companyId: entityId }, { company_id: entityId }],
        },
      );
      const actMatch = this.andMatch(
        this.projectFilter(projectId),
        this.visMatch('activities', scope),
        this.accessMatch(access, 'activities'),
        ReportsService.NOT_DELETED,
        { links: { $elemMatch: { entityType: 'company', entityId } } },
      );
      const [dealsCount, dealsAmountAgg, overdueAct] = await Promise.all([
        this.mongo.deals().countDocuments(dealsMatch),
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            { $group: { _id: null, amount: { $sum: '$amount' } } },
          ])
          .toArray(),
        this.mongo.activities().countDocuments(
          this.andMatch(actMatch, { status: { $nin: ACTIVITY_TERMINAL } }, {
            $or: [
              { dueDate: { $gt: 0, $lt: now } },
              { due_date: { $gt: 0, $lt: now } },
            ],
          }),
        ),
      ]);
      return {
        entity_mini: {
          entity_type: 'company',
          entity_id: entityId,
          found: true,
          name: String(company.name ?? ''),
          deals_count: dealsCount,
          deals_amount: Number(dealsAmountAgg[0]?.amount ?? 0),
          activities_overdue: overdueAct,
        },
      };
    }

    return {};
  }

  /**
   * `sources` — сделки по источникам: объём, выручка, выигранные, конверсия и
   * средний чек (каталог пресетов). Тот же ключ группировки, что у виджета
   * «Источники» дашборда, чтобы одна сделка не попадала в разные корзины на
   * двух экранах.
   */
  private async sourcesSlice(
    projectId: string,
    scope: VisibilityScope,
    params: ReportParams,
    access?: AccessPredicate,
  ): Promise<Record<string, unknown>> {
    const match = this.sourceMatch('deals', projectId, scope, params, access);
    const rows = await this.mongo
      .deals()
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ['$sourceId', '$source', ''] },
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
            won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
          },
        },
        { $sort: { amount: -1, _id: 1 } },
      ])
      .toArray();
    return {
      deals_by_source: rows.map((row) => {
        const count = Number(row.count ?? 0);
        const amount = Number(row.amount ?? 0);
        const won = Number(row.won ?? 0);
        return {
          // Сырой ключ источника (может быть пустым — «не указан»): по нему
          // фронт делает drill, подпись он рисует сам.
          source: String(row._id ?? ''),
          count,
          amount,
          won,
          conversion: ReportsService.percent(won, count),
          avg_check: count > 0 ? amount / count : 0,
        };
      }),
    };
  }

  async run(
    projectId: string,
    id: string,
    paramsJson?: string,
    scope?: VisibilityScope,
    userId?: string,
    // When called from export() we suppress `report.generated` so a single user
    // action emits exactly one fact (`report.exported`), not two.
    emitGenerated = true,
    access?: AccessPredicate,
    // TODO-475: серверный идентификатор вызова (`x-gw-call-id`). Одинаков у
    // ретрая транспорта (метадата та же) и различен у двух осознанных вызовов —
    // из него собирается ключ идемпотентности факта аудита. Клиентские заголовки
    // сюда не доезжают (см. reports.grpc.controller#callId).
    callId?: string,
    enabledModules?: string[],
  ) {
    this.assertProjectId(projectId);
    const effectiveScope = this.assertScope(scope);
    // TODO-466: прогон читает определение ТЕМ ЖЕ гейтом, что и list/get —
    // иначе чужой личный отчёт нельзя было бы увидеть, но можно было бы
    // прогнать и выгрузить по прямому id.
    const report = await this.get(projectId, id, userId);
    this.assertPresetModules(report.preset_key, enabledModules);
    const params = this.parseParams(paramsJson);
    const reportSpec = report.spec_json?.trim()
      ? (JSON.parse(report.spec_json) as Record<string, unknown>)
      : null;
    const cacheKey = this.aggregateCacheKey(
      projectId,
      report.id,
      report.preset_key,
      effectiveScope,
      params,
    );
    const cached = this.aggregateCache.get(cacheKey);
    let fullPayload: Record<string, unknown>;
    const generatedAt = Date.now();
    if (cached && Date.now() - cached.at < this.aggregateCacheTtlMs) {
      fullPayload = { ...cached.payload, generated_at: generatedAt };
    } else {
      const ordersEnabled = !enabledModules?.length || enabledModules.includes('orders');
      const [summary, presetSlice, entityMini, customData, orderTypesData] = await Promise.all([
        this.buildSummary(projectId, effectiveScope, params, access),
        this.buildPresetSlice(report.preset_key, projectId, effectiveScope, params, access),
        this.buildEntityMiniSlice(projectId, effectiveScope, params, access),
        !report.preset_key && reportSpec
          ? this.customSlice(projectId, reportSpec, effectiveScope, params, access)
          : Promise.resolve({}),
        ordersEnabled
          ? this.orderTypesSlice(projectId, effectiveScope, params, access)
          : Promise.resolve({}),
      ]);
      const catalog = catalogForRun(
        report.preset_key,
        reportSpec,
        this.stalledDaysValue(params),
      );
      fullPayload = {
        report_kind: report.kind,
        preset_key: report.preset_key,
        generated_at: generatedAt,
        params,
        scope_note: 'Данные в рамках вашей видимости',
        stalled_days: this.stalledDaysValue(params),
        viz: catalog.viz,
        metric_formulas: catalog.metric_formulas,
        ...summary,
        ...presetSlice,
        ...entityMini,
        ...customData,
        ...orderTypesData,
      };
      this.aggregateCache.set(cacheKey, { at: Date.now(), payload: fullPayload });
    }

    const paginated = this.applyAggregatePagination(
      fullPayload,
      report.preset_key,
      params,
    );

    // RFC-4 §3.8: `report.generated` fact via the outbox (audit consumes it).
    if (emitGenerated) {
      await this.emit(
        'report.generated',
        projectId,
        report.id,
        {
          reportId: report.id,
          reportKind: report.kind,
          scopeHash: this.scopeHash(effectiveScope),
          scopeLevel: effectiveScope.level,
          generatedAt,
        },
        userId,
        this.factKey('report.generated', report.id, effectiveScope, callId),
      );
    }

    const summary = fullPayload as {
      totals?: Record<string, number>;
      deals_by_stage?: Array<{ stage_id: string; count: number; amount: number }>;
      orders_by_stage?: Array<{ stage_id: string; count: number }>;
    };

    return {
      report_id: report.id,
      report_name: report.name,
      // preset_key и в определении отчёта, и в ответе прогона: фронт сопоставляет
      // вкладку с отчётом по ключу пресета, а не по порядковому индексу.
      preset_key: report.preset_key,
      data_json: JSON.stringify(paginated),
      generated_at: generatedAt,
      // Additive typed mirror of the aggregates in `data_json` (proto ReportSummary,
      // P2.f). Byte-for-byte `data_json` is preserved for existing clients.
      summary: {
        totals: summary.totals,
        deals_by_stage: summary.deals_by_stage,
        orders_by_stage: summary.orders_by_stage,
      },
    };
  }

  /**
   * TODO-297: CSV-ячейка — кавычим при разделителе/кавычке/переводе строки И
   * гасим formula injection (CWE-1236). Сюда попадают идентификаторы стадий,
   * которые заводит пользователь: `stage_id` с запятой рвал колонки, а значение
   * вида `=HYPERLINK("http://evil","click")` Excel/LibreOffice/Sheets выполняли
   * как формулу при открытии выгрузки. Ведущий апостроф — канонический приём:
   * в таблице он не отображается, значение читается как текст. Числа (в т.ч.
   * отрицательные) не трогаем — `-5` обязано остаться числом.
   */
  private static csvCell(v: unknown): string {
    const raw = v == null ? '' : String(v);
    const s = /^[+-]?\d+(\.\d+)?$/.test(raw.trim())
      ? raw
      : /^[=+\-@\t\r]/.test(raw)
        ? `'${raw}`
        : raw;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private toCsv(
    data: {
      report_kind: string;
      generated_at: number;
      totals: Record<string, number>;
      deals_by_stage: Array<{ stage_id: string; count: number; amount: number }>;
      orders_by_stage: Array<{ stage_id: string; count: number }>;
    } & Record<string, unknown>,
  ): string {
    const cell = ReportsService.csvCell;
    const lines: string[] = ['section,key,value'];
    Object.entries(data.totals).forEach(([key, value]) =>
      lines.push(`totals,${cell(key)},${cell(value)}`),
    );
    data.deals_by_stage.forEach((row) =>
      lines.push(`deals_by_stage,${cell(row.stage_id || 'unknown')},${row.count}:${row.amount}`),
    );
    data.orders_by_stage.forEach((row) =>
      lines.push(`orders_by_stage,${cell(row.stage_id || 'unknown')},${row.count}`),
    );
    // Срез пресета — тот же путь данных, что у прогона (FR-REPORTS-220): без
    // этих секций пользователь вкладки «По источникам»/«По активности» выгружал
    // таблицу стадий, которой на экране не видел.
    for (const [section, dimension, metrics] of CSV_PRESET_SECTIONS) {
      const rows = data[section];
      if (!Array.isArray(rows)) continue;
      for (const raw of rows as Record<string, unknown>[]) {
        // Подпись — человекочитаемое имя, если домен его резолвил (стадия,
        // компания); иначе сырой идентификатор.
        const key = String(raw[`${dimension}_name`] || raw[dimension] || 'unknown');
        lines.push(`${section},${cell(key)},${metrics.map((m) => Number(raw[m] ?? 0)).join(':')}`);
      }
    }
    for (const section of CSV_PRESET_TOTALS) {
      const totals = data[section];
      if (!totals || typeof totals !== 'object' || Array.isArray(totals)) continue;
      Object.entries(totals as Record<string, unknown>).forEach(([key, value]) =>
        lines.push(`${section},${cell(key)},${cell(value)}`),
      );
    }
    return lines.join('\n');
  }

  async export(
    projectId: string,
    id: string,
    format?: string,
    paramsJson?: string,
    scope?: VisibilityScope,
    userId?: string,
    access?: AccessPredicate,
    /** TODO-475: серверный `x-gw-call-id` — см. run(). */
    callId?: string,
    enabledModules?: string[],
  ) {
    // Same data path as run() → scope is never lost on export (FR-MREP-18).
    // emitGenerated=false: export emits its own `report.exported`, not `generated`.
    const runResult = await this.run(
      projectId,
      id,
      paramsJson,
      scope,
      userId,
      false,
      access,
      callId,
      enabledModules,
    );
    const requested = (format ?? 'csv').toLowerCase();
    if (requested !== 'csv' && requested !== 'json') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'format must be csv|json' });
    }
    const exportFormat = requested;
    const parsed = JSON.parse(runResult.data_json) as {
      report_kind: string;
      generated_at: number;
      totals: Record<string, number>;
      deals_by_stage: Array<{ stage_id: string; count: number; amount: number }>;
      orders_by_stage: Array<{ stage_id: string; count: number }>;
    } & Record<string, unknown>;
    let payload = '';
    let contentType = '';
    if (exportFormat === 'csv') {
      payload = this.toCsv(parsed);
      contentType = 'text/csv; charset=utf-8';
    } else {
      payload = JSON.stringify(parsed, null, 2);
      contentType = 'application/json; charset=utf-8';
    }
    const stamp = new Date(runResult.generated_at).toISOString().replace(/[:.]/g, '-');

    // RFC-4 §3.8: export emits `statistics.exported` (canon — NOT `report.exported`;
    // audit binds `statistics.*`). Payload carries no PII/records nor aggregate
    // values — only reportId, format and a scope hash (FR-MSTAT-23).
    await this.emit(
      'statistics.exported',
      projectId,
      runResult.report_id,
      {
        reportId: runResult.report_id,
        reportKind: parsed.report_kind,
        format: exportFormat,
        scopeHash: this.scopeHash(this.assertScope(scope)),
        scopeLevel: this.assertScope(scope).level,
        exportedAt: runResult.generated_at,
      },
      userId,
      this.factKey(
        'statistics.exported',
        runResult.report_id,
        this.assertScope(scope),
        callId,
        exportFormat,
      ),
    );

    return {
      report_id: runResult.report_id,
      format: exportFormat,
      file_name: `report-${runResult.report_id}-${stamp}.${exportFormat === 'csv' ? 'csv' : 'json'}`,
      content_type: contentType,
      payload_base64: Buffer.from(payload, 'utf8').toString('base64'),
      generated_at: runResult.generated_at,
    };
  }

  /**
   * TO-BE (FR-MREP-23): drill-down — the records behind one aggregate cell, under
   * the same scope `$match` as run(). Self-consistency: count == aggregate value.
   * v1 supports the deal stage dimension (stageId/stage_id).
   */
  async drill(
    projectId: string,
    id: string,
    paramsJson: string | undefined,
    dimension: string,
    value: string,
    limit: number,
    cursor: string | undefined,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    /** TODO-466: автор запроса — гейт доступа к личному определению отчёта. */
    userId?: string,
  ) {
    this.assertProjectId(projectId);
    const effectiveScope = this.assertScope(scope);
    const doc = await this.loadDoc(projectId, id, userId);
    // Разобранные params РЕАЛЬНО применяются к выборке — иначе drill показывал
    // записи вне периода/воронки, по которым посчитана ячейка (само-несогласованность).
    const params = this.parseParams(paramsJson);

    // Измерение детализации — из общего контракта DRILL_DIMENSIONS: до этого
    // разворачивалась только стадия, а срезы «по менеджерам»/«по отделам»/
    // «по источникам» рисовали кликабельные строки, которые падали в
    // INVALID_ARGUMENT. TODO-477: у каждого измерения своя сущность (deals vs
    // activities); manager_id на пресете activity — отдельный ключ.
    const dimensionKey =
      dimension === 'manager_id' && doc.presetKey === 'activity'
        ? 'activity_manager_id'
        : dimension;
    const drillSpec = DRILL_DIMENSIONS[dimensionKey];
    if (!drillSpec) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'dimension не поддерживается отчётом',
      });
    }
    // FR-REPORTS-100: синтетическая строка бенчмарка не разворачивается в чужие сделки.
    if (value.trim() === DEPARTMENT_BENCHMARK_MANAGER_ID) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'dimension не поддерживается отчётом',
      });
    }
    const { entity, match: dimensionFragment } = drillSpec;
    const pageSize = Math.max(1, Math.min(limit || 50, 100));
    const entityVis = this.visMatch(entity, effectiveScope);
    // andMatch: project filter and visibility both may carry `$or` (spread drops
    // the project scope — cross-project leak).
    const baseMatch = this.andMatch(
      this.projectFilter(projectId),
      entityVis,
      this.accessMatch(access, entity),
      ReportsService.NOT_DELETED,
      ...this.paramFragments(params, entity),
      dimensionFragment(value),
    );
    // Курсор — отдельным фрагментом через andMatch: присваивание `_id` поверх
    // объекта фильтра затирало бы `_id` deny-all-фрагмента ABAC.
    const match: Record<string, unknown> =
      cursor && ObjectId.isValid(cursor)
        ? this.andMatch(baseMatch, { _id: { $lt: new ObjectId(cursor) } })
        : baseMatch;

    const collection =
      entity === 'activities'
        ? this.mongo.activities()
        : entity === 'contacts'
          ? this.mongo.contacts()
          : entity === 'companies'
            ? this.mongo.companies()
            : entity === 'orders'
              ? this.mongo.orders()
              : this.mongo.deals();

    const total = await collection.countDocuments(baseMatch);
    const rows = await collection
      .find(match)
      .sort({ _id: -1 })
      .limit(pageSize + 1)
      .toArray();
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const nextCursor = hasMore ? String(page[page.length - 1]?._id ?? '') : '';

    return {
      items_json: page.map((d) =>
        JSON.stringify(
          entity === 'activities'
            ? {
                id: String(d._id ?? ''),
                name: String(d.title ?? d.name ?? ''),
                amount: 0,
                ownerId: String(d.assigneeId ?? d.ownerId ?? ''),
                stageId: String(d.type ?? ''),
              }
            : {
                id: String(d._id ?? ''),
                name: String(d.name ?? d.title ?? ''),
                amount: Number(d.amount ?? 0),
                ownerId: String(d.assigneeId ?? d.ownerId ?? ''),
                stageId: String(d.stageId ?? d.stage_id ?? ''),
              },
        ),
      ),
      next_cursor: nextCursor,
      has_more: hasMore,
      total,
    };
  }

  // =========================================================================
  // Statistics dashboard (statistics-module · FR-MSTAT). On-demand,
  // visibility-aware aggregate; statistics owns no store (TZ §1/§5.1) — these
  // metrics are computed in reports over the source domains' Mongo views, in
  // the viewer's scope, fresh on every request (v1; rollup is a TODO below).
  // =========================================================================

  /**
   * FR-MSTAT-7 / V-1: resolve a period into a half-open [from, to) ms window.
   * custom requires from ≤ to. month is the default. INVALID_ARGUMENT maps to
   * the contract's 400 INVALID_PERIOD on the gateway.
   */
  private resolvePeriod(period: string | undefined, from?: number, to?: number): PeriodRange {
    const now = Date.now();
    const kind = (period?.trim() || 'month').toLowerCase();
    switch (kind) {
      case 'today':
        return { period: 'today', from: this.startOfDayTz(now), to: now };
      case 'week': {
        const dow = (this.zoned(now).weekday + 6) % 7; // Monday-based
        return { period: 'week', from: this.startOfDayTz(now - dow * 86_400_000), to: now };
      }
      case 'month': {
        const z = this.zoned(now);
        return { period: 'month', from: this.fromZoned(z.year, z.month, 1), to: now };
      }
      case 'quarter': {
        const z = this.zoned(now);
        const q = Math.floor((z.month - 1) / 3) * 3 + 1;
        return { period: 'quarter', from: this.fromZoned(z.year, q, 1), to: now };
      }
      case 'year': {
        // Селектор периода на фронте отдаёт 'year' (RunPeriod) — без этой ветки
        // выбор «Год» ронял прогон отчёта в INVALID_ARGUMENT.
        const z = this.zoned(now);
        return { period: 'year', from: this.fromZoned(z.year, 1, 1), to: now };
      }
      case 'custom': {
        if (typeof from !== 'number' || typeof to !== 'number' || from <= 0 || to <= 0) {
          throw new RpcException({
            code: status.INVALID_ARGUMENT,
            message: 'period=custom requires from and to',
          });
        }
        if (from > to) {
          throw new RpcException({
            code: status.INVALID_ARGUMENT,
            message: 'period=custom requires from <= to',
          });
        }
        return { period: 'custom', from, to };
      }
      default:
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: 'period must be today|week|month|quarter|year|custom',
        });
    }
  }

  // -------------------------------------------------------------------------
  // Единая таймзона статистики (FR-MSTAT-7). Границы периода и подписи дневных
  // бакетов считаются В ОДНОЙ зоне — `STATISTICS_TZ` (по умолчанию UTC). Раньше
  // границы брались в локальной TZ процесса (`setHours`/`new Date(y,m,1)`), а
  // бакеты — в UTC: при TZ сервера ≠ UTC «сегодня» и подписи расходились, и
  // крайние дни периода частично отваливались.
  // -------------------------------------------------------------------------

  /** Настроенная зона; невалидное значение молча деградирует в UTC (fail-soft). */
  private statisticsTz(): string {
    const tz = process.env.STATISTICS_TZ?.trim();
    if (!tz) return 'UTC';
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(0);
      return tz;
    } catch {
      if (!this.tzWarned) {
        this.tzWarned = true;
        this.logger.warn(`STATISTICS_TZ='${tz}' не распознана — используется UTC`);
      }
      return 'UTC';
    }
  }

  private tzWarned = false;

  /** Календарные поля момента `ts` в зоне статистики. */
  private zoned(ts: number): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
  } {
    const tz = this.statisticsTz();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date(ts));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      // 'en-US' + hour12:false отдаёт полночь как '24' — нормализуем.
      hour: Number(get('hour')) % 24,
      minute: Number(get('minute')),
      second: Number(get('second')),
      weekday: wd < 0 ? new Date(ts).getUTCDay() : wd,
    };
  }

  /** Смещение зоны (мс) в момент `ts`: wall-clock = utc + offset. */
  private tzOffset(ts: number): number {
    const z = this.zoned(ts);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    return asUtc - Math.floor(ts / 1000) * 1000;
  }

  /** epoch ms момента `y-m-d 00:00:00` в зоне статистики (учитывает переход DST). */
  private fromZoned(year: number, month: number, day: number): number {
    const guess = Date.UTC(year, month - 1, day);
    const off1 = this.tzOffset(guess);
    const t1 = guess - off1;
    const off2 = this.tzOffset(t1);
    return off2 === off1 ? t1 : guess - off2;
  }

  /** Начало суток (в зоне статистики) для момента `ts`. */
  private startOfDayTz(ts: number): number {
    const z = this.zoned(ts);
    return this.fromZoned(z.year, z.month, z.day);
  }

  /** Match on any of the common created-at field spellings within the window. */
  private dateMatch(range: PeriodRange): Record<string, unknown> {
    return {
      $or: [
        { createdAt: { $gte: range.from, $lte: range.to } },
        { created_at: { $gte: range.from, $lte: range.to } },
      ],
    };
  }

  /**
   * FR-REPORTS-250: merged stage timeline for a deal card. Reads the reports-owned
   * `stage_transitions` projection; falls back to embedded `stageLog` when the
   * projection is empty (pre-backfill / legacy deals).
   */
  async getDealStageHistory(
    projectId: string,
    dealId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.assertProjectId(projectId);
    const effectiveScope = this.assertScope(scope);
    const deal = await this.mongo.deals().findOne(
      this.andMatch(
        this.projectFilter(projectId),
        { _id: new ObjectId(dealId) },
        this.visMatch('deals', effectiveScope),
        this.accessMatch(access, 'deals'),
        ReportsService.NOT_DELETED,
      ),
      { projection: { stageLog: 1, pipelineId: 1 } },
    );
    if (!deal) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Сделка не найдена' });
    }

    const now = Date.now();
    let rows = await this.stageTransitions.listForDeal(projectId, dealId);
    if (rows.length === 0) {
      const log = (deal.stageLog as Array<Record<string, unknown>> | undefined) ?? [];
      rows = log.map((e, i) => ({
        projectId,
        dealId,
        pipelineId: String(deal.pipelineId ?? ''),
        fromStageId: i === 0 ? '' : String(log[i - 1]?.stageId ?? ''),
        toStageId: String(e.stageId ?? ''),
        enteredAt: Number(e.enteredAt ?? 0),
        exitedAt: Number(e.exitedAt ?? 0) || undefined,
        movedBy: String(e.movedBy ?? ''),
        kind: String(e.kind ?? 'move'),
        messageId: `legacy:${dealId}:${i}`,
        updatedAt: now,
      }));
    }

    const stageMap = await this.loadStages(projectId);
    return {
      entries: rows.map((r) => {
        const end = r.exitedAt && r.exitedAt > 0 ? r.exitedAt : now;
        const duration = r.enteredAt > 0 ? Math.max(0, end - r.enteredAt) : 0;
        return {
          from_stage_id: r.fromStageId,
          to_stage_id: r.toStageId,
          entered_at: r.enteredAt,
          exited_at: r.exitedAt ?? 0,
          moved_by: r.movedBy ?? '',
          kind: r.kind ?? 'move',
          duration_ms: duration,
          label: stageMap?.get(r.toStageId)?.name ?? r.toStageId,
        };
      }),
    };
  }

  /**
   * FR-MSTAT (TZ §5.5): visibility-aware dashboard aggregate. Every `$match`
   * starts with project filter AND the viewer's visibility predicate, so totals
   * cover only records the viewer may see (FR-MSTAT-4). Period (FR-MSTAT-7) is
   * applied as a date window. Fail-soft per provider (FR-MSTAT-15): a source
   * that errors yields an empty widget and sets partial=true, never crashes the
   * screen. asOf = the moment of computation (FR-MSTAT-14).
   *
   * NOTE(P2.f/NFR-010): rollup read-switch applies to project-wide KPIs (`won`,
   * `deals_amount` previous window) and the `sales` analytics slice when the
   * project's backfill marker covers the requested period (`statistics_rollup_state`).
   * Restricted visibility or ABAC on deals keeps the live Mongo aggregation path.
   */
  async getDashboard(
    projectId: string,
    period?: string,
    from?: number,
    to?: number,
    scope?: VisibilityScope,
    enabledModules?: string[],
    access?: AccessPredicate,
  ): Promise<DashboardAggregate> {
    this.assertProjectId(projectId);
    const effectiveScope = this.assertScope(scope);
    const range = this.resolvePeriod(period, from, to);
    const rollupState = await this.rollupCoverage.get(projectId);
    const useRollup =
      canUseRollupRead(effectiveScope, access) &&
      rollupTrustedForRange(this.rollupCoverage, rollupState, range.from);
    const rollupDayFrom = utcDayOf(range.from);
    const rollupDayTo = utcDayOf(range.to - 1);
    const cacheKey = buildAggregateCacheKey({
      projectId,
      metric: 'dashboard',
      scopeHash: this.scopeHash(effectiveScope),
      period: range.period,
      periodFrom: range.period === 'custom' ? range.from : undefined,
      periodTo: range.period === 'custom' ? range.to : undefined,
      modulesKey: modulesCacheKey(enabledModules),
      accessKey: accessCacheKey(access as AggregateAccessPredicate | undefined),
    });
    const cached = this.dashboardCache.get(cacheKey);
    if (cached) return cached;

    const asOf = Date.now();
    let partial = false;

    // Гейт по модулю-источнику (как в getMetrics): выключенный модуль не должен
    // ни считаться, ни отдавать ячейку KPI/список. Неизвестный набор = не гейтим.
    const moduleOn = (mod: string): boolean =>
      !enabledModules || enabledModules.length === 0 || enabledModules.includes(mod);

    const dealsVis = this.visMatch('deals', effectiveScope);
    const ordersVis = this.visMatch('orders', effectiveScope);
    const notDeleted = ReportsService.NOT_DELETED;
    const dateMatch = this.dateMatch(range);
    // andMatch (not spread): project filter, visibility and date each carry an `$or`;
    // spreading would drop the project scope and leak across projects.
    // ABAC — по subject'у КАЖДОГО источника (`bySubject`), а не один фрагмент на все
    // коллекции: правило на `deals` обязано сужать сделки, а не активности.
    const dealsBase = this.andMatch(
      this.projectFilter(projectId),
      dealsVis,
      this.accessMatch(access, 'deals'),
      notDeleted,
    );
    const ordersBase = this.andMatch(
      this.projectFilter(projectId),
      ordersVis,
      this.accessMatch(access, 'orders'),
      notDeleted,
    );
    // KPI counts/sums are period-scoped by created-at; funnel/sources reflect the
    // current state of in-period deals.
    const dealsMatch = this.andMatch(dealsBase, dateMatch);
    // Предыдущее окно той же длины — база для previous_value/growth_rate.
    const prevRange: PeriodRange = {
      period: range.period,
      from: range.from - (range.to - range.from),
      to: range.from,
    };
    const useRollupPrev =
      useRollup && rollupTrustedForRange(this.rollupCoverage, rollupState, prevRange.from);
    const prevRollupDayFrom = utcDayOf(prevRange.from);
    const prevRollupDayTo = utcDayOf(prevRange.to - 1);

    const settle = async <T>(fn: () => Promise<T>, fallback: T, what = 'provider'): Promise<T> => {
      try {
        return await withMetricDeadline(fn);
      } catch (err) {
        partial = true;
        // Fail-soft остаётся fail-soft, но перестаёт быть немым: без строки лога
        // пользователь видел пустой виджет, а в логах не было ничего.
        this.logger.warn(`dashboard ${what} failed (project=${projectId}): ${String(err)}`);
        return fallback;
      }
    };

    /** «Выиграно» — окно по дате ВЫИГРЫША (wonAt), а не по дате создания. */
    const wonMatch = (r: PeriodRange) =>
      this.andMatch(dealsBase, { status: 'won' }, {
        $or: [
          { wonAt: { $gte: r.from, $lte: r.to } },
          { won_at: { $gte: r.from, $lte: r.to } },
        ],
      });
    /** «Сделки в работе» — без выигранных/проигранных (ярлык KPI обязывает). */
    const dealsInProgressMatch = (r: PeriodRange) =>
      this.andMatch(dealsBase, this.dateMatch(r), { status: { $nin: DEAL_CLOSED_STATUSES } });
    /** «Продажи в работе» — только активные статусы каталога orders. */
    const ordersInProgressMatch = (r: PeriodRange) =>
      this.andMatch(ordersBase, this.dateMatch(r), { status: { $in: ORDER_ACTIVE_STATUSES } });

    // --- deals KPI + funnel + sources (source domain: pipe) ---
    const dealsBlock = await settle(async () => {
      const rollupCreated = useRollup
        ? await sumRollupMetric(this.rollupStore, {
            projectId,
            metric: 'deals_created',
            dayFrom: rollupDayFrom,
            dayTo: rollupDayTo,
          })
        : null;
      const rollupWon = useRollup
        ? await sumRollupMetric(this.rollupStore, {
            projectId,
            metric: 'deals_won',
            dayFrom: rollupDayFrom,
            dayTo: rollupDayTo,
          })
        : null;
      const [count, amountAgg, wonAgg, byStage, bySource] = await Promise.all([
        this.mongo.deals().countDocuments(dealsInProgressMatch(range)),
        rollupCreated
          ? Promise.resolve([{ amount: rollupCreated.amount }])
          : this.mongo
              .deals()
              .aggregate([{ $match: dealsMatch }, { $group: { _id: null, amount: { $sum: '$amount' } } }])
              .toArray(),
        rollupWon
          ? Promise.resolve(rollupWon.count)
          : this.mongo.deals().countDocuments(wonMatch(range)),
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            {
              $group: {
                _id: { $ifNull: ['$stageId', '$stage_id'] },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
              },
            },
            { $sort: { count: -1, _id: 1 } },
          ])
          .toArray(),
        this.mongo
          .deals()
          .aggregate([
            { $match: dealsMatch },
            {
              $group: {
                _id: { $ifNull: ['$sourceId', '$source', 'unknown'] },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
              },
            },
            { $sort: { count: -1, _id: 1 } },
          ])
          .toArray(),
      ]);
      return {
        count,
        amount: Number(amountAgg[0]?.amount ?? 0),
        won: wonAgg,
        funnel: byStage.map((r) => ({
          key: String(r._id ?? ''),
          label: String(r._id ?? 'unknown'),
          count: Number(r.count ?? 0),
          amount: Number(r.amount ?? 0),
          suppressed: false,
        })),
        sources: bySource.map((r) => ({
          key: String(r._id ?? 'unknown'),
          label: String(r._id ?? 'Прочее'),
          count: Number(r.count ?? 0),
          amount: Number(r.amount ?? 0),
          suppressed: false,
        })),
      };
    }, { count: 0, amount: 0, won: 0, funnel: [], sources: [] }, 'deals');

    // Порядок и подписи стадий берём у домена-владельца воронки (pipe): без него
    // «воронка» сортировалась по популярности стадии и подписывалась сырым id.
    const stageMap = await settle(() => this.loadStages(projectId), null as StageMap | null, 'pipe stages');

    // --- previous window (FR-MSTAT: сравнение с прошлым периодом) ---
    const prev = await settle(
      async () => {
        const rollupPrevCreated = useRollupPrev
          ? await sumRollupMetric(this.rollupStore, {
              projectId,
              metric: 'deals_created',
              dayFrom: prevRollupDayFrom,
              dayTo: prevRollupDayTo,
            })
          : null;
        const rollupPrevWon = useRollupPrev
          ? await sumRollupMetric(this.rollupStore, {
              projectId,
              metric: 'deals_won',
              dayFrom: prevRollupDayFrom,
              dayTo: prevRollupDayTo,
            })
          : null;
        const [dealsPrev, amountPrev, wonPrev] = await Promise.all([
          this.mongo.deals().countDocuments(dealsInProgressMatch(prevRange)),
          rollupPrevCreated
            ? Promise.resolve([{ amount: rollupPrevCreated.amount }])
            : this.mongo
                .deals()
                .aggregate([
                  { $match: this.andMatch(dealsBase, this.dateMatch(prevRange)) },
                  { $group: { _id: null, amount: { $sum: '$amount' } } },
                ])
                .toArray(),
          rollupPrevWon
            ? Promise.resolve(rollupPrevWon.count)
            : this.mongo.deals().countDocuments(wonMatch(prevRange)),
        ]);
        return {
          count: dealsPrev,
          amount: Number(amountPrev[0]?.amount ?? 0),
          won: wonPrev,
        };
      },
      { count: 0, amount: 0, won: 0 },
      'deals previous window',
    );

    // --- orders-in-progress KPI (source domain: orders) ---
    const ordersEnabled = moduleOn('orders');
    const ordersInProgress = ordersEnabled
      ? await settle(() => this.mongo.orders().countDocuments(ordersInProgressMatch(range)), 0, 'orders')
      : 0;
    const ordersInProgressPrev = ordersEnabled
      ? await settle(
          () => this.mongo.orders().countDocuments(ordersInProgressMatch(prevRange)),
          0,
          'orders previous window',
        )
      : 0;

    // --- activity lists: overdue ≤5 / upcoming ≤5 / recent ≤10 (FR-MSTAT-12) ---
    // Поля активностей — как у домена-владельца: assigneeId (OWNER_FIELD) и
    // dueDate. По ownerId/dueAt предикат видимости и окна сроков не матчили ничего.
    const activitiesEnabled = moduleOn('activities');
    const activityVis = this.visMatch('activities', effectiveScope);
    const actBase = this.andMatch(
      this.projectFilter(projectId),
      activityVis,
      this.accessMatch(access, 'activities'),
      notDeleted,
    );
    const notDone = { $nin: ACTIVITY_TERMINAL };
    const toActivityRef = (d: Record<string, unknown>) => ({
      id: String(d._id ?? ''),
      title: String(d.title ?? d.name ?? d.subject ?? ''),
      due_at: Number(d.dueDate ?? d.due_date ?? d.dueAt ?? 0),
      owner_id: String(d.assigneeId ?? d.ownerId ?? ''),
      // deep_link is filled by gateway/FE (FR-MSTAT-24); domain leaves it empty.
      deep_link: '',
    });

    // Матчи списков объявлены ОДИН раз: по ним же считается полный размер среза
    // (*_total, TODO-498). Разъезд «список по одному фильтру, счётчик по
    // другому» дал бы «+ ещё N» от чужой выборки, поэтому счёт берёт ровно тот
    // же объект, что и find().
    const overdueMatch = { ...actBase, status: notDone, dueDate: { $gt: 0, $lt: asOf } };
    const upcomingMatch = {
      ...actBase,
      status: notDone,
      dueDate: { $gte: asOf, $lte: asOf + 7 * 86_400_000 },
    };
    const recentMatch = actBase;

    const emptyRows: Record<string, unknown>[] = [];
    type Rows = Record<string, unknown>[];
    const [overdue, upcoming, recent, overdueTotal, upcomingTotal, recentTotal]: [
      Rows,
      Rows,
      Rows,
      number,
      number,
      number,
    ] = activitiesEnabled
      ? await Promise.all([
          settle(
            () =>
              this.mongo
                .activities()
                .find(overdueMatch)
                .sort({ dueDate: 1 })
                .limit(DASHBOARD_LIST_LIMIT)
                .toArray(),
            [] as Record<string, unknown>[],
            'activities overdue',
          ),
          settle(
            () =>
              this.mongo
                .activities()
                .find(upcomingMatch)
                .sort({ dueDate: 1 })
                .limit(DASHBOARD_LIST_LIMIT)
                .toArray(),
            [] as Record<string, unknown>[],
            'activities upcoming',
          ),
          settle(
            () =>
              this.mongo
                .activities()
                .find(recentMatch)
                .sort({ updatedAt: -1, _id: -1 })
                .limit(DASHBOARD_RECENT_LIMIT)
                .toArray(),
            [] as Record<string, unknown>[],
            'activities recent',
          ),
          // Счётчики — fail-soft отдельно от списков: упавший count даёт 0, и
          // потребитель (gateway) оставляет длину усечённого списка, а не врёт.
          settle(
            () => this.mongo.activities().countDocuments(overdueMatch),
            0,
            'activities overdue total',
          ),
          settle(
            () => this.mongo.activities().countDocuments(upcomingMatch),
            0,
            'activities upcoming total',
          ),
          settle(
            () => this.mongo.activities().countDocuments(recentMatch),
            0,
            'activities recent total',
          ),
        ])
      : [emptyRows, emptyRows, emptyRows, 0, 0, 0];

    // --- stalled deals: in-progress, no stage movement > N_STALE days (FR-MSTAT-30) ---
    const N_STALE_DAYS = Number(process.env.STATISTICS_STALLED_DAYS ?? 7);
    const stalledBefore = asOf - N_STALE_DAYS * 86_400_000;
    const stalledMatch = this.andMatch(
      dealsBase,
      // Закрытые сделки исключаем по статусу, а не по id стадии
      // (id 'won'/'lost' есть только у демо-сида) — BX-FLOW-1.
      { status: { $nin: DEAL_CLOSED_STATUSES } },
      {
        $or: [
          { stageEnteredAt: { $lt: stalledBefore } },
          { stage_entered_at: { $lt: stalledBefore } },
          { updatedAt: { $lt: stalledBefore } },
        ],
      },
    );
    const [stalled, stalledTotal] = await Promise.all([
      settle(
        () =>
          this.mongo
            .deals()
            .find(stalledMatch)
            .sort({ updatedAt: 1 })
            .limit(DASHBOARD_LIST_LIMIT)
            .toArray(),
        [] as Record<string, unknown>[],
        'stalled deals',
      ),
      settle(() => this.mongo.deals().countDocuments(stalledMatch), 0, 'stalled deals total'),
    ]);

    // previous_value/growth_rate считаются по окну той же длины, сдвинутому
    // назад: фронт рисует индикатор роста ПО ЭТИМ полям, поэтому нули означали
    // «▲ +0%» под каждым KPI (рост, которого нет).
    const kpiCell = (key: string, label: string, value: number, previous: number) => ({
      key,
      label,
      value,
      previous_value: previous,
      growth_rate: previous > 0 ? (value - previous) / previous : 0,
    });

    const result: DashboardAggregate = {
      kpi: [
        kpiCell('deals_in_progress', 'Сделки в работе', dealsBlock.count, prev.count),
        kpiCell('deals_amount', 'Сумма сделок', dealsBlock.amount, prev.amount),
        kpiCell('won', 'Выиграно', dealsBlock.won, prev.won),
        // Ячейка продаж отсутствует, когда модуль orders выключен в проекте.
        ...(ordersEnabled
          ? [kpiCell('orders_in_progress', 'Продажи в работе', ordersInProgress, ordersInProgressPrev)]
          : []),
      ],
      funnel: this.orderByStage(dealsBlock.funnel, stageMap),
      sources: dealsBlock.sources,
      overdue: overdue.map(toActivityRef),
      upcoming: upcoming.map(toActivityRef),
      recent: recent.map(toActivityRef),
      stalled: stalled.map((d) => ({
        id: String(d._id ?? ''),
        name: String(d.name ?? d.title ?? ''),
        amount: Number(d.amount ?? 0),
        owner_id: String(d.assigneeId ?? d.ownerId ?? ''),
        stage_id: String(d.stageId ?? d.stage_id ?? ''),
        stage_entered_at: Number(d.stageEnteredAt ?? d.stage_entered_at ?? d.updatedAt ?? 0),
      })),
      // TODO-498: полный размер каждого среза ДО усечения лимитом — по нему
      // виджет рисует «+ ещё N» (у усечённого списка «длина − показано» = 0).
      overdue_total: overdueTotal,
      upcoming_total: upcomingTotal,
      recent_total: recentTotal,
      stalled_total: stalledTotal,
      as_of: asOf,
      partial,
      scope_level: SCOPE_LEVEL_LABEL[effectiveScope.level] ?? effectiveScope.level,
      period: range.period,
      from: range.from,
      to: range.to,
    };
    this.dashboardCache.set(cacheKey, result);
    return result;
  }

  /**
   * Day bucket 'YYYY-MM-DD' в зоне статистики (FR-MSTAT-17 sales) — та же зона,
   * в которой считаются границы периода, иначе крайние дни отваливаются.
   */
  private dayBucket(ts: number): string {
    const z = this.zoned(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${z.year}-${p(z.month)}-${p(z.day)}`;
  }

  /** Ключ сервисного вызова к домену-владельцу воронки (s2s, не end-user JWT). */
  private serviceApiKey(): string {
    return (
      process.env.REPORTS_SERVICE_API_KEY?.trim() ||
      process.env.GATEWAY_SERVICE_API_KEY?.trim() ||
      ''
    );
  }

  /** ABAC для вызова contact gRPC: маршрутный + предикат источника `contacts`. */
  private contactGrpcAccess(access?: AccessPredicate): AccessPredicate | undefined {
    const routeFrag = this.predicateFragment(access);
    const sourceFrag = this.predicateFragment(this.sourcePredicate(access, 'contacts'));
    if (!routeFrag && !sourceFrag) return access;
    const mongo = this.andMatch(routeFrag, sourceFrag);
    if (!mongo) return { present: false };
    return { present: true, mongo, ir: null };
  }

  private scopedOutboundMetadata(
    projectId: string,
    scope: VisibilityScope,
    access?: AccessPredicate,
  ): Metadata {
    const m = buildServiceOutboundMetadata({ serviceApiKey: this.serviceApiKey() });
    m.set(GW_METADATA.PROJECT_ID, projectId);
    m.set(GW_METADATA.VISIBILITY_SCOPE, serializeVisibilityScope(scope));
    const contactAccess = this.contactGrpcAccess(access);
    if (contactAccess?.present && contactAccess.malformed) {
      m.set(
        GW_METADATA.ACCESS_PREDICATE,
        serializeCompiledPredicate({ ir: null, mongo: { _id: { $exists: false } } }),
      );
    } else if (
      contactAccess?.present &&
      contactAccess.malformed !== true &&
      'mongo' in contactAccess &&
      contactAccess.mongo
    ) {
      m.set(
        GW_METADATA.ACCESS_PREDICATE,
        serializeCompiledPredicate({
          ir: 'ir' in contactAccess ? contactAccess.ir ?? null : null,
          mongo: contactAccess.mongo,
        }),
      );
    }
    return m;
  }

  /** FR-CONTACTS-440: агрегаты качества базы из домена contacts (visibility-aware). */
  private async fetchContactQualityMetrics(
    projectId: string,
    scope: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<{
    totalContacts: number;
    filledBothPct: number;
    duplicateCandidatePairs: number;
    openDriftLinks: number;
  }> {
    const md = this.scopedOutboundMetadata(projectId, scope, access);
    const res = await firstValueFrom(
      this.contactGrpc
        .getContactQualityMetrics({ project_id: projectId }, md)
        .pipe(timeout({ each: 2_000 })),
    );
    return {
      totalContacts: Number(res?.total_contacts ?? 0),
      filledBothPct: Number(res?.filled_both_pct ?? 0),
      duplicateCandidatePairs: Number(res?.duplicate_candidate_pairs ?? 0),
      openDriftLinks: Number(res?.open_drift_links ?? 0),
    };
  }

  /**
   * Карта стадий проекта (`stageId → {name, order}`) из домена pipe. Кэш на
   * REPORTS_STAGE_CACHE_TTL_MS: конфигурация воронки меняется редко, а дашборд
   * дёргается часто. Ошибка/недоступность pipe — забота вызывающего (settle →
   * partial=true + текущее поведение сортировки по количеству).
   */
  private async loadStages(projectId: string, pipelineId?: string): Promise<StageMap> {
    const cacheKey = `${projectId}|${pipelineId ?? ''}`;
    const hit = this.stageCache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.stageCacheTtlMs) return hit.stages;
    // Негативный кэш: pipe недоступен — не дёргаем его на каждый запрос дашборда,
    // но и не выдаём «успешно пустой» порядок стадий (иначе partial соврал бы).
    if (Date.now() < this.stageFailUntil) throw new Error('pipe stages unavailable (cooldown)');

    const md = buildServiceOutboundMetadata({ serviceApiKey: this.serviceApiKey() });
    const res = await firstValueFrom(
      this.pipe.listPipelines({ project_id: projectId }, md).pipe(timeout({ each: 2_000 })),
    ).catch((err: unknown) => {
      this.stageFailUntil = Date.now() + this.stageFailCooldownMs;
      throw err;
    });
    const all = res?.list ?? [];
    const narrowed = pipelineId ? all.filter((p) => p.id === pipelineId) : [];
    const stages: StageMap = new Map();
    for (const pipeline of narrowed.length ? narrowed : all) {
      for (const stage of pipeline.stages ?? []) {
        const id = String(stage?.id ?? '');
        if (!id) continue;
        const order = Number(stage?.order ?? 0);
        const known = stages.get(id);
        if (!known || order < known.order) {
          stages.set(id, { name: String(stage?.name ?? ''), order });
        }
      }
    }
    this.stageCache.set(cacheKey, { at: Date.now(), stages });
    return stages;
  }

  /**
   * Выстроить срез по стадиям В ПОРЯДКЕ ВОРОНКИ и подписать именами стадий.
   * Без карты стадий (pipe недоступен) поведение прежнее — по убыванию
   * количества; стадии вне карты уезжают в конец.
   */
  private orderByStage<T extends { key: string; label: string; count: number }>(
    rows: T[],
    stages: StageMap | null,
  ): T[] {
    if (!stages || stages.size === 0) return rows;
    const orderOf = (key: string) => stages.get(key)?.order ?? Number.MAX_SAFE_INTEGER;
    return rows
      .map((r) => {
        const name = stages.get(r.key)?.name;
        return name ? { ...r, label: name } : r;
      })
      .sort(
        (a, b) =>
          orderOf(a.key) - orderOf(b.key) || b.count - a.count || a.key.localeCompare(b.key),
      );
  }

  /**
   * FR-MSTAT-16/17: analytics screen (`/statistics`) — detailed visibility-aware
   * slices that drill deeper than the operational dashboard. Same fail-closed
   * scope + period contract as getDashboard(). Each slice is gated by the
   * project's enabled modules (`enabledModules`, resolved on the gateway): a slice
   * whose owner domain is disabled is omitted (FR-MSTAT-17 — order_types absent
   * when orders disabled). Fail-soft per slice (partial=true), never crashes.
   *
   * order_types (FR-STAT-280/290) groups the in-scope ORDERS on their typeId — an
   * order has no amount of its own, so that slice is a count distribution only.
   * by_department (FR-MSTAT-28 by_depts) is served in v1 by grouping the in-scope
   * deals on their departmentId over the shared Mongo views; the department-rollup
   * will later replace this. v1 returns sales/funnel/sources + team (by_managers) +
   * by_department + order_types, each gated by its source module.
   */
  async getMetrics(
    projectId: string,
    period?: string,
    from?: number,
    to?: number,
    slices?: string[],
    scope?: VisibilityScope,
    enabledModules?: string[],
    access?: AccessPredicate,
  ) {
    this.assertProjectId(projectId);
    const effectiveScope = this.assertScope(scope);
    const range = this.resolvePeriod(period, from, to);
    const rollupState = await this.rollupCoverage.get(projectId);
    const useRollup =
      canUseRollupRead(effectiveScope, access) &&
      rollupTrustedForRange(this.rollupCoverage, rollupState, range.from);
    const rollupDayFrom = utcDayOf(range.from);
    const rollupDayTo = utcDayOf(range.to - 1);
    const asOf = Date.now();
    let partial = false;

    // Slice gating: a slice is served only when requested (empty = all) AND its
    // source module is enabled (when the enabled set is known; unknown = allow).
    const requested = new Set((slices ?? []).filter((s) => typeof s === 'string' && s.trim()));
    const moduleOn = (mod: string): boolean =>
      !enabledModules || enabledModules.length === 0 || enabledModules.includes(mod);
    const wants = (slice: string, mod: string): boolean =>
      (requested.size === 0 || requested.has(slice)) && moduleOn(mod);

    const dealsVis = this.visMatch('deals', effectiveScope);
    const notDeleted = ReportsService.NOT_DELETED;
    // andMatch: project filter + visibility + date each carry an `$or` (spread would
    // drop the project scope — cross-project leak). ABAC — по subject'у источника.
    const dealsBase = this.andMatch(
      this.projectFilter(projectId),
      dealsVis,
      this.accessMatch(access, 'deals'),
      notDeleted,
    );
    const dealsMatch = this.andMatch(dealsBase, this.dateMatch(range));

    const settle = async <T>(fn: () => Promise<T>, fallback: T, what = 'slice'): Promise<T> => {
      try {
        return await withMetricDeadline(fn);
      } catch (err) {
        partial = true;
        this.logger.warn(`metrics ${what} failed (project=${projectId}): ${String(err)}`);
        return fallback;
      }
    };

    const present: string[] = [];
    let sales: Array<{ bucket: string; count: number; amount: number }> = [];
    let avgCheck = 0;
    let funnel: Array<{ key: string; label: string; count: number; amount: number; conversion: number }> = [];
    let sources: Array<{ key: string; label: string; count: number; amount: number; suppressed: boolean }> = [];
    let team: Array<{ owner_id: string; department_id: string; deals_count: number; amount: number; avg_check: number; activities_count: number }> = [];
    // FR-STAT-360: чем сгруппирован срез «команда» — 'user' (по умолчанию) или
    // 'department' (свёртка за порогом N_OWNER). Потребителю нужно знать, что за
    // строка пришла: у неё пустой owner_id и заполненный department_id.
    let teamGrouping = 'user';
    let byDepartment: Array<{ department_id: string; deals_count: number; amount: number; avg_check: number; managers_count: number }> = [];
    let orderTypes: Array<{ order_type_id: string; orders_count: number }> = [];
    let stageDurations: Array<{
      stage_id: string;
      label: string;
      transition_count: number;
      avg_duration_ms: number;
    }> = [];

    // --- sales: daily dynamics + average check (source: deals) ---
    if (wants('sales', 'deals')) {
      present.push('sales');
      if (useRollup) {
        const series = await rollupSalesSeries(this.rollupStore, {
          projectId,
          dayFrom: rollupDayFrom,
          dayTo: rollupDayTo,
        });
        let totalCount = 0;
        let totalAmount = 0;
        sales = series;
        for (const row of series) {
          totalCount += row.count;
          totalAmount += row.amount;
        }
        avgCheck = totalCount > 0 ? totalAmount / totalCount : 0;
      } else {
      // Группировка сразу по ДНЮ на стороне Mongo (в зоне статистики): ключом
      // была точная метка createdAt — одна группа на сделку, и весь массив ехал
      // в Node ради свёртки в дни.
      const rows = await settle(
        () =>
          this.mongo
            .deals()
            .aggregate([
              { $match: dealsMatch },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: '%Y-%m-%d',
                      date: { $toDate: { $ifNull: ['$createdAt', '$created_at'] } },
                      timezone: this.statisticsTz(),
                    },
                  },
                  count: { $sum: 1 },
                  amount: { $sum: '$amount' },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'sales',
      );
      let totalCount = 0;
      let totalAmount = 0;
      sales = [];
      for (const r of rows) {
        const bucket = typeof r._id === 'string' ? r._id : '';
        const count = Number(r.count ?? 0);
        const amount = Number(r.amount ?? 0);
        totalCount += count;
        totalAmount += amount;
        // Записи без распознаваемой даты создания в серию не попадают, но в
        // среднем чеке остаются (как и раньше).
        if (bucket) sales.push({ bucket, count, amount });
      }
      avgCheck = totalCount > 0 ? totalAmount / totalCount : 0;
      }
    }

    // --- stage_timing: average dwell per stage (FR-REPORTS-250) ---
    // Project-wide cells only — the projection has no owner field, so a
    // restricted/ABAC viewer must not see other people's dwell times.
    if (wants('stage_timing', 'deals') && canUseRollupRead(effectiveScope, access)) {
      present.push('stage_timing');
      const rows = await settle(
        () => this.stageTransitions.avgDurationByStage(projectId, range.from, range.to),
        [] as Array<{ stageId: string; count: number; avgDurationMs: number }>,
        'stage_timing',
      );
      const stageMap = await settle(
        () => this.loadStages(projectId),
        null as StageMap | null,
        'pipe stages',
      );
      stageDurations = rows.map((r) => ({
        stage_id: r.stageId,
        label: stageMap?.get(r.stageId)?.name ?? r.stageId,
        transition_count: r.count,
        avg_duration_ms: r.avgDurationMs,
      }));
    }

    // --- funnel: stages with cumulative conversion (source: deals) ---
    if (wants('funnel', 'deals')) {
      present.push('funnel');
      const byStage = await settle(
        () =>
          this.mongo
            .deals()
            .aggregate([
              { $match: dealsMatch },
              {
                $group: {
                  _id: { $ifNull: ['$stageId', '$stage_id'] },
                  count: { $sum: 1 },
                  amount: { $sum: '$amount' },
                },
              },
              { $sort: { count: -1, _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'funnel',
      );
      const stageMap = await settle(
        () => this.loadStages(projectId),
        null as StageMap | null,
        'pipe stages',
      );
      // Стадии — В ПОРЯДКЕ ВОРОНКИ; конверсия — от ВХОДНОЙ стадии (первой в этом
      // порядке), а не от максимума по количеству. Без карты стадий порядок
      // прежний (по убыванию количества) и entry = максимум — как раньше.
      const ordered = this.orderByStage(
        byStage.map((r) => ({
          key: String(r._id ?? ''),
          label: String(r._id ?? 'unknown'),
          count: Number(r.count ?? 0),
          amount: Number(r.amount ?? 0),
        })),
        stageMap,
      );
      const entry = ordered[0]?.count ?? 0;
      funnel = ordered.map((r) => ({
        ...r,
        conversion: entry > 0 ? r.count / entry : 0,
      }));
    }

    // --- sources: distribution by source with revenue (source: deals) ---
    if (wants('sources', 'deals')) {
      present.push('sources');
      const bySource = await settle(
        () =>
          this.mongo
            .deals()
            .aggregate([
              { $match: dealsMatch },
              {
                $group: {
                  _id: { $ifNull: ['$sourceId', '$source', 'unknown'] },
                  count: { $sum: 1 },
                  amount: { $sum: '$amount' },
                },
              },
              { $sort: { amount: -1, _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'sources',
      );
      sources = bySource.map((r) => ({
        key: String(r._id ?? 'unknown'),
        label: String(r._id ?? 'Прочее'),
        count: Number(r.count ?? 0),
        amount: Number(r.amount ?? 0),
        suppressed: false,
      }));
    }

    // --- team: per-manager breakdown (deals + activities; FR-MSTAT-17 Must) ---
    if (wants('team', 'deals')) {
      present.push('team');
      // FR-STAT-360: за порогом N_OWNER пофамильный срез вырождается — сворачиваем
      // ту же выборку в подразделения (ключ группировки меняется, $match тот же,
      // поэтому видимость/ABAC/период остаются ровно теми же).
      const rollupToDepartment = effectiveScope.ownerIds.length > N_OWNER;
      if (rollupToDepartment) teamGrouping = 'department';
      const teamKey = rollupToDepartment
        ? { $ifNull: ['$departmentId', '$department_id', ''] }
        : { $ifNull: ['$assigneeId', '$ownerId'] };
      const dealRows = await settle(
        () =>
          this.mongo
            .deals()
            .aggregate([
              { $match: dealsMatch },
              {
                $group: {
                  _id: teamKey,
                  count: { $sum: 1 },
                  amount: { $sum: '$amount' },
                },
              },
              { $sort: { amount: -1, _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'team deals',
      );
      // activity counts per owner in scope/period (best-effort; fail-soft).
      // Владелец активности — assigneeId (OWNER_FIELD домена activity): по
      // ownerId предикат видимости не матчил ни одной записи.
      const actMatch = this.andMatch(
        this.projectFilter(projectId),
        this.visMatch('activities', effectiveScope),
        this.accessMatch(access, 'activities'),
        notDeleted,
        this.dateMatch(range),
      );
      // FIELD-ACT-departmentId: у активности теперь есть подразделение-владелец,
      // поэтому свёрнутый срез считает активности тем же ключом, что и сделки.
      const actKey = rollupToDepartment
        ? { $ifNull: ['$departmentId', '$department_id', ''] }
        : { $ifNull: ['$assigneeId', '$ownerId'] };
      const actRows = moduleOn('activities')
        ? await settle(
            () =>
              this.mongo
                .activities()
                .aggregate([
                  { $match: actMatch },
                  { $group: { _id: actKey, count: { $sum: 1 } } },
                ])
                .toArray(),
            [] as Record<string, unknown>[],
            'team activities',
          )
        : [];
      const actByKey = new Map<string, number>();
      for (const r of actRows) actByKey.set(String(r._id ?? ''), Number(r.count ?? 0));
      team = dealRows.map((r) => {
        const key = String(r._id ?? '');
        const count = Number(r.count ?? 0);
        const amount = Number(r.amount ?? 0);
        return {
          // Свёрнутая строка — не человек: owner_id пуст, чтобы потребитель не
          // подставил в него подразделение и не выдал его за менеджера.
          owner_id: rollupToDepartment ? '' : key,
          department_id: rollupToDepartment ? key : '',
          deals_count: count,
          amount,
          avg_check: count > 0 ? amount / count : 0,
          activities_count: actByKey.get(key) ?? 0,
        };
      });
    }

    // --- by_department: per-department breakdown (FR-MSTAT-17/28 by_depts) ---
    // Scope-aware: same dealsMatch ($match starts with project AND visibility,
    // then date window). Grouped on the deal's departmentId; rows without one are
    // bucketed under '' (unknown). Reserved owner-domain rollup will enrich this
    // (TODO §6.4); v1 reads the field present on the shared deals view.
    if (wants('by_department', 'deals')) {
      present.push('by_department');
      const rows = await settle(
        () =>
          this.mongo
            .deals()
            .aggregate([
              { $match: dealsMatch },
              {
                $group: {
                  _id: { $ifNull: ['$departmentId', '$department_id', ''] },
                  count: { $sum: 1 },
                  amount: { $sum: '$amount' },
                  managers: { $addToSet: { $ifNull: ['$assigneeId', '$ownerId'] } },
                },
              },
              { $sort: { amount: -1, _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'by_department',
      );
      byDepartment = rows.map((r) => {
        const count = Number(r.count ?? 0);
        const amount = Number(r.amount ?? 0);
        const managers = Array.isArray(r.managers)
          ? (r.managers as unknown[]).filter((m) => m != null && m !== '').length
          : 0;
        return {
          department_id: String(r._id ?? ''),
          deals_count: count,
          amount,
          avg_check: count > 0 ? amount / count : 0,
          managers_count: managers,
        };
      });
    }

    // --- order_types: продажи по типам (source: orders, FR-STAT-280/290) ---
    if (wants('order_types', 'orders')) {
      present.push('order_types');
      const ordersMatch = this.andMatch(
        this.projectFilter(projectId),
        this.visMatch('orders', effectiveScope),
        this.accessMatch(access, 'orders'),
        notDeleted,
        this.dateMatch(range),
      );
      const rows = await settle(
        () =>
          this.mongo
            .orders()
            .aggregate([
              { $match: ordersMatch },
              {
                $group: {
                  _id: { $ifNull: ['$typeId', '$type_id', ''] },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1, _id: 1 } },
            ])
            .toArray(),
        [] as Record<string, unknown>[],
        'order_types',
      );
      orderTypes = rows.map((r) => ({
        order_type_id: String(r._id ?? ''),
        orders_count: Number(r.count ?? 0),
      }));
    }

    return {
      sales,
      avg_check: avgCheck,
      funnel,
      sources,
      team,
      team_grouping: teamGrouping,
      by_department: byDepartment,
      order_types: orderTypes,
      stage_durations: stageDurations,
      as_of: asOf,
      partial,
      scope_level: SCOPE_LEVEL_LABEL[effectiveScope.level] ?? effectiveScope.level,
      period: range.period,
      from: range.from,
      to: range.to,
      slices: present,
    };
  }
}

/*
 * P2.f/NFR-010: materialized `statistics_rollup` + read-switch (coverage-gated)
 * and `stage_transitions` projection (FR-REPORTS-250) live in reports. Historical
 * cells require `reports/scripts/backfill-statistics-rollup.ts` and
 * `backfill-stage-transitions.ts` before the read-switch trusts pre-consumer data.
 */
