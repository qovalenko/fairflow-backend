import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { IdentityResolverService } from './identity-resolver.service';

// `params`/`query` намеренно `unknown`: у вызывающих BFF-контроллеров они
// типизированы по-разному (crm-bff GrpcReq — `unknown`), а сузить их безопаснее
// в одном месте (`routeProjectId`), чем требовать общий тип от всех.
type NamesReq = FastifyRequest & {
  user?: { userId?: string };
  params?: unknown;
  query?: unknown;
};

/** TTL кэша справочника отделов (тот же, что у IdentityResolverService/statistics). */
const DEPARTMENT_CACHE_TTL_MS = 30_000;

/** TTL кэша проектного справочника стадий (как в StatisticsBffController). */
const STAGE_CACHE_TTL_MS = 30_000;

/** TTL кэша справочника источников сделок (pipe ListDealSources). */
const SOURCE_CACHE_TTL_MS = 30_000;

const arr = (x: unknown): Record<string, unknown>[] =>
  Array.isArray(x) ? (x as Record<string, unknown>[]) : [];

const idOf = (row: Record<string, unknown>, field: string): string =>
  row[field] == null ? '' : String(row[field]).trim();

/**
 * Подстановка display-имён в результат прогона отчёта (`POST /v1/reports/:id/run`).
 *
 * Домен reports группирует сделки по `assigneeId`/`departmentId` и справочников
 * людей и отделов не видит — в `data_json` уезжают сырые id (`deals_by_manager[].
 * manager_id`, `deals_by_department[].department_id`, reports.service.ts buildSummary).
 * Фронт же читает `manager_name ?? manager_id` и `department_name ?? department_id`
 * (host/src/services/ReportsService.ts), поэтому без резолва на вкладках
 * «По менеджерам» и «Сравнение отделов» пользователь видит UUID — в таблице,
 * в подписях графика и в опциях фильтра менеджеров.
 *
 * Gateway — единственная точка, знающая и агрегат (reports), и справочники
 * (auth `UserDirectoryGrpc`, control `OrganizationGrpc`), поэтому join делается
 * здесь — тем же контрактом, что `AssigneeNameInterceptor` для CRM-ответов и
 * `StatisticsBffController` для срезов дашборда.
 *
 * TODO-470: тем же контрактом подписываются СТАДИИ (`deals_by_stage[].stage_id`,
 * `orders_by_stage[].stage_id` из buildSummary) — справочник стадий живёт в
 * домене pipe, reports его не видит, поэтому базовая вкладка отчёта («Продажи»/
 * «Воронка») показывала колонку UUID. Резолв — тот же `PipeGrpc.ListPipelines`,
 * что уже используется в `StatisticsBffController.resolveStageNames` для воронки
 * дашборда, чтобы одна и та же стадия называлась одинаково на обоих экранах.
 *
 * Все резолвы fail-soft и батчевые: недоступен auth/control/pipe — имя просто не
 * подставится (строка останется с id, фронт деградирует до него), цифры отчёта
 * не теряются. Сырые `manager_id`/`department_id`/`stage_id` НЕ трогаются: по ним
 * фронт делает drill в список сделок (по display-имени список не сматчить).
 */
@Injectable()
export class ReportRunNamesService implements OnModuleInit {
  private organization!: { listDepartments: (x: unknown, m?: unknown) => unknown };
  private pipe!: {
    listPipelines: (x: unknown, m?: unknown) => unknown;
    listDealSources: (x: unknown, m?: unknown) => unknown;
  };
  /** Кэш справочника отделов: id → название (справочник инстансный, не проектный). */
  private departmentNames?: { byId: Map<string, string>; expiresAt: number };
  /** Кэш стадий: справочник ПРОЕКТНЫЙ, поэтому ключуется projectId. */
  private stageNames = new Map<string, { byId: Map<string, string>; expiresAt: number }>();
  /** Кэш источников сделок: проектный справочник pipe. */
  private sourceNames = new Map<string, { byId: Map<string, string>; expiresAt: number }>();

  constructor(
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly identity: IdentityResolverService,
  ) {}

