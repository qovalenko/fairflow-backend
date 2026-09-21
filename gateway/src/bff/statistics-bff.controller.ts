import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Logger,
  OnModuleInit,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { grpcBffCall, toNum } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { IdentityResolverService } from './identity-resolver.service';
import { GatewayModuleGuard } from '../guards/gateway-module.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { RequireModule } from '../guards/require-module.decorator';
import { RequirePermission } from '../guards/require-permission.decorator';

/**
 * Statistics module BFF (statistics-module · FR-MSTAT, TZ §6.1). statistics owns
 * no domain — its public REST lives here and is transparently relayed to the
 * reports listener's `ReportsGrpc.GetDashboard` / `GetMetrics` (TZ §1/§5/§6:
 * "Statistics не имеет своего домена → его публичные эндпоинты живут в gateway").
 *
 * Every route is gated (fixes the AS-IS `/dashboard` без гейтинга — current-state #6):
 *  - JWT (global guard);
 *  - `@RequireModule('statistics')` — module must be enabled (403 MODULE_DISABLED);
 *  - `@RequirePermission('statistics','read')` — RBAC (403 PERMISSION_DENIED);
 *    export additionally requires `('statistics','export')` (FR-MSTAT-10).
 * `ProjectAccessGuard` enforces membership AND resolves the viewer's
 * VisibilityScope into `x-visibility-scope` — the domain re-aggregates strictly
 * in that scope (FR-MSTAT-4, fail-closed). The order guards run is the array
 * order below (module → access), so the effective module set / role / scope are
 * all resolved before the handler relays the call.
 *
 * projectId — ТОЛЬКО тот, на котором отработали гейты: `ProjectAccessGuard`
 * публикует его в `request.__projectId` (порядок `params → query → header`), и
 * `resolveProjectId` читает именно его; расхождение источников — 403, отсутствие
 * — 400 (PROJECT_ID_REQUIRED) вместо опакового 500 из домена. Тело запроса не
 * участвует никогда (INV). Собственный порядок разрешения в контроллере
 * запрещён: он разъезжается с гейтом и даёт «авторизовались в A, прочитали B».
 *
 * DISPLAY-ИМЕНА (FR-MSTAT-17/28). reports — Mongo-домен: он агрегирует по
 * `ownerId`/`departmentId` и справочников людей (auth) и оргструктуры (control,
 * Postgres) не видит; поэтому строки среза «команда»/«отделы» приезжают сюда
 * ТОЛЬКО с id. Имя подставляет gateway — единственная точка, знающая и агрегат,
 * и оба справочника (тот же принцип, что `AssigneeNameInterceptor` для CRM и
 * комментарий `leader_user_id // name resolved at gateway` в control.proto).
 * Резолв делается здесь явно, а не интерцептором, потому что интерцептор умеет
 * ровно `assigneeId → assigneeName`: отделы (control) он не покрывает, а на
 * экспорт (ответ — Buffer с CSV) он не действует вовсе. Один helper закрывает
 * все три поверхности; менеджеры при этом идут через тот же
 * `IdentityResolverService` (батч `ResolveUsers` + кэш), что и интерцептор, а
 * строка дополнительно несёт `assigneeId`/`assigneeName` — контракт, который
 * фронт уже читает. Все резолвы fail-soft: недоступен auth/control/orders/pipe —
 * остаётся id (фронт деградирует до него), но цифры среза не теряются.
 *
 * Тем же путём идёт срез «Типы продаж» (`order_types`, FR-STAT-280/290): reports
 * группирует заказы по `typeId` и справочника типов продаж не видит — название
 * подставляет gateway через `OrdersGrpc.ListOrderTypes` (`include_deleted=true`,
 * иначе исторические строки по удалённому типу остались бы без имени). Кэш здесь
 * ключуется ПРОЕКТОМ: типы продаж — справочник проекта, а не инстанса (в отличие
 * от отделов, где control сам резолвит системный org-якорь).
 */
type GrpcReq = FastifyRequest & {
  user?: { userId?: string };
  /** projectId, на котором ProjectAccessGuard проверил доступ (единственный доверенный). */
  __projectId?: string;
  __projectRole?: string;
  /** Сериализованный VisibilityScope, проставленный ProjectAccessGuard. */
  __visibilityScope?: string;
};

/**
 * Отпечаток scope для записи в аудит: сам scope содержит id владельцев и
 * расшаренных записей — в журнал они не идут, идёт короткий хэш, по которому
 * две выгрузки можно сравнить между собой (аналог `scopeHash` в reports).
 */
function scopeHash(serializedScope?: string): string {
  if (!serializedScope) return '';
  return createHash('sha256').update(serializedScope).digest('hex').slice(0, 16);
}

const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);

/** TTL кэша справочника отделов (как IDENTITY_CACHE_TTL_MS у резолвера людей). */
const DEPARTMENT_CACHE_TTL_MS = 30_000;

