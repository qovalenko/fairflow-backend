import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import {
  RequireModule,
  RequireRoles,
  readVisibilityScope,
  readAccessPredicate,
  readUserId,
  readIdempotencyKey,
  resolveProjectId,
  resolveDocumentVariablesScope,
} from '@fairflow/shared';
import { PipeService } from './pipe.service';
import { DemoSeedService } from './demo-seed.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * Effective project id with defense-in-depth (IMPLEMENTATION-DEBT Д-5): trusted
 * x-project-id metadata wins over the body; a conflicting body projectId is
 * rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
 */
function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

/**
 * TODO-075: the same resolution as {@link pid}, but write paths fail fast on an
 * empty result. `resolveProjectId` falls back to the body for s2s callers and the
 * body may legitimately be absent — so with no metadata and no body the domain
 * used to write into the pseudo-project `''`: a pipeline/deal/source nobody can
 * ever read back (every read is scoped by a real projectId) and which no purge
 * ever cleans. Reads keep the permissive `pid()` — an empty project simply
 * matches nothing there. The gateway's own check (authoritativeProjectId) stays;
 * this is the domain-side half that also covers s2s/provisioning callers.
 */
function writePid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  const projectId = pid(d, metadata);
  if (!projectId.trim()) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'projectId обязателен',
    });
  }
  return projectId;
}

