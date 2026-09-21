import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import {
  RequireModule,
  readVisibilityScope,
  readUserId,
  readEnabledModules,
  readGatewayMetadata,
  resolveProjectId,
} from '@fairflow/shared';
import { ReportsService } from './reports.service';
import { MetricsService } from '../metrics/metrics.service';
// Агрегаты читают предикат вместе с набором по subject'ам-источникам (`bySubject`):
// маршрутный `readAccessPredicate` знает только про subject маршрута
// (`reports`/`statistics`), а правило политики на `deals` обязано сузить именно
// сделки. Ключ метадаты тот же — см. access-predicate-bundle.ts.
import { readAggregateAccessPredicate } from './access-predicate-bundle';

function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

/**
 * TODO-475: идентификатор ВЫЗОВА для ключа идемпотентности факта аудита.
 *
 * Источник ровно один — серверный `x-gw-call-id` (gateway чеканит randomUUID на
 * каждую сборку метадаты). Клиентские `idempotency-key` и `x-request-id` здесь
 * НЕДОПУСТИМЫ: gateway echo-ит `x-request-id` из заголовка запроса
 * (shared/src/grpc/outbound-metadata.ts), поэтому вызов с фиксированным
 * `X-Request-Id` схлопнул бы сотню экспортов в один факт `statistics.exported`
 * и убил бы неотказуемость FR-MSTAT-23. Пусто (s2s-вызов мимо gateway) →
 * `undefined`: ключа нет, шина падает на messageId — дубль факта безопаснее
 * пропавшего.
 */
/** Server-minted per-call id (`x-gw-call-id`). Key lives in shared P8 wave; read inline until node_modules shared catches up. */
const GW_CALL_ID = 'x-gw-call-id';

function callId(metadata?: Metadata): string | undefined {
  const cid = readGatewayMetadata(metadata, GW_CALL_ID).trim();
  return cid || undefined;
}

@Controller()
@RequireModule('reports')
export class ReportsGrpcController {
  constructor(
    private readonly reports: ReportsService,
    private readonly metrics: MetricsService,
  ) {}