  onModuleInit() {
    this.organization = this.controlClient.getService('OrganizationGrpc');
    this.pipe = this.pipeClient.getService('PipeGrpc');
  }

  /**
   * projectId прогона отчёта — ТОЛЬКО из маршрута: path-параметр, затем
   * `?projectId=`, затем заголовок `x-project-id` (тот же порядок, что у
   * ProjectAccessGuard, который на этом же projectId проверил членство). Тело
   * запроса не читается вовсе — граница проекта не должна зависеть от того,
   * что прислал клиент в body (INV).
   */
  private routeProjectId(req: NamesReq): string {
    const bag = (v: unknown): Record<string, unknown> | undefined =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    const params = bag(req.params);
    const query = bag(req.query);
    const header = req.headers?.['x-project-id'];
    const raw = params?.projectId ?? query?.projectId ?? (typeof header === 'string' ? header : '');
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /**
   * id стадии → название (`PipeGrpc.ListPipelines`). Стадии проектные, поэтому
   * кэш на projectId + TTL; ошибка НЕ кэшируется. Пустой projectId (маршрут без
   * проектного контекста) → RPC не дёргаем: домен всё равно ответил бы
   * INVALID_ARGUMENT, а отчёт от этого падать не должен.
   */
  private async resolveStageNames(
    req: NamesReq,
    projectId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (!projectId || ids.length === 0) return new Map();
    const now = Date.now();
    const cached = this.stageNames.get(projectId);
    if (cached && cached.expiresAt > now) return cached.byId;
    if (cached) this.stageNames.delete(projectId);
    try {
      const r = (await grpcBffCall(
        this.pipe.listPipelines(
          { project_id: projectId },
          this.outboundMeta.build(req, { projectId }),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const p of arr(r?.list)) {
        for (const s of arr(p.stages)) {
          const id = String(s.id ?? '').trim();
          const name = String(s.name ?? '').trim();
          if (id && name) byId.set(id, name);
        }
      }
      this.stageNames.set(projectId, { byId, expiresAt: now + STAGE_CACHE_TTL_MS });
      return byId;
    } catch {
      return new Map();
    }
  }

  /**
   * id источника → название (`PipeGrpc.ListDealSources`). Тот же контракт, что
   * `StatisticsBffController.resolveSourceNames` для виджета sources дашборда.
   */
  private async resolveSourceNames(req: NamesReq, projectId: string): Promise<Map<string, string>> {
    if (!projectId) return new Map();
    const now = Date.now();
    const cached = this.sourceNames.get(projectId);
    if (cached && cached.expiresAt > now) return cached.byId;
    if (cached) this.sourceNames.delete(projectId);
    try {
      const r = (await grpcBffCall(
        this.pipe.listDealSources(
          { project_id: projectId },
          this.outboundMeta.build(req, { projectId }),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const s of arr(r?.list)) {
        const id = String(s.id ?? '').trim();
        const name = String(s.name ?? '').trim();
        if (id && name) byId.set(id, name);
      }
      this.sourceNames.set(projectId, { byId, expiresAt: now + SOURCE_CACHE_TTL_MS });
      return byId;
    } catch {
      return new Map();
    }
  }

  /**
   * id отдела → название через control `OrganizationGrpc.ListDepartments`.
   * control сам разрешает системный org-якорь (клиентский `organization_id`
   * игнорируется, DEORG-BE-16) и проверяет членство актора, поэтому здесь
   * достаточно `actor_user_id`: не-член названий не получит (fail-closed на
   * стороне control). Ошибка НЕ кэшируется и НЕ ломает отчёт.
   */
  private async resolveDepartmentNames(req: NamesReq, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const now = Date.now();
    const cached = this.departmentNames;
    if (cached && cached.expiresAt > now) return cached.byId;
    try {
      const r = (await grpcBffCall(
        this.organization.listDepartments(
          { organization_id: '', actor_user_id: req.user?.userId ?? '' },
          this.outboundMeta.build(req),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const byId = new Map<string, string>();
      for (const d of arr(r?.list)) {
        const id = idOf(d, 'id');
        const name = String(d.name ?? '').trim();
        if (id && name) byId.set(id, name);
      }
      this.departmentNames = { byId, expiresAt: now + DEPARTMENT_CACHE_TTL_MS };
      return byId;
    } catch {
      return new Map();
    }
  }

  /**
   * Обогащает ответ `ReportsGrpc.RunReport`: разбирает `data_json`, дописывает
   * строкам среза `manager_name` / `department_name` / `stage_name` и
   * сериализует обратно. Всё, что не разобралось (не-JSON, отсутствующие срезы),
   * возвращается как есть — обогащение не может «уронить» прогон отчёта.
   */
  async enrichRunResult<T extends Record<string, unknown>>(req: NamesReq, run: T): Promise<T> {
    const dataJson = run?.data_json;
    if (typeof dataJson !== 'string' || dataJson === '') return run;

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(dataJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return run;
      data = parsed as Record<string, unknown>;
    } catch {
      return run;
    }

    // TODO-253: срез пресета `activity` группируется по тому же `manager_id`,
    // что и `deals_by_manager`, — подписывается тем же справочником.
    const managerRows = [...arr(data.deals_by_manager), ...arr(data.activities_by_manager)];
    const departmentRows = arr(data.deals_by_department);
    // TODO-470: срезы по стадиям есть у КАЖДОГО прогона (buildSummary отдаёт их
    // всегда), поэтому и подписи стадий нужны на базовой вкладке, а не только на
    // «По менеджерам»/«Отделам». `funnel_stages` (пресет «По воронке») домен
    // подписывает сам из pipe, но при недоступном pipe имя приедет отсюда.
    const stageRows = [
      ...arr(data.deals_by_stage),
      ...arr(data.orders_by_stage),
      ...arr(data.funnel_stages),
    ];
    const sourceRows = arr(data.deals_by_source);
    const managerIds = [...new Set(managerRows.map((r) => idOf(r, 'manager_id')).filter(Boolean))];
    const departmentIds = [
      ...new Set(departmentRows.map((r) => idOf(r, 'department_id')).filter(Boolean)),
    ];
    const stageIds = [...new Set(stageRows.map((r) => idOf(r, 'stage_id')).filter(Boolean))];
    const projectId = this.routeProjectId(req);
    // Все срезы пусты (отчёт без данных) → ни одного RPC.
    if (
      managerIds.length === 0 &&
      departmentIds.length === 0 &&
      stageIds.length === 0 &&
      sourceRows.length === 0
    ) {
      return run;
    }

    const [managerNames, departmentNames, stageNames, sourceNames] = await Promise.all([
      managerIds.length
        ? this.identity.resolveNames(req, managerIds)
        : Promise.resolve(new Map<string, string>()),
      this.resolveDepartmentNames(req, departmentIds),
      this.resolveStageNames(req, projectId, stageIds),
      sourceRows.length
        ? this.resolveSourceNames(req, projectId)
        : Promise.resolve(new Map<string, string>()),
    ]);

    let touched = false;
    for (const row of stageRows) {
      const name = stageNames.get(idOf(row, 'stage_id'));
      // `stage_id` остаётся сырым: по нему фронт делает drill (primaryDimension).
      if (name) {
        row.stage_name = name;
        touched = true;
      }
    }
    for (const row of managerRows) {
      const name = managerNames.get(idOf(row, 'manager_id'));
      // Пустое имя не пишем: фронт делает `manager_name ?? manager_id`, и '' сожрал
      // бы фоллбек на id (?? срабатывает только на null/undefined).
      if (name) {
        row.manager_name = name;
        touched = true;
      }
    }
    for (const row of departmentRows) {
      const name = departmentNames.get(idOf(row, 'department_id'));
      if (name) {
        row.department_name = name;
        touched = true;
      }
    }
    for (const row of sourceRows) {
      const key = idOf(row, 'source');
      const name = sourceNames.get(key);
      // `source` остаётся сырым ключом (drill); пустой ключ = «не указан».
      if (name) {
        row.source_name = name;
        touched = true;
      }
    }
    if (!touched) return run;

    return { ...run, data_json: JSON.stringify(data) };
  }
}
