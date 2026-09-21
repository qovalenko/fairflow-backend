import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { CompaniesService } from '../companies/companies.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ReassignTargetValidator } from '../companies/reassign-target.validator';
import {
  RequireModule,
  readVisibilityScope,
  readAccessPredicate,
  readUserId,
  readGatewayMetadata,
  readIdempotencyKey,
  resolveProjectId,
  resolveDocumentVariablesScope,
} from '@fairflow/shared';
import type { EmitContext } from '../companies/companies.service';

/** Build event actor/causation context from gateway metadata (RFC-4 §Р-1). */
function emitCtx(metadata?: Metadata): EmitContext {
  const userId = readUserId(metadata) || undefined;
  const traceId = readGatewayMetadata(metadata, 'x-trace-id') || undefined;
  return { userId, causation: traceId ? { traceId } : undefined };
}

function toProto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    project_id: String(row.projectId ?? ''),
    name: String(row.name ?? ''),
    inn: String(row.inn ?? ''),
    phone: String(row.phone ?? ''),
    email: String(row.email ?? ''),
    industry: String(row.industry ?? ''),
    owner_id: String(row.ownerId ?? ''),
    tags: (row.tags as string[]) ?? [],
    notes: String(row.notes ?? ''),
    kpp: String(row.kpp ?? ''),
    legal_address: String(row.legalAddress ?? ''),
    ogrn: String(row.ogrn ?? ''),
    website: String(row.website ?? ''),
    domain: String(row.domain ?? ''),
    status: String(row.status ?? ''),
    department_id: String(row.departmentId ?? ''),
    region: String(row.region ?? ''),
    created_at: Number(row.createdAt ?? 0),
    updated_at: Number(row.updatedAt ?? 0),
    deleted_at: Number(row.deletedAt ?? 0),
    purge_at: Number(row.purgeAt ?? 0),
    // TODO-364: атрибуция (кто создал/изменил и откуда запись). Хранится в
    // CompanyDoc, но не проецировалась — gateway домапливал created_by/updated_by/
    // source, которых в ответе не было, и блок «Создал / Изменил» в карточке
    // компании был мёртв при любых правах.
    created_by: String(row.createdBy ?? ''),
    updated_by: String(row.updatedBy ?? ''),
    source: String(row.source ?? ''),
    bank_name: String(row.bankName ?? ''),
    bik: String(row.bik ?? ''),
    correspondent_account: String(row.correspondentAccount ?? ''),
    settlement_account: String(row.settlementAccount ?? ''),
    card_contacts_rev: Number(row.cardContactsRev ?? 0),
  };
}