/**
 * Потолок пер-акторного кэша отделов (X2): ключ теперь включает актора, значит
 * число записей растёт по числу активных пользователей, а не равно единице.
 */
const DEPARTMENT_CACHE_MAX_ACTORS = 512;

/** TTL кэша справочника типов продаж (тот же порядок, что у отделов). */
const ORDER_TYPE_CACHE_TTL_MS = 30_000;

/** TTL кэша проектных справочников pipe (стадии воронки, источники сделок). */
const DICTIONARY_CACHE_TTL_MS = 30_000;

function activityFe(a: Record<string, unknown>) {
  return {
    id: a.id,
    title: a.title,
    dueAt: a.due_at,
    ownerId: a.owner_id,
    deepLink: a.deep_link ?? '',
  };
}

function stalledFe(d: Record<string, unknown>) {
  return {
    id: d.id,
    name: d.name,
    amount: d.amount,
    ownerId: d.owner_id,
    stageId: d.stage_id,
    stageEnteredAt: d.stage_entered_at,
  };
}

function metricValueFe(m: Record<string, unknown>) {
  return {
    key: m.key,
    label: m.label,
    value: m.value,
    previousValue: m.previous_value,
    growthRate: m.growth_rate,
  };
}

/**
 * Строка среза → FE. `names` — карта «id → человекочитаемое имя» соответствующего
 * справочника (стадии/источники): если имя разрешилось, оно вытесняет `label`,
 * который домен заполняет тем же сырым id (reports — Mongo-агрегат, справочника
 * стадий/источников он не видит). Не разрешилось (справочник недоступен, стадия
 * удалена, источник — свободный текст) → остаётся то, что прислал домен: цифры
 * среза не теряются (fail-soft).
 */
function breakdownFe(b: Record<string, unknown>, names?: Map<string, string>) {
  return {
    key: b.key,
    label: displayLabel(b, names),
    count: b.count,
    amount: b.amount,
    suppressed: Boolean(b.suppressed),
  };
}

function displayLabel(row: Record<string, unknown>, names?: Map<string, string>): unknown {
  const key = String(row.key ?? '').trim();
  const resolved = key ? names?.get(key) : undefined;
  return resolved || row.label;
}

/**
 * TODO-498. Сколько записей ВСЕГО попало в срез виджета, при том что список в
 * ответе домена усечён (`.limit(5)` / `.limit(10)` в reports.service.getDashboard).
 * Виджет считал остаток как «длина массива − показано», то есть тождественный
 * ноль, и индикатор «+ ещё N» не появлялся никогда — поэтому счётчик обязан
 * приезжать из домена отдельным полем (`*_total`).
 *
 * Пока домен поля не прислал (старая сборка reports), отдаём длину усечённого
 * списка: это ровно AS-IS-поведение («остатка нет»), а не выдуманное число.
 * `Math.max` страхует от домена, приславшего total меньше собственного списка.
 */
function listTotal(total: unknown, rows: unknown[]): number {
  return Math.max(toNum(total), rows.length);
}

/**
 * Ключи строк, у которых подписи ФАКТИЧЕСКИ нет: домен кладёт в `label` тот же
 * id (или пусто), когда справочник ему недоступен. Если домен подпись уже
 * разрешил (label ≠ key), справочник у pipe не запрашивается вовсе — резолв на
 * gateway остаётся строго фолбэком и не дублирует чужую работу.
 */
function unresolvedKeys(rows: Record<string, unknown>[]): string[] {
  return rows
    .filter((r) => {
      const key = String(r.key ?? '').trim();
      const label = String(r.label ?? '').trim();
      return Boolean(key) && (!label || label === key);
    })
    .map((r) => String(r.key));
}

@ApiBearerAuth()
@ApiTags('Statistics')
@UseGuards(GatewayModuleGuard, ProjectAccessGuard)
@Controller({ path: '', version: '1' })
export class StatisticsBffController implements OnModuleInit {
  private reports!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private organization!: { listDepartments: (x: unknown, m?: unknown) => unknown };
  private orders!: { listOrderTypes: (x: unknown, m?: unknown) => unknown };
  private pipe!: {
    listPipelines: (x: unknown, m?: unknown) => unknown;
    listDealSources: (x: unknown, m?: unknown) => unknown;
  };
  /**
   * Кэш справочника отделов: id → название, ключ — `(systemOrgId, actorUserId)`
   * (X2). Раньше кэш был ОДИН на процесс: первый же член оргструктуры прогревал
   * его, и следующие 30 секунд названия отделов получал любой, кто дошёл до
   * ручки — попадание в кэш закорачивало `assertMember` на стороне control.
   */
  private readonly departmentNames = new Map<
    string,
    { byId: Map<string, string>; expiresAt: number }
  >();
  /** Кэш справочника типов продаж: projectId → (id → название). */
  private readonly orderTypeNames = new Map<
    string,
    { byId: Map<string, string>; expiresAt: number }
  >();
  /**
   * Справочники стадий/источников проектные (в отличие от отделов — они
   * инстансные), поэтому кэш ключуется projectId. Ключей столько же, сколько
   * проектов у инстанса; протухшие записи вычищаются при обращении.
   */
  private stageNames = new Map<string, { byId: Map<string, string>; expiresAt: number }>();
  private sourceNames = new Map<string, { byId: Map<string, string>; expiresAt: number }>();
  private audit!: { appendEvent: (x: unknown, m?: unknown) => unknown };
  private readonly logger = new Logger(StatisticsBffController.name);

