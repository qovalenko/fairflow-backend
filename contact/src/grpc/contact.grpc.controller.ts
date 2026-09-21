import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ContactsService } from '../contacts/contacts.service';
import { parseCsv } from '../contacts/csv';
import { applyImportMapping, resolveImportMapping } from '../contacts/import-mapping';
import {
  assertImportRowLimit,
  assertImportFileSize,
  assertImportProjectQuota,
  looksLikeBinaryImport,
} from '../contacts/import-guard';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ReassignTargetValidator } from '../contacts/reassign-target.validator';
import { companyLinksFromProto, companyLinksToProto } from '../contacts/company-links';
import {
  RequireModule,
  RequireRoles,
  readVisibilityScope,
  readAccessPredicate,
  readUserId,
  readGatewayMetadata,
  readIdempotencyKey,
  resolveProjectId,
  resolveDocumentVariablesScope,
  type OutboxCausation,
  AppError,
} from '@fairflow/shared';

/** Hard upper bound on page size to cap query cost / response payload (#13). */
const MAX_PAGE_SIZE = 100;

/** Clamp a client-supplied page size into [1, MAX_PAGE_SIZE], default 25. */
function clampPageSize(size?: number): number {
  if (!size || size < 1) return 25;
  return Math.min(size, MAX_PAGE_SIZE);
}

/**
 * Actor/lineage context for event emits (RFC-4 §Р-1), read from gRPC metadata.
 * Метадата вкладывается целиком: домену иногда нужно переспросить control
 * (TODO-160, проверка нового владельца), а своего сервисного ключа у него нет.
 */
function readEmitCtx(metadata?: Metadata): {
  userId?: string;
  causation?: OutboxCausation;
  metadata?: Metadata;
} {
  const userId = readUserId(metadata) || undefined;
  const traceId = readGatewayMetadata(metadata, 'x-trace-id') || undefined;
  return { userId, causation: traceId ? { traceId } : undefined, metadata };
}

/**
 * Связь контакт↔компании — M2M (`company_ids`). `company_id` остаётся только как
 * фолбэк для старых клиентов; дубли и пустые значения отбрасываются.
 */
function normalizeCompanyIds(companyIds?: string[], companyId?: string): string[] {
  const raw = companyIds?.length ? companyIds : companyId ? [companyId] : [];
  return Array.from(new Set(raw.map((s) => (s ?? '').trim()).filter(Boolean)));
}

/**
 * TODO-161: тень слияния → proto MergedSource. Домен отдаёт camelCase, proto —
 * snake_case; без этого домапа поле молча терялось бы на границе (тот же класс
 * дефекта, что и потерянный middle_name).
 */
function toProtoMergedSource(s: Record<string, unknown>) {
  return {
    id: String(s.id ?? ''),
    first_name: String(s.firstName ?? ''),
    last_name: String(s.lastName ?? ''),
    middle_name: String(s.middleName ?? ''),
    email: String(s.email ?? ''),
    phone: String(s.phone ?? ''),
    merged_at: Number(s.mergedAt ?? 0),
    unmerge_until: Number(s.unmergeUntil ?? 0),
  };
}

function toProtoContact(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    project_id: String(row.projectId ?? row.project_id ?? ''),
    first_name: String(row.firstName ?? row.first_name ?? ''),
    last_name: String(row.lastName ?? row.last_name ?? ''),
    phone: String(row.phone ?? ''),
    email: String(row.email ?? ''),
    middle_name: String(row.middleName ?? row.middle_name ?? ''),
    position: String(row.position ?? ''),
    company_ids: (row.companyIds as string[]) ?? [],
    company_links: companyLinksToProto(
      row.companyLinks as import('../mongo/mongo.service').CompanyLink[] | undefined,
    ),
    source: String(row.source ?? ''),
    owner_id: String(row.ownerId ?? row.owner_id ?? ''),
    department_id: String(row.departmentId ?? row.department_id ?? ''),
    last_activity_at: Number(row.lastActivityAt ?? row.last_activity_at ?? 0),
    tags: (row.tags as string[]) ?? [],
    notes: String(row.notes ?? ''),
    orphaned_company_ids: (row.orphanedCompanyIds as string[]) ?? [],
    created_at: Number(row.createdAt ?? row.created_at ?? 0),
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0),
    deleted_at: Number(row.deletedAt ?? row.deleted_at ?? 0),
    purge_at: Number(row.purgeAt ?? row.purge_at ?? 0),
    merged_sources: (
      (row.mergedSources ?? row.merged_sources ?? []) as Record<string, unknown>[]
    ).map(toProtoMergedSource),
  };
}