@Controller()
@RequireModule('companies')
export class CompanyGrpcController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly idempotency: IdempotencyService,
    private readonly reassignTargets: ReassignTargetValidator,
  ) {}

  @GrpcMethod('CompanyGrpc', 'ListCompanies')
  async list(
    data: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      filter_owner_id?: string;
      filter_department_id?: string;
      filter_status?: string;
      filter_industry?: string;
      filter_region?: string;
      filter_tags?: string;
      sort_by?: string;
      sort_dir?: string;
      include_deleted?: boolean;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.list(
      projectId,
      {
        pageIndex: data.page_index ?? 0,
        pageSize: data.page_size ?? 25,
        query: data.query,
        filterOwnerId: data.filter_owner_id || undefined,
        filterDepartmentId: data.filter_department_id || undefined,
        filterStatus: data.filter_status || undefined,
        filterIndustry: data.filter_industry || undefined,
        filterRegion: data.filter_region || undefined,
        filterTags: data.filter_tags
          ? data.filter_tags
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        sortBy: data.sort_by || undefined,
        sortDir: data.sort_dir || undefined,
        includeDeleted: data.include_deleted,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return {
      list: r.list.map((x) => toProto(x as Record<string, unknown>)),
      total: r.total,
      hidden_by_policy: r.hiddenByPolicy ?? 0,
    };
  }

  @GrpcMethod('CompanyGrpc', 'ResolveDocumentVariables')
  async resolveDocumentVariables(
    data: { project_id?: string; projectId?: string; record_id?: string; recordId?: string },
    metadata?: Metadata,
  ) {
    const { projectId, recordId } = resolveDocumentVariablesScope(metadata, data);
    return this.companies.resolveDocumentVariables(
      projectId,
      recordId,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('CompanyGrpc', 'GetCompany')
  async get(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    return toProto(
      (await this.companies.findOne(
        projectId,
        data.id,
        readVisibilityScope(metadata),
        readAccessPredicate(metadata),
      )) as Record<string, unknown>,
    );
  }

  @GrpcMethod('CompanyGrpc', 'CreateCompany')
  async create(
    data: {
      project_id?: string;
      projectId?: string;
      name: string;
      inn?: string;
      phone?: string;
      email?: string;
      industry?: string;
      assignee_id?: string;
      kpp?: string;
      ogrn?: string;
      website?: string;
      status?: string;
      department_id?: string;
      region?: string;
      legal_address?: string;
      tags?: string[];
      notes?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const userId = readUserId(metadata) || undefined;
    // Ownership: explicit assignee, else the creator — no orphan records (spec §13.2).
    const ownerId = data.assignee_id || userId;
    // P2.d: dedup retried creates on `Idempotency-Key` — replay the first response.
    return this.idempotency.withIdempotency(projectId, readIdempotencyKey(metadata), 'create', () =>
      this.runCreate(projectId, ownerId, userId, data, metadata),
    );
  }

  private async runCreate(
    projectId: string,
    ownerId: string | undefined,
    userId: string | undefined,
    data: {
      name: string;
      inn?: string;
      phone?: string;
      email?: string;
      industry?: string;
      kpp?: string;
      ogrn?: string;
      website?: string;
      status?: string;
      department_id?: string;
      region?: string;
      legal_address?: string;
      tags?: string[];
      notes?: string;
      bank_name?: string;
      bik?: string;
      correspondent_account?: string;
      settlement_account?: string;
      trash_collision_resolution?: string;
    },
    metadata?: Metadata,
  ) {
    const row = await this.companies.create(
      projectId,
      {
        name: data.name,
        inn: data.inn,
        phone: data.phone,
        email: data.email,
        industry: data.industry,
        ownerId,
        kpp: data.kpp,
        ogrn: data.ogrn,
        website: data.website,
        status: data.status,
        departmentId: data.department_id,
        region: data.region,
        legalAddress: data.legal_address,
        tags: data.tags,
        notes: data.notes,
        bankName: data.bank_name,
        bik: data.bik,
        correspondentAccount: data.correspondent_account,
        settlementAccount: data.settlement_account,
        createdBy: userId,
      },
      emitCtx(metadata),
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      { trashCollisionResolution: data.trash_collision_resolution },
    );
    return toProto(row as Record<string, unknown>);
  }

  @GrpcMethod('CompanyGrpc', 'UpdateCompany')
  async update(
    data: {
      project_id?: string;
      projectId?: string;
      id: string;
      name?: string;
      inn?: string;
      phone?: string;
      email?: string;
      industry?: string;
      assignee_id?: string;
      kpp?: string;
      ogrn?: string;
      website?: string;
      status?: string;
      department_id?: string;
      region?: string;
      legal_address?: string;
      tags?: string[];
      notes?: string;
      bank_name?: string;
      bik?: string;
      correspondent_account?: string;
      settlement_account?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const row = await this.companies.update(
      projectId,
      data.id,
      {
        name: data.name,
        inn: data.inn,
        phone: data.phone,
        email: data.email,
        industry: data.industry,
        ownerId: data.assignee_id,
        kpp: data.kpp,
        ogrn: data.ogrn,
        website: data.website,
        status: data.status,
        departmentId: data.department_id,
        region: data.region,
        legalAddress: data.legal_address,
        tags: data.tags,
        notes: data.notes,
        bankName: data.bank_name,
        bik: data.bik,
        correspondentAccount: data.correspondent_account,
        settlementAccount: data.settlement_account,
        updatedBy: readUserId(metadata) || undefined,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      emitCtx(metadata),
    );
    return toProto(row as Record<string, unknown>);
  }

  @GrpcMethod('CompanyGrpc', 'UpdateOwner')
  async updateOwner(
    data: {
      project_id?: string;
      projectId?: string;
      id: string;
      owner_id: string;
      department_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const scope = readVisibilityScope(metadata);
    const nextOwnerId = (data.owner_id ?? '').trim();
    if (nextOwnerId) {
      await this.reassignTargets.assertOwnerAssignable(
        projectId,
        nextOwnerId,
        metadata,
        'ownerId',
        scope,
      );
    }
    const nextDepartmentId = (data.department_id ?? '').trim();
    if (nextDepartmentId) {
      await this.reassignTargets.assertDepartmentAssignable(
        projectId,
        nextDepartmentId,
        metadata,
        'departmentId',
      );
    }
    const row = await this.companies.updateOwner(
      projectId,
      data.id,
      data.owner_id,
      data.department_id || undefined,
      scope,
      readAccessPredicate(metadata),
      emitCtx(metadata),
    );
    return toProto(row as Record<string, unknown>);
  }

  @GrpcMethod('CompanyGrpc', 'DeleteCompany')
  async del(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const scope = readVisibilityScope(metadata);
    const snapshot = await this.companies.remove(
      projectId,
      data.id,
      scope,
      readAccessPredicate(metadata),
      emitCtx(metadata),
    );
    return toProto(snapshot as Record<string, unknown>);
  }

  /**
   * TODO-157 / FR-COMPANIES-040: «удалить навсегда» из корзины. The gateway routes
   * `DELETE /companies/:id?force=true` here; the soft-delete handler above stays on
   * the plain DELETE. Same scope + ABAC predicate as a read — purge is a write, and
   * the write gate equals the read gate (TODO-012).
   */
  @GrpcMethod('CompanyGrpc', 'PurgeCompany')
  async purge(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.purge(
      projectId,
      data.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      emitCtx(metadata),
    );
    return { id: r.id, purged: r.purged };
  }

  @GrpcMethod('CompanyGrpc', 'RestoreCompany')
  async restore(
    data: { project_id?: string; projectId?: string; id: string; strategy?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    return toProto(
      (await this.companies.restore(
        projectId,
        data.id,
        data.strategy || undefined,
        readVisibilityScope(metadata),
        readAccessPredicate(metadata),
        emitCtx(metadata),
      )) as Record<string, unknown>,
    );
  }

  @GrpcMethod('CompanyGrpc', 'ListTrash')
  async listTrash(
    data: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.listTrash(
      projectId,
      data.page_index ?? 0,
      data.page_size ?? 25,
      data.query,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return { list: r.list.map((x) => toProto(x as Record<string, unknown>)), total: r.total };
  }

  @GrpcMethod('CompanyGrpc', 'FindDuplicates')
  async findDuplicates(
    data: {
      project_id?: string;
      projectId?: string;
      inn?: string;
      name?: string;
      domain?: string;
      email?: string;
      website?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.findDuplicates(
      projectId,
      {
        inn: data.inn,
        name: data.name,
        domain: data.domain,
        // TODO-362: proto3 sends '' for an unset string — normalize so deriveDomain
        // is not handed an empty string.
        email: data.email || undefined,
        website: data.website || undefined,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return {
      candidates: r.candidates.map((c) => ({
        id: c.id,
        name: c.name,
        inn: c.inn,
        match_reason: c.matchReason,
        deleted: c.deleted,
      })),
    };
  }

  @GrpcMethod('CompanyGrpc', 'AggregateCompanies')
  async aggregate(
    data: { project_id?: string; projectId?: string; group_by: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.aggregate(
      projectId,
      data.group_by,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return { groups: r.groups };
  }

  @GrpcMethod('CompanyGrpc', 'PreviewMerge')
  async previewMerge(
    data: { project_id?: string; projectId?: string; master_id: string; loser_id: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.companies.previewMerge(
      projectId,
      data.master_id,
      data.loser_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return { field_conflicts: r.fieldConflicts };
  }

  @GrpcMethod('CompanyGrpc', 'MergeCompanies')
  async mergeCompanies(
    data: {
      project_id?: string;
      projectId?: string;
      master_id: string;
      loser_id: string;
      field_decisions?: { field: string; winner: string }[];
      actor_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // P2.d: dedup a retried merge — merge is destructive (loser is archived), so a
    // duplicate must NOT re-run; replay the first response instead.
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'merge',
      async () => {
        const r = await this.companies.mergeCompanies(
          projectId,
          data.master_id,
          data.loser_id,
          data.field_decisions ?? [],
          data.actor_id || readUserId(metadata) || undefined,
          readVisibilityScope(metadata),
          readAccessPredicate(metadata),
          emitCtx(metadata),
        );
        return {
          master_id: r.masterId,
          loser_id: r.loserId,
          archive_id: r.archiveId,
          merge_state: r.mergeState,
        };
      },
      (r) => r.master_id,
    );
  }

  @GrpcMethod('CompanyGrpc', 'RestoreMerge')
  async restoreMerge(
    data: { project_id?: string; projectId?: string; archive_id: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // TODO-286: revert is a write on both merge parties — same visibility scope and
    // ABAC predicate the read path uses, exactly like the Merge handler above.
    const r = await this.companies.restoreMerge(
      projectId,
      data.archive_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      emitCtx(metadata),
    );
    return { loser_id: r.loserId, master_id: r.masterId, restored: r.restored };
  }

  @GrpcMethod('CompanyGrpc', 'ImportCompanies')
  async importCompanies(
    data: {
      project_id?: string;
      projectId?: string;
      file_content: Buffer;
      mapping_json?: string;
      dedup_mode?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // Owner comes from the trusted caller, never a pseudo 'import' owner (no orphans, VAL-MCOM-4).
    const ownerId = readUserId(metadata) || undefined;
    // P2.d: dedup a retried import — the whole batch runs at-most-once, summary replayed.
    return this.idempotency.withIdempotency(projectId, readIdempotencyKey(metadata), 'import', () =>
      this.companies.importCompanies(
        projectId,
        data.file_content,
        data.mapping_json,
        data.dedup_mode,
        ownerId,
        // dedup='update' rewrites existing records — same visibility scope + ABAC
        // predicate as a manual update, so `companies:import` cannot reach a company
        // the importer may not read (write gate = read gate, TODO-012).
        readVisibilityScope(metadata),
        readAccessPredicate(metadata),
        emitCtx(metadata),
      ),
    );
  }

  @GrpcMethod('CompanyGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(d: { project_id?: string; user_id?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, d.project_id);
    const count = await this.companies.countOwnedRecords(projectId, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('CompanyGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id);
    const r = await this.companies.reassignOwnedRecords(
      projectId,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }
}