@Controller()
@RequireModule('deals')
export class PipeGrpcController {
  constructor(
    private readonly pipe: PipeService,
    private readonly demoSeed: DemoSeedService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @GrpcMethod('PipeGrpc', 'ListPipelines')
  listPipelines(d: { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.pipe.listPipelines(pid(d, metadata));
  }

  /**
   * Cross-domain read-only count for the product delete-guard / reconciliation
   * (product.md §3.10). Service-to-service; projectId from metadata (S7) — never
   * counts another project's deals. No visibility scope: the caller is the product
   * domain reconciling its own catalog counters, not an end-user read path.
   */
  @GrpcMethod('PipeGrpc', 'CountDealsByProduct')
  countDealsByProduct(
    d: { project_id?: string; projectId?: string; product_id?: string },
    metadata?: Metadata,
  ) {
    return this.pipe.countDealsByProduct(pid(d, metadata), String(d.product_id ?? ''));
  }

  @GrpcMethod('PipeGrpc', 'ListDealSources')
  listDealSources(d: { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.pipe.listDealSources(pid(d, metadata));
  }

  @GrpcMethod('PipeGrpc', 'ListDeals')
  async listDeals(
    d: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      pipeline_id?: string;
      stage_id?: string;
      assignee_id?: string;
      department_id?: string;
      status?: string;
      contact_id?: string;
      company_id?: string;
      source?: string;
      amount_min?: number;
      amount_max?: number;
      // TODO-189: корзина сделок (pipe.proto:107). Замещающий флаг — true отдаёт
      // ТОЛЬКО удалённые. Без объявления здесь поле молча терялось на границе
      // gRPC → сервис, и «Корзина сделок» показывала живые сделки как удалённые.
      include_deleted?: boolean;
      stage_days_min?: number;
      min_days_on_stage?: number;
      without_assignee?: boolean;
    },
    metadata?: Metadata,
  ) {
    const r = await this.pipe.listDeals(
      pid(d, metadata),
      d.page_index ?? 0,
      d.page_size ?? 25,
      d.query,
      d.pipeline_id,
      d.stage_id,
      readVisibilityScope(metadata),
      {
        assigneeId: d.assignee_id,
        departmentId: d.department_id,
        status: d.status,
        contactId: d.contact_id,
        companyId: d.company_id,
        source: d.source,
        amountMin: d.amount_min,
        amountMax: d.amount_max,
        includeDeleted: Boolean(d.include_deleted),
        stageDaysMin: d.stage_days_min,
        minDaysOnStage: d.min_days_on_stage,
        withoutAssignee: Boolean(d.without_assignee),
      },
      readAccessPredicate(metadata),
    );
    return {
      list: r.list,
      total: r.total,
      hidden_by_policy: r.hiddenByPolicy ?? 0,
    };
  }

  @GrpcMethod('PipeGrpc', 'GetDealsKanban')
  getKanban(
    d: {
      project_id?: string;
      projectId?: string;
      pipeline_id?: string;
      query?: string;
      assignee_id?: string;
      department_id?: string;
      status?: string;
      contact_id?: string;
      company_id?: string;
      source?: string;
      amount_min?: number;
      amount_max?: number;
      stage_days_min?: number;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.getKanban(
      pid(d, metadata),
      d.pipeline_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      {
        assigneeId: d.assignee_id,
        departmentId: d.department_id,
        status: d.status,
        contactId: d.contact_id,
        companyId: d.company_id,
        source: d.source,
        amountMin: d.amount_min,
        amountMax: d.amount_max,
        stageDaysMin: d.stage_days_min,
      },
      d.query,
    );
  }

  @GrpcMethod('PipeGrpc', 'GetDeal')
  getDeal(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.pipe.getDeal(
      pid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      false,
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'ResolveDocumentVariables')
  resolveDocumentVariables(
    d: { project_id?: string; projectId?: string; record_id?: string; recordId?: string },
    metadata?: Metadata,
  ) {
    const { projectId, recordId } = resolveDocumentVariablesScope(metadata, d);
    return this.pipe.resolveDocumentVariables(projectId, recordId, readVisibilityScope(metadata));
  }

  @GrpcMethod('PipeGrpc', 'CreateDeal')
  createDeal(d: Record<string, unknown>, metadata?: Metadata) {
    // Ownership: explicit assignee, else creator — unless department owns the deal.
    const departmentId = String(d.department_id ?? '');
    const assigneeId =
      (d.assignee_id as string) || (!departmentId ? readUserId(metadata) : '') || undefined;
    // Trusted project id wins over body (Д-5): override what the service reads.
    // TODO-075: a write with no resolvable project is rejected, never stored in ''.
    const projectId = writePid(d as { project_id?: string; projectId?: string }, metadata);
    const selfId = readUserId(metadata) || undefined;
    // P2.d: dedup retried creates on `Idempotency-Key` — replay the first response.
    return this.idempotency.withIdempotency(projectId, readIdempotencyKey(metadata), 'create', () =>
      this.pipe.createDeal(
        {
          ...d,
          project_id: projectId,
          projectId,
          assignee_id: assigneeId,
        },
        selfId,
        readVisibilityScope(metadata),
      ),
    );
  }

  @GrpcMethod('PipeGrpc', 'UpdateDeal')
  updateDeal(
    d: { project_id?: string; projectId?: string; id: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.pipe.updateDeal(
      writePid(d, metadata),
      d.id,
      d,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'DeleteDeal')
  deleteDeal(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.pipe.deleteDeal(
      writePid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'RestoreDeal')
  restoreDeal(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.pipe.restoreDeal(
      writePid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'MoveDealToStage')
  moveDeal(
    d: { project_id?: string; projectId?: string; deal_id: string; stage_id: string },
    metadata?: Metadata,
  ) {
    return this.pipe.moveDealToStage(
      writePid(d, metadata),
      d.deal_id,
      d.stage_id,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'GetDealDrift')
  getDealDrift(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.pipe.getDealDrift(
      pid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'CloseDeal')
  closeDeal(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      result: string;
      lost_reason_id?: string;
      lost_reason_comment?: string;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.closeDeal(
      writePid(d, metadata),
      d.id,
      d.result,
      d.lost_reason_id,
      d.lost_reason_comment,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('PipeGrpc', 'ReopenDeal')
  reopenDeal(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      reason: string;
      target_stage_id: string;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.reopenDeal(
      writePid(d, metadata),
      d.id,
      d.reason,
      d.target_stage_id,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'LinkContact')
  linkContact(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      contact_id: string;
      snapshot?: { name?: string; phone?: string; email?: string };
    },
    metadata?: Metadata,
  ) {
    return this.pipe.linkContact(
      writePid(d, metadata),
      d.id,
      d.contact_id,
      d.snapshot,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'LinkCompany')
  linkCompany(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      company_id: string;
      snapshot?: { name?: string; inn?: string };
    },
    metadata?: Metadata,
  ) {
    return this.pipe.linkCompany(
      writePid(d, metadata),
      d.id,
      d.company_id,
      d.snapshot,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'AcceptContactDrift')
  acceptDrift(
    d: { project_id?: string; projectId?: string; id: string; target?: string },
    metadata?: Metadata,
  ) {
    return this.pipe.acceptContactDrift(
      writePid(d, metadata),
      d.id,
      d.target,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'BulkAcceptDrift')
  bulkAcceptDrift(
    d: {
      project_id?: string;
      projectId?: string;
      deal_ids?: string[];
      target?: string;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.bulkAcceptDrift(
      writePid(d, metadata),
      d.deal_ids ?? [],
      d.target,
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  // OQ-DEALS-050 is still open — do not let member self-reassign via bulk
  // until product decides. Manager+ remains the transport gate (FR-DEALS-340).
  @RequireRoles('manager')
  @GrpcMethod('PipeGrpc', 'BulkUpdateDeals')
  bulkUpdate(
    d: {
      project_id?: string;
      projectId?: string;
      deal_ids: string[];
      change: {
        assignee_id?: string;
        department_id?: string;
        stage_id?: string;
        pipeline_id?: string;
      };
    },
    metadata?: Metadata,
  ) {
    return this.pipe.bulkUpdateDeals(
      writePid(d, metadata),
      d.deal_ids ?? [],
      {
        assigneeId: d.change?.assignee_id,
        departmentId: d.change?.department_id,
        stageId: d.change?.stage_id,
        pipelineId: d.change?.pipeline_id,
      },
      readVisibilityScope(metadata),
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  // ---- Pipelines CRUD ----
  @GrpcMethod('PipeGrpc', 'CreatePipeline')
  createPipeline(
    d: { project_id?: string; projectId?: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.pipe.createPipeline(writePid(d, metadata), d);
  }

  @GrpcMethod('PipeGrpc', 'UpdatePipeline')
  updatePipeline(
    d: { project_id?: string; projectId?: string; id: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.pipe.updatePipeline(writePid(d, metadata), d.id, d);
  }

  @GrpcMethod('PipeGrpc', 'DeletePipeline')
  deletePipeline(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.pipe.deletePipeline(writePid(d, metadata), d.id);
  }

  // ---- Deal sources CRUD ----
  @GrpcMethod('PipeGrpc', 'CreateDealSource')
  createDealSource(
    d: { project_id?: string; projectId?: string; name: string; color?: string },
    metadata?: Metadata,
  ) {
    return this.pipe.createDealSource(writePid(d, metadata), d.name, d.color ?? '');
  }

  @GrpcMethod('PipeGrpc', 'UpdateDealSource')
  updateDealSource(
    d: { project_id?: string; projectId?: string; id: string; name?: string; color?: string },
    metadata?: Metadata,
  ) {
    return this.pipe.updateDealSource(writePid(d, metadata), d.id, d.name, d.color);
  }

  @GrpcMethod('PipeGrpc', 'DeleteDealSource')
  deleteDealSource(
    d: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    return this.pipe.deleteDealSource(writePid(d, metadata), d.id);
  }

  // ---- Lost reasons CRUD ----
  @GrpcMethod('PipeGrpc', 'ListLostReasons')
  listLostReasons(
    d: { project_id?: string; projectId?: string; active_only?: boolean },
    metadata?: Metadata,
  ) {
    return this.pipe.listLostReasons(pid(d, metadata), d.active_only);
  }

  @GrpcMethod('PipeGrpc', 'CreateLostReason')
  createLostReason(
    d: { project_id?: string; projectId?: string; name: string; order?: number; active?: boolean },
    metadata?: Metadata,
  ) {
    return this.pipe.createLostReason(writePid(d, metadata), d.name, d.order, d.active);
  }

  @GrpcMethod('PipeGrpc', 'UpdateLostReason')
  updateLostReason(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      name?: string;
      order?: number;
      active?: boolean;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.updateLostReason(writePid(d, metadata), d.id, d.name, d.order, d.active);
  }

  @GrpcMethod('PipeGrpc', 'DeleteLostReason')
  deleteLostReason(
    d: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    return this.pipe.deleteLostReason(writePid(d, metadata), d.id);
  }

  @GrpcMethod('PipeGrpc', 'GetDashboard')
  dashboard(
    d: {
      project_id?: string;
      projectId?: string;
      from?: number;
      to?: number;
      pipeline_id?: string;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.getDashboard(
      pid(d, metadata),
      readVisibilityScope(metadata),
      {
        from: d.from,
        to: d.to,
        pipelineId: d.pipeline_id,
      },
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('PipeGrpc', 'ProvisionDefaults')
  provisionDefaults(
    d: {
      project_id?: string;
      projectId?: string;
      template_id?: string;
      templateId?: string;
    },
    metadata?: Metadata,
  ) {
    return this.pipe.provisionDefaults(writePid(d, metadata), d.template_id ?? d.templateId);
  }

  /**
   * Демо-наполнение проекта (вызывается control'ом после ProvisionDefaults).
   * projectId из metadata, иначе из тела (s2s, как у ProvisionDefaults). Только
   * по включённым модулям. Best-effort на стороне control'а.
   */
  @GrpcMethod('PipeGrpc', 'SeedDemoData')
  seedDemoData(
    d: {
      project_id?: string;
      projectId?: string;
      owner_id?: string;
      ownerId?: string;
      assignee_ids?: string[];
      assigneeIds?: string[];
      enabled_modules?: string[];
      enabledModules?: string[];
    },
    metadata?: Metadata,
  ) {
    return this.demoSeed.seed({
      projectId: writePid(d, metadata),
      ownerId: String(d.owner_id ?? d.ownerId ?? ''),
      assigneeIds: d.assignee_ids ?? d.assigneeIds ?? [],
      enabledModules: d.enabled_modules ?? d.enabledModules ?? [],
    });
  }

  @GrpcMethod('PipeGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(d: { project_id?: string; user_id?: string }, metadata?: Metadata) {
    const projectId = writePid(d, metadata);
    const count = await this.pipe.countOwnedRecords(projectId, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('PipeGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = writePid(d, metadata);
    const r = await this.pipe.reassignOwnedRecords(
      projectId,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }
}