  constructor(
    @Inject('REPORTS_GRPC') private reportsClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private controlClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private ordersClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly identity: IdentityResolverService,
    @Inject('PIPE_GRPC') private pipeClient: ClientGrpcProxy,
    @Inject('AUDIT_GRPC') private auditClient: ClientGrpcProxy,
  ) {}

  onModuleInit() {
    this.reports = this.reportsClient.getService('ReportsGrpc');
    this.organization = this.controlClient.getService('OrganizationGrpc');
    this.orders = this.ordersClient.getService('OrdersGrpc');
    this.pipe = this.pipeClient.getService('PipeGrpc');
    this.audit = this.auditClient.getService('AuditGrpc');
  }

  private meta(req: GrpcReq, projectId: string) {
    return this.outboundMeta.build(req, { projectId });
  }

  /**
   * projectId = РОВНО тот id, на котором отработали гейты (`__projectId`,
   * ProjectAccessGuard), а не независимо вычисленный здесь.
   *
   * Раньше контроллер брал `x-project-id` header, а `?projectId=` считал
   * фолбэком — порядок, ОБРАТНЫЙ гейтам (`params ?? query ?? header` в
   * ProjectAccessGuard и GatewayModuleGuard). Запрос `?projectId=A` с
   * заголовком `x-project-id: B` авторизовался по проекту A (членство, роль,
   * VisibilityScope, enabled-модули, module-policy, ABAC-предикат), а данные
   * читались из проекта B — межпроектный слив дашборда/аналитики/экспорта
   * (и запись факта `statistics.exported` в журнал чужого проекта).
   *
   * Поэтому: сначала авторизованный id из гейта; фолбэк повторяет порядок
   * гейта один-в-один (на случай маршрута без ProjectAccessGuard), и любое
   * расхождение источников (query ≠ header) — 403, а не молчаливый выбор
   * одного из них (тот же fail-closed, что `authoritativeProjectId` в crm-bff).
   * Пусто → 400 PROJECT_ID_REQUIRED вместо опакового 500 из домена.
   */
  private resolveProjectId(req: GrpcReq, projectIdQuery?: string): string {
    const sources = [
      (req.params as Record<string, string> | undefined)?.projectId,
      projectIdQuery,
      req.headers?.['x-project-id'] as string | undefined,
    ]
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter((v) => v !== '');
    if (sources.some((v) => v !== sources[0])) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'projectId in the request does not match the authorized project',
      });
    }
    // Гейт уже разрешил и авторизовал id — он и есть источник истины.
    const authorized = (req.__projectId ?? '').trim();
    const projectId = authorized || sources[0] || '';
    if (!projectId) {
      throw new BadRequestException({
        code: 'PROJECT_ID_REQUIRED',
        message: 'projectId is required (provide x-project-id header or ?projectId=)',
      });
    }
    if (authorized && sources[0] && sources[0] !== authorized) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'projectId in the request does not match the authorized project',
      });
    }
    return projectId;
  }

  /**
   * id отдела → название через control `OrganizationGrpc.ListDepartments`.
   * control сам разрешает системный org-якорь (клиентский `organization_id`
   * игнорируется, DEORG-BE-16) и проверяет членство актора — поэтому здесь
   * достаточно `actor_user_id`, а не-член названий не получит (fail-closed на
   * стороне control). Справочник для инстанса один и тот же для всех членов,
   * поэтому карта кэшируется на TTL; ошибка НЕ кэшируется и НЕ ломает срез —
   * вернём пустую карту, строка останется с id (fail-soft).
   */
  private async resolveDepartmentNames(
    req: GrpcReq,
    ids: Array<string | undefined>,
  ): Promise<Map<string, string>> {
    if (!ids.some((id) => (id ?? '').trim())) return new Map();
    const now = Date.now();
    const actorUserId = (req.user?.userId ?? '').trim();
    const cacheKey = actorUserId
      ? `${(req as { __systemOrgId?: string }).__systemOrgId ?? ''}\0${actorUserId}`
      : '';
    const cached = cacheKey ? this.departmentNames.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > now) return cached.byId;
    try {
      const r = (await grpcBffCall(
        this.organization.listDepartments(
          { organization_id: '', actor_user_id: actorUserId },
          this.outboundMeta.build(req),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const d of arr(r?.list)) {
        const id = String(d.id ?? '').trim();
        const name = String(d.name ?? '').trim();
        if (id && name) byId.set(id, name);
      }
      if (cacheKey) {
        this.pruneDepartmentCache(now);
        this.departmentNames.set(cacheKey, { byId, expiresAt: now + DEPARTMENT_CACHE_TTL_MS });
      }
      return byId;
    } catch {
      return new Map();
    }
  }

  private pruneDepartmentCache(now: number): void {
    for (const [key, entry] of this.departmentNames) {
      if (entry.expiresAt <= now) this.departmentNames.delete(key);
    }
    while (this.departmentNames.size >= DEPARTMENT_CACHE_MAX_ACTORS) {
      const oldest = this.departmentNames.keys().next();
      if (oldest.done) break;
      this.departmentNames.delete(oldest.value);
    }
  }

  private async resolveOrderTypeNames(
    req: GrpcReq,
    projectId: string,
    ids: Array<string | undefined>,
  ): Promise<Map<string, string>> {
    if (!ids.some((id) => (id ?? '').trim())) return new Map();
    const now = Date.now();
    const cached = this.orderTypeNames.get(projectId);
    if (cached && cached.expiresAt > now) return cached.byId;
    try {
      const r = (await grpcBffCall(
        this.orders.listOrderTypes(
          { project_id: projectId, include_deleted: true },
          this.meta(req, projectId),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const t of arr(r?.list)) {
        const id = String(t.id ?? '').trim();
        const name = String(t.name ?? '').trim();
        if (id && name) byId.set(id, name);
      }
      for (const [key, entry] of this.orderTypeNames) {
        if (entry.expiresAt <= now) this.orderTypeNames.delete(key);
      }
      this.orderTypeNames.set(projectId, { byId, expiresAt: now + ORDER_TYPE_CACHE_TTL_MS });
      return byId;
    } catch {
      return new Map();
    }
  }

  private async orderTypesFe(req: GrpcReq, projectId: string, rows: Record<string, unknown>[]) {
    const names = await this.resolveOrderTypeNames(
      req,
      projectId,
      rows.map((t) => (t.order_type_id == null ? '' : String(t.order_type_id))),
    );
    return rows.map((t) => {
      const orderTypeId = String(t.order_type_id ?? '');
      return {
        orderTypeId,
        orderTypeName: (orderTypeId && names.get(orderTypeId)) || '',
        count: toNum(t.orders_count),
      };
    });
  }

  private cachedDict(
    cache: Map<string, { byId: Map<string, string>; expiresAt: number }>,
    projectId: string,
  ): Map<string, string> | undefined {
    const hit = cache.get(projectId);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      cache.delete(projectId);
      return undefined;
    }
    return hit.byId;
  }

  /**
   * id стадии → название воронки проекта (`PipeGrpc.ListPipelines`).
   * Домен reports группирует сделки по `stageId` и справочника стадий не видит,
   * поэтому и `key`, и `label` приезжают сюда сырым id — имя подставляет gateway,
   * ровно как для отделов (FR-MSTAT-17/28). `key` НЕ трогаем: по нему drill в
   * список сделок (FR-MSTAT-24). Кэш на TTL по проекту; ошибка не кэшируется и
   * не рушит срез — вернём пустую карту, на экране останется id (fail-soft).
   */
  private async resolveStageNames(
    req: GrpcReq,
    projectId: string,
    ids: Array<string | undefined>,
  ): Promise<Map<string, string>> {
    if (!ids.some((id) => (id ?? '').trim())) return new Map();
    const cached = this.cachedDict(this.stageNames, projectId);
    if (cached) return cached;
    try {
      const r = (await grpcBffCall(
        this.pipe.listPipelines({ project_id: projectId }, this.meta(req, projectId)) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const p of arr(r?.list)) {
        for (const s of arr(p.stages as Record<string, unknown>[])) {
          const id = String(s.id ?? '').trim();
          const name = String(s.name ?? '').trim();
          if (id && name) byId.set(id, name);
        }
      }
      this.stageNames.set(projectId, { byId, expiresAt: Date.now() + DICTIONARY_CACHE_TTL_MS });
      return byId;
    } catch {
      return new Map();
    }
  }

  /**
   * id источника → название (`PipeGrpc.ListDealSources`), тем же контрактом, что
   * стадии. У сделки источник может быть и свободным текстом (`source`), а не
   * ссылкой на справочник — такой ключ просто не найдётся в карте и останется
   * как есть (домен уже подставил ему осмысленный label / «Прочее»).
   */
  private async resolveSourceNames(
    req: GrpcReq,
    projectId: string,
    ids: Array<string | undefined>,
  ): Promise<Map<string, string>> {
    if (!ids.some((id) => (id ?? '').trim())) return new Map();
    const cached = this.cachedDict(this.sourceNames, projectId);
    if (cached) return cached;
    try {
      const r = (await grpcBffCall(
        this.pipe.listDealSources({ project_id: projectId }, this.meta(req, projectId)) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const s of arr(r?.list)) {
        const id = String(s.id ?? '').trim();
        const name = String(s.name ?? '').trim();
        if (id && name) byId.set(id, name);
      }
      this.sourceNames.set(projectId, { byId, expiresAt: Date.now() + DICTIONARY_CACHE_TTL_MS });
      return byId;
    } catch {
      return new Map();
    }
  }

  /**
   * Один батч на запрос: имена стадий (для `funnel`) и источников (для `sources`).
   * Оба справочника живут в pipe, оба запрашиваются параллельно и только если
   * соответствующий срез непустой (пустой срез → RPC не дёргается вовсе).
   */
  private async resolveBreakdownNames(
    req: GrpcReq,
    projectId: string,
    funnel: Record<string, unknown>[],
    sources: Record<string, unknown>[],
  ): Promise<{ stages: Map<string, string>; sources: Map<string, string> }> {
    const [stages, sourceMap] = await Promise.all([
      this.resolveStageNames(req, projectId, unresolvedKeys(funnel)),
      this.resolveSourceNames(req, projectId, unresolvedKeys(sources)),
    ]);
    return { stages, sources: sourceMap };
  }

  /**
   * `team[]` (StatManagerRow) → строки среза «команда» с ФИО менеджера.
   * `assigneeId`/`assigneeName` зеркалят владельца — тот же контракт, что у
   * CRM-строк (его читает фронт), `ownerId` сохраняется: по нему drill в список
   * сделок (FR-MSTAT-24; по display-имени список не сматчить).
   */
  private async teamFe(req: GrpcReq, rows: Record<string, unknown>[]) {
    // FR-STAT-360: за порогом N_OWNER домен отдаёт срез, свёрнутый в
    // подразделения — у таких строк пустой ownerId и заполненный departmentId.
    // Имя тогда берётся из справочника подразделений, иначе строка была бы
    // безымянной (в auth такого id нет).
    const [names, departmentNames] = await Promise.all([
      this.identity.resolveNames(
        req,
        rows.map((t) => (t.owner_id == null ? '' : String(t.owner_id))),
      ),
      this.resolveDepartmentNames(
        req,
        rows.map((t) => (t.department_id == null ? '' : String(t.department_id))),
      ),
    ]);
    return rows.map((t) => {
      const ownerId = String(t.owner_id ?? '');
      const departmentId = String(t.department_id ?? '');
      const name =
        (ownerId && names.get(ownerId)) ||
        (departmentId && departmentNames.get(departmentId)) ||
        '';
      return {
        ownerId,
        assigneeId: ownerId,
        departmentId,
        ownerName: name,
        assigneeName: name,
        dealsCount: toNum(t.deals_count),
        amount: toNum(t.amount),
        avgCheck: toNum(t.avg_check),
        activitiesCount: toNum(t.activities_count),
      };
    });
  }

  /** `by_department[]` (StatDepartmentRow) → строки среза «отделы» с названием. */
  private async departmentsFe(req: GrpcReq, rows: Record<string, unknown>[]) {
    const names = await this.resolveDepartmentNames(
      req,
      rows.map((d) => (d.department_id == null ? '' : String(d.department_id))),
    );
    return rows.map((d) => {
      const departmentId = String(d.department_id ?? '');
      return {
        departmentId,
        departmentName: (departmentId && names.get(departmentId)) || '',
        dealsCount: toNum(d.deals_count),
        amount: toNum(d.amount),
        avgCheck: toNum(d.avg_check),
        managersCount: toNum(d.managers_count),
      };
    });
  }

  // GET /api/v1/dashboard — операционный дашборд (FR-MSTAT-1/4/7).
  @Get('dashboard')
  @RequireModule('statistics')
  @RequirePermission('statistics', 'read')
  async dashboard(
    @Req() req: GrpcReq,
    @Query('projectId') projectIdQuery?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const projectId = this.resolveProjectId(req, projectIdQuery);
    const d = (await grpcBffCall(
      this.reports.getDashboard(
        {
          project_id: projectId,
          period: period ?? 'month',
          from: from ? Number(from) : 0,
          to: to ? Number(to) : 0,
        },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    const funnelRows = arr(d.funnel as Record<string, unknown>[]);
    const sourceRows = arr(d.sources as Record<string, unknown>[]);
    // Стадии и источники приезжают из домена сырыми id (см. resolveStageNames):
    // подписи подставляем здесь, иначе воронка дашборда — колонка UUID.
    const names = await this.resolveBreakdownNames(req, projectId, funnelRows, sourceRows);
    const overdueRows = arr(d.overdue as Record<string, unknown>[]);
    const upcomingRows = arr(d.upcoming as Record<string, unknown>[]);
    const recentRows = arr(d.recent as Record<string, unknown>[]);
    const stalledRows = arr(d.stalled as Record<string, unknown>[]);
    return {
      kpi: arr(d.kpi as Record<string, unknown>[]).map(metricValueFe),
      funnel: funnelRows.map((f) => breakdownFe(f, names.stages)),
      sources: sourceRows.map((s) => breakdownFe(s, names.sources)),
      overdue: overdueRows.map(activityFe),
      upcoming: upcomingRows.map(activityFe),
      recent: recentRows.map(activityFe),
      stalled: stalledRows.map(stalledFe),
      // TODO-498: полные размеры срезов рядом с усечёнными списками — по ним
      // виджет рисует «+ ещё N» (сам список домен режет лимитом, см. listTotal).
      overdueTotal: listTotal(d.overdue_total, overdueRows),
      upcomingTotal: listTotal(d.upcoming_total, upcomingRows),
      recentTotal: listTotal(d.recent_total, recentRows),
      stalledTotal: listTotal(d.stalled_total, stalledRows),
      asOf: d.as_of,
      partial: Boolean(d.partial),
      scopeLevel: d.scope_level,
      period: d.period,
      from: d.from,
      to: d.to,
    };
  }

  // GET /api/v1/statistics — аналитика (детальные срезы, FR-MSTAT-16/17).
  @Get('statistics')
  @RequireModule('statistics')
  @RequirePermission('statistics', 'read')
  async statistics(
    @Req() req: GrpcReq,
    @Query('projectId') projectIdQuery?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('slices') slices?: string | string[],
  ) {
    const projectId = this.resolveProjectId(req, projectIdQuery);
    const m = (await grpcBffCall(
      this.reports.getMetrics(
        {
          project_id: projectId,
          period: period ?? 'month',
          from: from ? Number(from) : 0,
          to: to ? Number(to) : 0,
          slices: normalizeSlices(slices),
        },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;
    const funnelRows = arr(m.funnel as Record<string, unknown>[]);
    const sourceRows = arr(m.sources as Record<string, unknown>[]);
    const stageDurationRows = arr(m.stage_durations as Record<string, unknown>[]);
    // Имена резолвим параллельно (auth + control + orders + pipe).
    const [team, byDepartment, orderTypes, names] = await Promise.all([
      this.teamFe(req, arr(m.team as Record<string, unknown>[])),
      this.departmentsFe(req, arr(m.by_department as Record<string, unknown>[])),
      this.orderTypesFe(req, projectId, arr(m.order_types as Record<string, unknown>[])),
      this.resolveBreakdownNames(req, projectId, funnelRows, sourceRows),
    ]);
    return {
      sales: arr(m.sales as Record<string, unknown>[]).map((s) => ({
        bucket: s.bucket,
        count: s.count,
        amount: s.amount,
      })),
      avgCheck: m.avg_check,
      funnel: funnelRows.map((f) => ({
        key: f.key,
        label: displayLabel(f, names.stages),
        count: f.count,
        amount: f.amount,
        conversion: f.conversion,
      })),
      sources: sourceRows.map((s) => breakdownFe(s, names.sources)),
      team,
      // FR-STAT-360: 'user' | 'department' — чем сгруппирован `team`. Фронт по
      // этому полю решает, что показывать в колонке «кто» и куда вести drill.
      teamGrouping: String(m.team_grouping ?? 'user') || 'user',
      byDepartment,
      orderTypes,
      stageDurations: stageDurationRows.map((d) => ({
        stageId: d.stage_id,
        label: displayLabel({ key: d.stage_id, label: d.label }, names.stages),
        transitionCount: toNum(d.transition_count),
        avgDurationMs: toNum(d.avg_duration_ms),
      })),
      asOf: m.as_of,
      partial: Boolean(m.partial),
      scopeLevel: m.scope_level,
      period: m.period,
      from: m.from,
      to: m.to,
      slices: arr(m.slices as string[]),
    };
  }

  // GET /api/v1/statistics/export — экспорт сводки (FR-MSTAT-10/22/23).
  @Get('statistics/export')
  @RequireModule('statistics')
  @RequirePermission('statistics', 'export')
  @Header('Cache-Control', 'no-store')
  async export(
    @Req() req: GrpcReq,
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('projectId') projectIdQuery?: string,
    @Query('format') format?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('slices') slices?: string | string[],
  ) {
    // Export composes the analytics summary (aggregates only — never raw rows,
    // FR-MSTAT-22) into CSV/JSON. We assemble the file in the BFF from GetMetrics
    // so the same scope/period contract and slice gating apply.
    const projectId = this.resolveProjectId(req, projectIdQuery);
    const requested = (format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const m = (await grpcBffCall(
      this.reports.getMetrics(
        {
          project_id: projectId,
          period: period ?? 'month',
          from: from ? Number(from) : 0,
          to: to ? Number(to) : 0,
          slices: normalizeSlices(slices),
        },
        this.meta(req, projectId),
      ) as never,
    )) as Record<string, unknown>;

    // Выгрузка читается человеком, поэтому строки «команда»/«отделы» получают
    // те же имена, что и экран (FR-MSTAT-10): интерцептор сюда не достаёт —
    // ответ уходит Buffer'ом, — резолвим тем же батчем, что и в /statistics.
    const teamRows = arr(m.team as Record<string, unknown>[]);
    const departmentRows = arr(m.by_department as Record<string, unknown>[]);
    const orderTypeRows = arr(m.order_types as Record<string, unknown>[]);
    const [ownerNames, departmentNames, orderTypeNameMap, breakdownNames] = await Promise.all([
      this.identity.resolveNames(
        req,
        teamRows.map((t) => (t.owner_id == null ? '' : String(t.owner_id))),
      ),
      this.resolveDepartmentNames(
        req,
        departmentRows.map((d) => (d.department_id == null ? '' : String(d.department_id))),
      ),
      this.resolveOrderTypeNames(
        req,
        projectId,
        orderTypeRows.map((t) => (t.order_type_id == null ? '' : String(t.order_type_id))),
      ),
      this.resolveBreakdownNames(
        req,
        projectId,
        arr(m.funnel as Record<string, unknown>[]),
        arr(m.sources as Record<string, unknown>[]),
      ),
    ]);
    const summary = this.statisticsFromGrpc(
      m,
      ownerNames,
      departmentNames,
      breakdownNames,
      orderTypeNameMap,
    );
    const stamp = new Date(Number(m.as_of) || Date.now()).toISOString().replace(/[:.]/g, '-');
    let payload: string;
    let contentType: string;
    if (requested === 'json') {
      payload = JSON.stringify(summary, null, 2);
      contentType = 'application/json; charset=utf-8';
    } else {
      payload = toCsv(summary);
      contentType = 'text/csv; charset=utf-8';
    }
    // Факт выгрузки — в журнал (FR-MSTAT-23). Пишем ПОСЛЕ успешной сборки файла:
    // событие означает «данные ушли пользователю», а не «попытка».
    await this.auditExport(req, projectId, {
      format: requested,
      slices: arr(m.slices as string[]),
      scopeLevel: String(m.scope_level ?? ''),
      scopeHash: scopeHash(req.__visibilityScope),
      exportedAt: Number(m.as_of) || Date.now(),
    });

    void res.header('Content-Type', contentType);
    void res.header(
      'Content-Disposition',
      `attachment; filename="statistics-${stamp}.${requested}"`,
    );
    return Buffer.from(payload, 'utf8');
  }

  /**
   * `statistics.exported` в журнал аудита (FR-MSTAT-23). Экспорт статистики
   * собирается целиком на gateway (GetMetrics → CSV/JSON), поэтому доменного
   * outbox на этом пути нет: пишем напрямую через `AuditGrpc.AppendEvent` —
   * штатный второй писатель журнала наряду с консьюмером шины
   * (audit.service.ts: «Rows come from two writers»). Актора audit берёт из
   * проверенной метадаты (x-user-id/x-actor-type), а не из тела — подделать
   * автора нельзя.
   *
   * Нагрузка без PII и без цифр: формат, запрошенные срезы, уровень видимости и
   * ОТПЕЧАТОК scope (хэш сериализованного scope — сами id владельцев/записей в
   * журнал не попадают), ровно как у доменного эмита в ReportsService.export.
   *
   * fail-soft: недоступный/выключенный audit не должен отнимать у пользователя
   * уже собранный файл — ошибку логируем и отдаём выгрузку.
   */
  private async auditExport(
    req: GrpcReq,
    projectId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await grpcBffCall(
        this.audit.appendEvent(
          {
            project_id: projectId,
            event_name: 'statistics.exported',
            entity_type: 'statistics',
            entity_id: projectId,
            payload_json: JSON.stringify(payload),
          },
          this.meta(req, projectId),
        ) as never,
      );
    } catch (e) {
      this.logger.warn(
        `statistics.exported audit append failed (project=${projectId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * snake_case GetMetrics payload → camelCase summary object (reused by export).
   * Строки «команда»/«отделы» дополняются `owner_name`/`department_name` из
   * переданных карт (пустая карта = имя не разрешилось, остаётся один id).
   */
  private statisticsFromGrpc(
    m: Record<string, unknown>,
    ownerNames: Map<string, string> = new Map(),
    departmentNames: Map<string, string> = new Map(),
    breakdownNames: { stages: Map<string, string>; sources: Map<string, string> } = {
      stages: new Map(),
      sources: new Map(),
    },
    orderTypeNames: Map<string, string> = new Map(),
  ) {
    return {
      period: m.period,
      from: m.from,
      to: m.to,
      scopeLevel: m.scope_level,
      avgCheck: m.avg_check,
      sales: arr(m.sales as Record<string, unknown>[]),
      // label стадии/источника — название из справочника pipe (иначе выгрузка
      // состояла бы из одних id, как и экран до TODO-269/470).
      funnel: arr(m.funnel as Record<string, unknown>[]).map((f) => ({
        ...f,
        label: displayLabel(f, breakdownNames.stages),
      })),
      sources: arr(m.sources as Record<string, unknown>[]).map((s) => ({
        ...s,
        label: displayLabel(s, breakdownNames.sources),
      })),
      team: arr(m.team as Record<string, unknown>[]).map((t) => ({
        ...t,
        owner_name: ownerNames.get(String(t.owner_id ?? '')) ?? '',
      })),
      byDepartment: arr(m.by_department as Record<string, unknown>[]).map((d) => ({
        ...d,
        department_name: departmentNames.get(String(d.department_id ?? '')) ?? '',
      })),
      orderTypes: arr(m.order_types as Record<string, unknown>[]).map((t) => ({
        ...t,
        order_type_name: orderTypeNames.get(String(t.order_type_id ?? '')) ?? '',
      })),
      stageDurations: arr(m.stage_durations as Record<string, unknown>[]).map((d) => ({
        ...d,
        label: displayLabel({ key: d.stage_id, label: d.label }, breakdownNames.stages),
        transition_count: toNum(d.transition_count),
        avg_duration_ms: toNum(d.avg_duration_ms),
      })),
    };
  }
}

/** Accept `slices=a,b` or repeated `slices=a&slices=b`; normalize to string[]. */
function normalizeSlices(slices?: string | string[]): string[] {
  if (!slices) return [];
  const list = Array.isArray(slices) ? slices : slices.split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

/**
 * CSV-ячейка: кавычим, когда есть разделитель/кавычка/перевод строки, И гасим
 * formula injection (CWE-1236). Excel/LibreOffice/Sheets трактуют ячейку,
 * начинающуюся с `=`, `+`, `-`, `@` (а также с TAB/CR), как ФОРМУЛУ — а сюда
 * попадают названия стадий/источников/отделов и ФИО, то есть данные, которые
 * заводит пользователь: стадия с именем `=HYPERLINK("http://evil","click")`
 * выполнится у того, кто откроет выгрузку. Обезвреживаем каноническим приёмом —
 * ведущий апостроф (в таблице он не отображается, значение читается как текст).
 * Числа (в т.ч. отрицательные) не трогаем: `-5` должно остаться числом.
 */
function csvCell(v: unknown): string {
  const raw = v == null ? '' : String(v);
  const s = isNumericCell(raw) ? raw : neutralizeFormula(raw);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isNumericCell(s: string): boolean {
  return /^[+-]?\d+(\.\d+)?$/.test(s.trim());
}

function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * Flat CSV of the aggregated summary (no raw rows — FR-MSTAT-22).
 * Колонка `label` добавлена ПОСЛЕДНЕЙ (позиции старых колонок не сдвинулись):
 * в ней человекочитаемое имя строки — ФИО менеджера / название отдела / подпись
 * стадии, — иначе выгрузка состояла из одних UUID (FR-MSTAT-10).
 */
function toCsv(s: ReturnType<StatisticsBffController['statisticsFromGrpc']>): string {
  const lines: string[] = ['section,key,count,amount,label'];
  const row = (
    section: string,
    key: unknown,
    count: number,
    amount: number | string,
    label: unknown,
  ) =>
    lines.push(
      `${section},${csvCell(key || 'unknown')},${count},${amount},${csvCell(label ?? '')}`,
    );
  lines.push(`meta,avg_check,,${toNum(s.avgCheck)},`);
  for (const p of s.sales as Array<Record<string, unknown>>) {
    row('sales', p.bucket, toNum(p.count), toNum(p.amount), '');
  }
  for (const f of s.funnel as Array<Record<string, unknown>>) {
    row('funnel', f.key, toNum(f.count), toNum(f.amount), f.label);
  }
  for (const src of s.sources as Array<Record<string, unknown>>) {
    row('sources', src.key, toNum(src.count), toNum(src.amount), src.label);
  }
  for (const t of s.team as Array<Record<string, unknown>>) {
    row('team', t.owner_id, toNum(t.deals_count), toNum(t.amount), t.owner_name);
  }
  for (const d of (s.byDepartment ?? []) as Array<Record<string, unknown>>) {
    row('by_department', d.department_id, toNum(d.deals_count), toNum(d.amount), d.department_name);
  }
  for (const t of (s.orderTypes ?? []) as Array<Record<string, unknown>>) {
    row('order_types', t.order_type_id, toNum(t.orders_count), '', t.order_type_name);
  }
  for (const d of (s.stageDurations ?? []) as Array<Record<string, unknown>>) {
    row('stage_timing', d.stage_id, toNum(d.transition_count), toNum(d.avg_duration_ms), d.label);
  }
  return lines.join('\n');
}