  @GrpcMethod('ReportsGrpc', 'ListReports')
  list(
    d: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
    },
    metadata?: Metadata,
  ) {
    // TODO-466: `x-user-id` — гейт личных определений отчётов (см. ReportsService
    // .reportVisibilityMatch). Пусто → видны только проектные (fail-closed).
    return this.reports.list(
      pid(d, metadata),
      d.page_index ?? 0,
      d.page_size ?? 25,
      d.query,
      readUserId(metadata),
    );
  }

  @GrpcMethod('ReportsGrpc', 'GetReport')
  get(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.reports.get(pid(d, metadata), d.id, readUserId(metadata));
  }

  @GrpcMethod('ReportsGrpc', 'CreateReport')
  create(
    d: {
      project_id?: string;
      projectId?: string;
      name?: string;
      description?: string;
      kind?: string;
      spec_json?: string;
      visibility?: string;
    },
    metadata?: Metadata,
  ) {
    return this.reports.create(
      pid(d, metadata),
      d.name,
      d.description,
      d.kind,
      d.spec_json,
      readUserId(metadata),
      d.visibility,
    );
  }

  @GrpcMethod('ReportsGrpc', 'UpdateReport')
  update(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      name?: string;
      description?: string;
      spec_json?: string;
      visibility?: string;
    },
    metadata?: Metadata,
  ) {
    return this.reports.update(
      pid(d, metadata),
      d.id,
      d.name,
      d.description,
      d.spec_json,
      d.visibility,
      readUserId(metadata),
    );
  }

  @GrpcMethod('ReportsGrpc', 'DeleteReport')
  remove(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.reports.remove(pid(d, metadata), d.id, readUserId(metadata));
  }

  @GrpcMethod('ReportsGrpc', 'RunReport')
  async run(
    d: { project_id?: string; projectId?: string; id: string; params_json?: string },
    metadata?: Metadata,
  ) {
    const started = Date.now();
    try {
      const result = await this.reports.run(
        pid(d, metadata),
        d.id,
        d.params_json,
        readVisibilityScope(metadata),
        readUserId(metadata),
        true,
        readAggregateAccessPredicate(metadata),
        callId(metadata),
        readEnabledModules(metadata),
      );
      this.metrics.recordModuleRequest('RunReport', 'ok', Date.now() - started);
      return result;
    } catch (err) {
      this.metrics.recordModuleRequest('RunReport', 'error', Date.now() - started);
      throw err;
    }
  }

  @GrpcMethod('ReportsGrpc', 'ExportReport')
  export(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      format?: string;
      params_json?: string;
    },
    metadata?: Metadata,
  ) {
    return this.reports.export(
      pid(d, metadata),
      d.id,
      d.format,
      d.params_json,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAggregateAccessPredicate(metadata),
      callId(metadata),
      readEnabledModules(metadata),
    );
  }

  // FR-MSTAT-1/4: the operational dashboard is a STATISTICS-module endpoint that
  // merely lives in the reports listener (statistics has no own domain — see the
  // gateway StatisticsBffController). It MUST be gated on `statistics`, not on the
  // class-level `@RequireModule('reports')`: reports is an independent optional
  // module (soft-dep only), so gating dashboard on it wrongly returns 403
  // MODULE_DISABLED whenever statistics is enabled but reports is not — even for
  // the project OWNER. The method-level decorator wins in getAllAndOverride.
  @RequireModule('statistics')
  @GrpcMethod('ReportsGrpc', 'GetDashboard')
  getDashboard(
    d: {
      project_id?: string;
      projectId?: string;
      period?: string;
      from?: number;
      to?: number;
    },
    metadata?: Metadata,
  ) {
    // FR-MSTAT-4: visibility scope from metadata is mandatory (fail-closed),
    // exactly like RunReport — aggregates never bypass the viewer's scope.
    // enabledModules гейтит KPI/списки по модулю-источнику (как в GetMetrics),
    // ABAC-предикат сужает выборку вторым слоем.
    return this.reports.getDashboard(
      pid(d, metadata),
      d.period,
      d.from,
      d.to,
      readVisibilityScope(metadata),
      readEnabledModules(metadata),
      readAggregateAccessPredicate(metadata),
    );
  }

  // FR-MSTAT-16/17: analytics (GetMetrics) is likewise a STATISTICS-module
  // endpoint hosted in the reports listener — gate it on `statistics`, not on the
  // class-level reports requirement (same rationale as GetDashboard above).
  @RequireModule('statistics')
  @GrpcMethod('ReportsGrpc', 'GetMetrics')
  getMetrics(
    d: {
      project_id?: string;
      projectId?: string;
      period?: string;
      from?: number;
      to?: number;
      slices?: string[];
    },
    metadata?: Metadata,
  ) {
    // FR-MSTAT-4/16/17: visibility scope from metadata is mandatory (fail-closed),
    // same as GetDashboard/RunReport. enabledModules gate per-slice availability.
    return this.reports.getMetrics(
      pid(d, metadata),
      d.period,
      d.from,
      d.to,
      d.slices,
      readVisibilityScope(metadata),
      readEnabledModules(metadata),
      readAggregateAccessPredicate(metadata),
    );
  }

  @RequireModule('deals')
  @GrpcMethod('ReportsGrpc', 'GetDealStageHistory')
  getDealStageHistory(
    d: { project_id?: string; projectId?: string; deal_id?: string; dealId?: string },
    metadata?: Metadata,
  ) {
    return this.reports.getDealStageHistory(
      pid(d, metadata),
      d.deal_id ?? d.dealId ?? '',
      readVisibilityScope(metadata),
      readAggregateAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ReportsGrpc', 'DrillReport')
  drill(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      params_json?: string;
      dimension?: string;
      value?: string;
      limit?: number;
      cursor?: string;
    },
    metadata?: Metadata,
  ) {
    return this.reports.drill(
      pid(d, metadata),
      d.id,
      d.params_json,
      d.dimension ?? '',
      d.value ?? '',
      d.limit ?? 50,
      d.cursor,
      readVisibilityScope(metadata),
      readAggregateAccessPredicate(metadata),
      readUserId(metadata),
    );
  }
}