@Controller()
@RequireModule('contacts')
export class ContactGrpcController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly idempotency: IdempotencyService,
    // TODO-160 (симметрия create/reassign). Значение по умолчанию — только чтобы не
    // переписывать конструкторы в контрактных тестах: без control-клиента валидатор
    // отказывает (fail-closed), а не пропускает.
    private readonly reassignTargets: ReassignTargetValidator = new ReassignTargetValidator(),
  ) {}

  @GrpcMethod('ContactGrpc', 'ListContacts')
  async listContacts(
    data: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      include_deleted?: boolean;
      source?: string;
      owner_id?: string;
      sort_by?: string;
      sort_dir?: string;
      filter_tags?: string;
      owner_scope?: string;
      inactive_days?: number;
      filter_company_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const pageIndex = data.page_index ?? 0;
    const pageSize = clampPageSize(data.page_size);
    const r = await this.contacts.list(
      projectId,
      pageIndex,
      pageSize,
      data.query,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      Boolean(data.include_deleted),
      // Серверные фильтры/сортировка: поля добавлены в ListContactsRequest и без
      // этого читателя ушли бы в никуда (gateway их уже шлёт).
      {
        source: data.source,
        ownerId: data.owner_id,
        ownerScope: data.owner_scope,
        inactiveDays: data.inactive_days,
        filterTags: data.filter_tags
          ? data.filter_tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
        sortBy: data.sort_by,
        sortDir: data.sort_dir,
        companyId: data.filter_company_id,
      },
    );
    return {
      list: r.list.map((x) => toProtoContact(x as Record<string, unknown>)),
      total: r.total,
      hidden_by_policy: r.hiddenByPolicy ?? 0,
    };
  }

  @GrpcMethod('ContactGrpc', 'ListTrash')
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
    const r = await this.contacts.listTrash(
      projectId,
      data.page_index ?? 0,
      clampPageSize(data.page_size),
      data.query,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return {
      list: r.list.map((x) => toProtoContact(x as Record<string, unknown>)),
      total: r.total,
    };
  }

  @GrpcMethod('ContactGrpc', 'GetContact')
  async getContact(
    data: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const row = await this.contacts.findOne(
      projectId,
      data.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return toProtoContact(row as Record<string, unknown>);
  }

  @GrpcMethod('ContactGrpc', 'CreateContact')
  async createContact(
    data: {
      project_id?: string;
      projectId?: string;
      first_name: string;
      last_name: string;
      phone?: string;
      email?: string;
      position?: string;
      company_id?: string;
      source?: string;
      assignee_id?: string;
      middle_name?: string;
      notes?: string;
      tags?: string[];
      company_ids?: string[];
      company_links?: Array<{
        company_id?: string;
        role?: string;
        is_primary?: boolean;
        position?: string;
        period?: { from?: number; to?: number };
      }>;
      force_create?: boolean;
      trash_collision_resolution?: string;
      department_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // Ownership: explicit assignee, else the creator — no orphan records (spec §13.2).
    const ctx = readEmitCtx(metadata);
    const requestedOwner = (data.assignee_id ?? '').trim();
    const ownerId = requestedOwner || ctx.userId;
    // TODO-160, вторая половина: до этого чужого владельца проверял только
    // ReassignContacts, а create принимал любой `assignee_id` под правом
    // contacts:write. Вред тот же и достигался более слабым правом: ownerId —
    // ключ видимости (buildVisibilityFilter по ownerId), поэтому контакт,
    // созданный на несуществующего/не-участника, сразу пропадает из выдачи у
    // всех, у кого режим own/unit, и вернуть его можно только руками.
    // Поле не убираем: форма создания честно даёт выбрать ответственного из
    // состава проекта — убрать его значило бы сломать рабочий сценарий; проверяем
    // тем же гейтом, что и переназначение. Себе владельцем — без похода в control
    // (актор уже прошёл проверку проекта на gateway), это же путь импорта.
    // Проверка ДО withIdempotency: отказ не должен занимать ключ идемпотентности.
    if (requestedOwner && requestedOwner !== ctx.userId) {
      await this.reassignTargets.assertOwnerAssignable(
        projectId,
        requestedOwner,
        metadata,
        'assigneeId',
        readVisibilityScope(metadata),
      );
    }
    // W-6: подразделение-владелец приходит из формы, значит проверяется тем же
    // гейтом, что и переназначение: departmentId — ключ видимости
    // (buildOwnableVisibilityFilter), и запись на несуществующее подразделение
    // пропала бы у всех, у кого режим не `all`. Пусто = поле не задано.
    const requestedDepartment = (data.department_id ?? '').trim();
    if (requestedDepartment) {
      await this.reassignTargets.assertDepartmentAssignable(
        projectId,
        requestedDepartment,
        metadata,
        'departmentId',
      );
    }
    // P2.d: dedup retried creates on `Idempotency-Key` — replay the first response.
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'create',
      async () => {
        const row = await this.contacts.create(
          projectId,
          {
            firstName: data.first_name,
            lastName: data.last_name,
            phone: data.phone,
            email: data.email,
            position: data.position,
            // M2M: company_ids канон, company_id — фолбэк для старых клиентов.
            companyIds: normalizeCompanyIds(data.company_ids, data.company_id),
            companyLinks: companyLinksFromProto(data.company_links),
            source: data.source,
            ownerId,
            ...(requestedDepartment ? { departmentId: requestedDepartment } : {}),
            // Поля карточки, которые модель хранила и отдавала, но записать их
            // было нечем — форма создания теряла их молча.
            middleName: data.middle_name,
            notes: data.notes,
            tags: data.tags?.length ? data.tags : undefined,
          },
          ctx,
          readVisibilityScope(metadata),
          readAccessPredicate(metadata),
          {
            forceCreate: Boolean(data.force_create),
            trashCollisionResolution: data.trash_collision_resolution,
          },
        );
        return toProtoContact(row as Record<string, unknown>);
      },
    );
  }

  @GrpcMethod('ContactGrpc', 'UpdateContact')
  async updateContact(
    data: {
      project_id?: string;
      projectId?: string;
      id: string;
      first_name?: string;
      last_name?: string;
      phone?: string;
      email?: string;
      position?: string;
      company_id?: string;
      source?: string;
      assignee_id?: string;
      middle_name?: string;
      notes?: string;
      tags?: string[];
      set_tags?: boolean;
      company_ids?: string[];
      set_company_ids?: boolean;
      company_links?: Array<{
        company_id?: string;
        role?: string;
        is_primary?: boolean;
        position?: string;
        period?: { from?: number; to?: number };
      }>;
      set_company_links?: boolean;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const row = await this.contacts.update(
      projectId,
      data.id,
      {
        firstName: data.first_name,
        lastName: data.last_name,
        phone: data.phone,
        email: data.email,
        position: data.position,
        // proto3 не отличает «не прислали» от «прислали пустой список», поэтому
        // очистка списков — только по явному флагу set_*; без флага пустой
        // repeated значит «не менять» (иначе частичный PUT стирал бы теги).
        companyIds: data.set_company_ids
          ? normalizeCompanyIds(data.company_ids, data.company_id)
          : undefined,
        companyLinks: data.set_company_links
          ? companyLinksFromProto(data.company_links)
          : undefined,
        tags: data.set_tags ? (data.tags ?? []) : undefined,
        middleName: data.middle_name,
        notes: data.notes,
        source: data.source,
        // ownerId intentionally omitted: service strips it; owner change only via ReassignContacts (S7).
      },
      readVisibilityScope(metadata),
      readEmitCtx(metadata),
      // TODO-073: гейт записи = гейт чтения — тот же ABAC-предикат, что в GetContact.
      readAccessPredicate(metadata),
    );
    return toProtoContact(row as Record<string, unknown>);
  }

  @GrpcMethod('ContactGrpc', 'DeleteContact')
  async deleteContact(
    data: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const scope = readVisibilityScope(metadata);
    const access = readAccessPredicate(metadata);
    const before = await this.contacts.findOne(projectId, data.id, scope, access);
    await this.contacts.remove(projectId, data.id, scope, readEmitCtx(metadata), access);
    return toProtoContact({ ...before, deletedAt: Date.now() } as Record<string, unknown>);
  }

  @GrpcMethod('ContactGrpc', 'RestoreContact')
  async restoreContact(
    data: { project_id?: string; projectId?: string; id: string; strategy?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // S4: pass scope so restore is visibility-gated (no IDOR revive).
    const row = await this.contacts.restore(
      projectId,
      data.id,
      data.strategy || undefined,
      readVisibilityScope(metadata),
      readEmitCtx(metadata),
      readAccessPredicate(metadata),
    );
    return toProtoContact(row as Record<string, unknown>);
  }

  @GrpcMethod('ContactGrpc', 'ImportContacts')
  async importContacts(
    data: {
      project_id?: string;
      projectId?: string;
      file_content: Buffer;
      filename?: string;
      mapping_json?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // P2.d: dedup a retried import (same file re-submitted with the same key) — the
    // whole batch runs at-most-once and the summary is replayed verbatim.
    return this.idempotency.withIdempotency(projectId, readIdempotencyKey(metadata), 'import', () =>
      this.runImport(projectId, data, metadata),
    );
  }

  private async runImport(
    projectId: string,
    data: { file_content: Buffer; filename?: string; mapping_json?: string },
    metadata?: Metadata,
  ) {
    // S9: imported records belong to the importing user, not a synthetic 'import' owner.
    const ctx = readEmitCtx(metadata);
    const ownerId = ctx.userId;
    const raw = data.file_content;
    assertImportFileSize(raw?.length ?? 0);
    if (looksLikeBinaryImport(raw)) {
      throw new AppError(
        'invalid',
        'Файл не является текстовым CSV (возможно, это Excel или другой бинарный формат)',
      );
    }
    const text = raw?.toString('utf8') ?? '';
    // TODO-164: RFC4180-разбор с автоопределением разделителя вместо
    // `split(/[,;]/)` — иначе поле в кавычках с запятой внутри («"Иванов, Иван"»)
    // сдвигало все последующие колонки и контакт создавался с мусором.
    const rows = parseCsv(text);
    const dataRowCount = Math.max(0, rows.length - 1);
    assertImportRowLimit(dataRowCount);
    const liveCount = await this.contacts.countLiveContacts(projectId);
    assertImportProjectQuota(liveCount, dataRowCount);
    // Карта колонок из мастера импорта; без неё — по заголовку, а если и он
    // непонятен — прежние фиксированные позиции.
    const mapping = resolveImportMapping(data.mapping_json, rows[0] ?? []);
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    const skippedRows: {
      row: number;
      reason: string;
      matched_contact_id: string;
      matched_field: string;
    }[] = [];
    const skip = (row: number, reason: string, matchedId = '', matchedField = '') => {
      skipped++;
      skippedRows.push({
        row,
        reason,
        matched_contact_id: matchedId,
        matched_field: matchedField,
      });
    };
    // Первая строка — заголовок (как и раньше), остальные — данные.
    for (let i = 1; i < rows.length; i++) {
      const rowNo = i + 1; // как видит пользователь в файле (заголовок — строка 1)
      const values = applyImportMapping(mapping, rows[i]);
      if (!values.firstName && !values.lastName) {
        skip(rowNo, 'missing_name');
        errors.push(`Строка ${rowNo}: не указано имя`);
        continue;
      }
      try {
        // Batch dedup against live records is TO-BE (agg lookup); skip exact live duplicates.
        if (values.email || values.phone) {
          const dup = await this.contacts.findDuplicates(
            projectId,
            { email: values.email, phone: values.phone },
            readVisibilityScope(metadata),
            readAccessPredicate(metadata),
          );
          if (dup.candidates.length > 0) {
            const c = dup.candidates[0];
            skip(rowNo, 'duplicate', c.contactId, c.matchedOn);
            continue;
          }
        }
        // Per-row create wraps its own outbox `crm.contact.created` (E3-01).
        await this.contacts.create(
          projectId,
          {
            firstName: values.firstName,
            lastName: values.lastName,
            middleName: values.middleName || undefined,
            phone: values.phone,
            email: values.email,
            position: values.position || undefined,
            source: values.source || undefined,
            notes: values.notes || undefined,
            tags: values.tags,
            ownerId,
          },
          ctx,
        );
        created++;
      } catch (e) {
        // TODO-159: строка без телефона и e-mail теперь отклоняется доменом —
        // считаем её пропущенной, а не «созданной с ошибкой».
        skip(rowNo, 'invalid');
        errors.push(`Строка ${rowNo}: ${(e as Error).message}`);
      }
    }
    // `updated` всегда 0: режима «обновлять найденный дубль» в контракте нет,
    // дубль пропускается. Поле отдаём, чтобы мастер импорта читал его без undefined.
    return { created, updated: 0, skipped, errors, skipped_rows: skippedRows };
  }

  @GrpcMethod('ContactGrpc', 'FindDuplicates')
  async findDuplicates(
    data: {
      project_id?: string;
      projectId?: string;
      email?: string;
      phone?: string;
      exclude_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.contacts.findDuplicates(
      projectId,
      { email: data.email, phone: data.phone, excludeId: data.exclude_id },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return {
      candidates: r.candidates.map((c) => ({
        contact_id: c.contactId,
        display_name: c.displayName,
        matched_on: c.matchedOn,
        masked_value: c.maskedValue,
        deleted: c.deleted,
      })),
      possible_external_duplicate: r.possibleExternalDuplicate,
    };
  }

  @GrpcMethod('ContactGrpc', 'ListDuplicateQueue')
  async listDuplicateQueue(
    data: { project_id?: string; projectId?: string; page_index?: number; page_size?: number },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const r = await this.contacts.listDuplicateQueue(
      projectId,
      data.page_index ?? 0,
      data.page_size ?? 25,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    const mapCand = (c: {
      contactId: string;
      displayName: string;
      matchedOn: string;
      maskedValue: string;
    }) => ({
      contact_id: c.contactId,
      display_name: c.displayName,
      matched_on: c.matchedOn,
      masked_value: c.maskedValue,
    });
    return {
      pairs: r.pairs.map((p) => ({
        left: mapCand(p.left),
        right: mapCand(p.right),
        matched_on: p.matchedOn,
      })),
      total: r.total,
    };
  }

  @GrpcMethod('ContactGrpc', 'MergeContacts')
  async mergeContacts(
    data: {
      project_id?: string;
      projectId?: string;
      source_id: string;
      target_id: string;
      survivor_fields?: { field: string; from: string }[];
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    // P2.d: dedup a retried merge — merge is destructive (source is consumed), so a
    // duplicate must NOT re-run; replay the first response instead.
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'merge',
      async () => {
        const row = await this.contacts.merge(
          projectId,
          data.source_id,
          data.target_id,
          data.survivor_fields ?? [],
          readVisibilityScope(metadata),
          readEmitCtx(metadata),
          readAccessPredicate(metadata),
        );
        return toProtoContact(row as Record<string, unknown>);
      },
    );
  }

  @GrpcMethod('ContactGrpc', 'UnmergeContact')
  async unmergeContact(
    data: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const row = await this.contacts.unmerge(
      projectId,
      data.id,
      readVisibilityScope(metadata),
      readEmitCtx(metadata),
      readAccessPredicate(metadata),
    );
    return toProtoContact(row as Record<string, unknown>);
  }

  @RequireRoles('manager')
  @GrpcMethod('ContactGrpc', 'ReassignContacts')
  async reassignContacts(
    data: {
      project_id?: string;
      projectId?: string;
      contact_ids: string[];
      new_owner_id?: string;
      new_department_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    return this.contacts.reassign(
      projectId,
      data.contact_ids ?? [],
      {
        newOwnerId: data.new_owner_id || undefined,
        newDepartmentId: data.new_department_id || undefined,
      },
      readVisibilityScope(metadata),
      readEmitCtx(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('ContactGrpc', 'ReassignContactsFromOwner')
  async reassignContactsFromOwner(
    data: {
      project_id?: string;
      projectId?: string;
      from_owner_id?: string;
      to_owner_id?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    return this.contacts.reassignFromOwner(
      projectId,
      data.from_owner_id ?? '',
      data.to_owner_id ?? '',
      readVisibilityScope(metadata),
      readEmitCtx(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ContactGrpc', 'GetContactQualityMetrics')
  async getContactQualityMetrics(
    data: { project_id?: string; projectId?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, data.project_id ?? data.projectId);
    const m = await this.contacts.getQualityMetrics(
      projectId,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
    return {
      total_contacts: m.totalContacts,
      filled_both_pct: m.filledBothPct,
      duplicate_candidate_pairs: m.duplicateCandidatePairs,
      open_drift_links: m.openDriftLinks,
    };
  }

  @GrpcMethod('ContactGrpc', 'ResolveDocumentVariables')
  async resolveDocumentVariables(
    data: { project_id?: string; projectId?: string; record_id?: string; recordId?: string },
    metadata?: Metadata,
  ) {
    // (1)+(2) project boundary from trusted metadata; conflicting body → PERMISSION_DENIED.
    const { projectId, recordId } = resolveDocumentVariablesScope(metadata, data);
    // (3) donor PEP: visibility scope applied inside the service (invisible → NOT_FOUND).
    return this.contacts.resolveDocumentVariables(
      projectId,
      recordId,
      readVisibilityScope(metadata),
    );
  }
  // TODO-074: GetContactFields удалён вместе с RPC в proto — читал произвольные
  // поля контакта (ПДн) без visibility/ABAC и без доказательства, что вызывающий
  // сервис, а не проксированный end-user. Потребителей не было.

  @GrpcMethod('ContactGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(d: { project_id?: string; user_id?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, d.project_id);
    const count = await this.contacts.countOwnedRecords(projectId, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('ContactGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id);
    const r = await this.contacts.reassignOwnedRecords(
      projectId,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }
}
