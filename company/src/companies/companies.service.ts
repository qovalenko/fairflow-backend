import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  buildVisibilityFilter,
  buildDocumentVariablesResponse,
  computeHiddenByPolicy,
  isRecordVisible,
  evalGate,
  type AbacNode,
  type AccessPredicate,
  type DocumentVariablesResult,
  type EmitIntent,
  type OutboxCausation,
  type VisibilityScope,
} from '@fairflow/shared';
import { parseCsv, looksLikeHeaderRow } from './csv-import';
import { MongoService, CompanyDoc } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { AppError } from '@fairflow/shared';

/** Actor/causation context threaded from the gRPC controller for event lineage (RFC-4 §Р-1). */
export interface EmitContext {
  userId?: string;
  causation?: OutboxCausation;
}

export interface CompanyCreateOptions {
  trashCollisionResolution?: string;
  forceCreate?: boolean;
}

/**
 * Required document variables the company context always ships (documents §3.9
 * manifest: `company.name`, `company.inn`). Blank → `warnings.emptyRequired`.
 */
export const COMPANY_REQUIRED_VARIABLES = ['company.name', 'company.inn'];

/**
 * Map a company record (toResponse shape) to the flat document-variable map
 * (documents contract §4). Pure/no-IO so it is unit-testable in isolation. Keys
 * follow the `company.*` manifest namespace consumed by DOCX templates.
 */
export function buildCompanyDocumentVariables(
  row: Record<string, unknown>,
): DocumentVariablesResult {
  return buildDocumentVariablesResponse(
    {
      'company.name': String(row.name ?? ''),
      'company.inn': String(row.inn ?? ''),
      'company.kpp': String(row.kpp ?? ''),
      'company.ogrn': String(row.ogrn ?? ''),
      'company.legalAddress': String(row.legalAddress ?? ''),
      'company.phone': String(row.phone ?? ''),
      'company.email': String(row.email ?? ''),
      'company.website': String(row.website ?? ''),
      'company.industry': String(row.industry ?? ''),
      'company.region': String(row.region ?? ''),
    },
    COMPANY_REQUIRED_VARIABLES,
  );
}

type CompanyDocWithId = CompanyDoc & { _id: ObjectId };

const OWNER_FIELD = 'ownerId';
const DEPARTMENT_FIELD = 'departmentId';
const STATUS_VALUES = ['lead', 'client', 'partner', 'former'];
const DEFAULT_STATUS = 'lead';
const AGGREGATE_GROUP_FIELDS: Record<string, string> = {
  ownerId: 'ownerId',
  departmentId: 'departmentId',
  industry: 'industry',
  region: 'region',
  status: 'status',
};
const MERGE_SHADOW_DAYS = 30;
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** digits-only normalization of an INN (company.md §3.6). */
function normalizeInn(inn?: string): string | undefined {
  if (!inn) return undefined;
  const digits = inn.replace(/\D+/g, '');
  return digits || undefined;
}

/** Derive the bare domain from an email/website for dedup (company.md §1). */
function deriveDomain(email?: string, website?: string): string | undefined {
  if (website) {
    const m = website
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase()
      .trim();
    if (m) return m;
  }
  if (email && email.includes('@')) {
    const d = email.split('@')[1]?.toLowerCase().trim();
    if (d) return d;
  }
  return undefined;
}

/** Mongo duplicate-key (E11000) — plain insert or inside a transaction. */
function isMongoDuplicateKey(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; message?: string };
  return e.code === 11000 || (typeof e.message === 'string' && e.message.includes('E11000'));
}

/**
 * Per-row import error text safe for the UI: no raw Mongo internals, no index names.
 * AppError messages are already user-facing; everything else is mapped.
 */
function formatImportRowError(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (isMongoDuplicateKey(err)) return 'Компания с такими реквизитами уже существует';
  return 'Не удалось обработать строку';
}

/** Stable identity hash from project + inn|domain|name (company.md §3.6, FR-MCOM-3). */
function computeIdentityHash(
  projectId: string,
  inn?: string,
  domain?: string,
  name?: string,
): string | undefined {
  const key = inn || domain || (name ? name.toLowerCase().trim() : '');
  if (!key) return undefined;
  return createHash('sha256').update(`${projectId}:${key}`).digest('hex');
}

/**
 * Fields a CSV column may fill on import (company.md §3.17). Deliberately business
 * data only: `ownerId`/`departmentId`/`createdBy`/`source`/`status`/`identityHash`/
 * `projectId`/`deletedAt` are set by the server from the trusted caller, because
 * `departmentId`/`ownerId` participate in ABAC narrowing and `createdBy` is the audit
 * attribution. Mirrors the gateway allowlist (`normalizeImportMapping`) — the domain
 * must not depend on the edge having filtered.
 */
const IMPORT_MAPPABLE_FIELDS = new Set<string>([
  'name',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'phone',
  'email',
  'website',
  'industry',
  'region',
  'notes',
  'tags',
]);

/** `tags` is an array in the document — a single CSV cell carries them `|`-separated. */
function splitImportTags(cell: string): string[] {
  return cell
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Escape user input before using it inside a RegExp (avoids ReDoS / injection, company.md §3.1). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
  ) {}

  /** Build a `crm.company.*` emit intent with the canonical envelope context (RFC-4 §Р-1). */
  private emitIntent<T>(
    type: string,
    projectId: string,
    companyId: string,
    payload: T,
    idempotencyKey: string,
    ctx?: EmitContext,
  ): EmitIntent<T> {
    return {
      type,
      source: 'company',
      projectId,
      subject: `company/${companyId}`,
      idempotencyKey,
      userId: ctx?.userId,
      actorType: ctx?.userId ? 'user' : 'service',
      causation: ctx?.causation,
      payload,
    };
  }

  /** Record ids shared with the viewer (resolved upstream), as ObjectIds. */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  private toResponse(doc: CompanyDocWithId) {
    // identityHash is a service field — never exposed outward (VAL-MCOM-6).
    const { _id, deletedAt, purgeAt, identityHash: _hash, ...rest } = doc;
    return {
      id: _id.toString(),
      ...rest,
      deletedAt: deletedAt ? deletedAt.getTime() : null,
      purgeAt: purgeAt ? purgeAt.getTime() : null,
      createdAt: (rest.createdAt as Date).getTime(),
      updatedAt: (rest.updatedAt as Date).getTime(),
    };
  }

  /**
   * A malformed `x-access-predicate` is a broken deny-rule → the whole read must be
   * denied, never silently widened (RFC-ABAC §4 fail-closed). DENY_ALL_ID never
   * matches a real ObjectId, so ANDing it turns the read into "matches nothing"
   * (empty list / NOT_FOUND) without leaking existence.
   */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Compose the read filter `{ projectId } AND visibility AND abac` (RFC-5 §1.4,
   * product reference). `access` is the three-state gateway predicate:
   *  - absent (`present:false`)     → no ABAC narrowing (projectId + visibility only);
   *  - malformed (`malformed:true`) → fail-closed: force a filter that matches nothing;
   *  - present with `.mongo`        → AND the compiled fragment in.
   */
  private scopedFilter(
    projectId: string,
    scope: VisibilityScope | undefined,
    extra: Record<string, unknown>[] = [],
    access?: AccessPredicate,
  ): Record<string, unknown> {
    if (access?.present && access.malformed) {
      return { $and: [{ projectId }, { _id: CompaniesService.DENY_ALL_ID }] };
    }
    const and: Record<string, unknown>[] = [{ projectId }, ...extra];
    const vis = buildVisibilityFilter<ObjectId>(
      scope,
      OWNER_FIELD,
      this.sharedObjectIds(scope),
      DEPARTMENT_FIELD,
    );
    if (vis) and.push(vis);
    if (access?.present && !access.malformed && access.mongo && Object.keys(access.mongo).length) {
      and.push(access.mongo);
    }
    return and.length === 1 ? and[0] : { $and: and };
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

  async create(
    projectId: string,
    data: Partial<CompanyDoc>,
    ctx?: EmitContext,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    opts?: CompanyCreateOptions,
  ) {
    if (!data.name || !data.name.trim()) {
      throw new AppError('invalid', 'Название обязательно', { field: 'name' });
    }
    const inn = normalizeInn(data.inn);
    const domain = data.domain ?? deriveDomain(data.email, data.website);
    const resolution = (opts?.trashCollisionResolution ?? '').trim().toLowerCase();
    const trashHit = await this.findTrashByIdentity(
      projectId,
      { inn, domain, name: data.name, email: data.email, website: data.website },
      scope,
      access,
    );
    if (trashHit && !opts?.forceCreate && resolution !== 'create_new') {
      if (resolution === 'restore') {
        return this.restore(projectId, trashHit.id, undefined, scope, access, ctx);
      }
      let matchedOn = 'name';
      if (inn && trashHit.inn === inn) matchedOn = 'inn';
      else if (domain && trashHit.domain === domain) matchedOn = 'domain';
      throw new AppError('conflict', 'Компания с такими реквизитами в корзине. Восстановить?', {
        code: 'TRASH_COLLISION',
        trashedId: trashHit.id,
        matchedOn,
        options: ['restore', 'create_new'],
      });
    }

    const coll = await this.mongo.companies();
    const now = new Date();
    const identityHash = computeIdentityHash(projectId, inn, domain, data.name);

    // Hard collision with a live duplicate → 409 with the existing id (company.md §3.6).
    if (identityHash) {
      const live = await coll.findOne({ projectId, identityHash, deletedAt: null });
      if (live) {
        throw new AppError('locked', 'Компания с такими реквизитами уже существует', {
          existingId: (live as CompanyDocWithId)._id.toString(),
          matchReason: 'identityHash',
        });
      }
    }

    const doc: Omit<CompanyDoc, '_id'> = {
      projectId,
      name: data.name.trim(),
      inn,
      kpp: data.kpp,
      legalAddress: data.legalAddress,
      phone: data.phone,
      email: data.email,
      industry: data.industry,
      ownerId: data.ownerId,
      tags: data.tags,
      notes: data.notes,
      ogrn: data.ogrn,
      website: data.website,
      domain,
      status: data.status && STATUS_VALUES.includes(data.status) ? data.status : DEFAULT_STATUS,
      departmentId: data.departmentId,
      region: data.region,
      source: data.source ?? 'manual',
      bankName: data.bankName,
      bik: data.bik,
      correspondentAccount: data.correspondentAccount,
      settlementAccount: data.settlementAccount,
      cardContactsRev: 0,
      identityHash,
      mergeState: null,
      createdBy: data.createdBy,
      updatedBy: data.createdBy,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // E3-01 transactional outbox: business write + `crm.company.created` row in
    // one Mongo session — no company without an event, no event without a company.
    let inserted: import('mongodb').WithId<CompanyDoc> | null;
    try {
      inserted = await this.outbox.withOutbox(async (session) => {
        const res = await coll.insertOne(doc as CompanyDoc, session ? { session } : {});
        const created = await coll.findOne(
          { _id: res.insertedId } as unknown as import('mongodb').Filter<CompanyDoc>,
          session ? { session } : {},
        );
        const companyId = res.insertedId.toString();
        const intents: EmitIntent[] = [
          this.emitIntent(
            'crm.company.created',
            projectId,
            companyId,
            {
              companyId,
              name: doc.name,
              ownerId: doc.ownerId,
              source: doc.source,
              departmentId: doc.departmentId ?? null,
            },
            `company.created:${companyId}`,
            ctx,
          ),
        ];
        return { result: created, intents };
      });
    } catch (err) {
      // Partial-unique index now hard-enforces per-project identity dedup;
      // translate a lost check-then-insert race (E11000) into the same 409-style
      // domain error the pre-check raises.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('locked', 'Компания с такими реквизитами уже существует', {
          matchReason: 'identityHash',
        });
      }
      throw err;
    }
    return inserted ? this.toResponse(inserted as CompanyDocWithId) : null;
  }

  async findOne(projectId: string, id: string, scope?: VisibilityScope, access?: AccessPredicate) {
    if (!ObjectId.isValid(id)) throw new AppError('notFound', 'Company not found');
    const coll = await this.mongo.companies();
    // scopedFilter AND-s the abac `.mongo` fragment (and denies on malformed).
    const filter = this.scopedFilter(
      projectId,
      scope,
      [{ _id: new ObjectId(id) as unknown as CompanyDoc['_id'] }, { deletedAt: null }],
      access,
    );
    const doc = await coll.findOne(filter as never);
    if (!doc) throw new AppError('notFound', 'Company not found');
    // Hide records the viewer may not see (same 404 as a missing record).
    if (
      !isRecordVisible(
        scope,
        doc.ownerId,
        scope?.sharedRecordIds.includes(id) ?? false,
        doc.departmentId,
      )
    ) {
      throw new AppError('notFound', 'Company not found');
    }
    // Re-check with the single-record evalGate gate so get is exactly the contract
    // pair of the list filter (RFC-ABAC §4). Failing the gate is NOT_FOUND, never leak.
    if (!this.passesAccessGate(doc as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Company not found');
    }
    return this.toResponse(doc as CompanyDocWithId);
  }

  /**
   * Document variable provider (documents contract §4). Reads the company scoped
   * to `projectId` AND the caller's visibility AND the gateway ABAC predicate
   * (`findOne` masks a cross-project, invisible or predicate-failing record as
   * NOT_FOUND; a malformed predicate is fail-closed). The donor must not be a
   * side door around ABAC — same gate as GetCompany (TODO-073).
   * Returns the flat `company.*` variable map.
   */
  async resolveDocumentVariables(
    projectId: string,
    recordId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<DocumentVariablesResult> {
    const row = await this.findOne(projectId, recordId, scope, access);
    return buildCompanyDocumentVariables(row as Record<string, unknown>);
  }

  async list(
    projectId: string,
    opts: {
      pageIndex?: number;
      pageSize?: number;
      query?: string;
      filterOwnerId?: string;
      filterDepartmentId?: string;
      filterStatus?: string;
      filterIndustry?: string;
      filterRegion?: string;
      filterTags?: string[];
      sortBy?: string;
      sortDir?: string;
      includeDeleted?: boolean;
    } = {},
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const coll = await this.mongo.companies();
    const pageIndex = opts.pageIndex ?? 0;
    const pageSize = Math.min(opts.pageSize ?? 25, 100);
    const extra: Record<string, unknown>[] = [
      { deletedAt: opts.includeDeleted ? { $ne: null } : null },
    ];
    if (opts.query?.trim()) {
      const rx = new RegExp(escapeRegExp(opts.query.trim()), 'i');
      extra.push({ $or: [{ name: rx }, { email: rx }, { inn: rx }] });
    }
    if (opts.filterOwnerId) extra.push({ ownerId: opts.filterOwnerId });
    if (opts.filterDepartmentId) extra.push({ departmentId: opts.filterDepartmentId });
    if (opts.filterStatus) extra.push({ status: opts.filterStatus });
    if (opts.filterIndustry) extra.push({ industry: opts.filterIndustry });
    if (opts.filterRegion) extra.push({ region: opts.filterRegion });
    if (opts.filterTags?.length) extra.push({ tags: { $all: opts.filterTags } });

    const filter = this.scopedFilter(projectId, scope, extra, access);
    const sortField = ['updatedAt', 'name', 'createdAt'].includes(opts.sortBy ?? '')
      ? (opts.sortBy as string)
      : 'updatedAt';
    const sortDir = opts.sortDir === 'asc' ? 1 : -1;

    const total = await coll.countDocuments(filter);
    let hiddenByPolicy = 0;
    const restricts =
      scope?.mode !== 'all' ||
      (access?.present &&
        (access.malformed || (access.mongo && Object.keys(access.mongo).length > 0)));
    if (restricts) {
      const baseParts: Record<string, unknown>[] = [{ projectId }, ...extra];
      const projectFilter = baseParts.length === 1 ? baseParts[0] : { $and: baseParts };
      const projectTotal = await coll.countDocuments(projectFilter);
      hiddenByPolicy = computeHiddenByPolicy(total, projectTotal);
    }
    // `_id` as the tie-breaker makes the sort a TOTAL order: skip/limit paging is only
    // stable if no two rows compare equal. Rows with identical `updatedAt` are the norm
    // after a CSV import or a bulk edit, and Mongo gives no order guarantee between them,
    // so without the tie-breaker the same record can appear on two consecutive pages (or
    // on none) — the export loop in the gateway BFF walks up to 100 pages and would then
    // silently duplicate/drop rows without tripping X-Export-Truncated.
    // Direction follows `sortDir` (not a fixed `1`) so the sort still matches the
    // `{ projectId, deletedAt, updatedAt, _id }` index suffix (or its exact inverse) and
    // stays a non-blocking indexed sort. `listTrash` delegates here, so it is covered too.
    const list = await coll
      .find(filter)
      .skip(pageIndex * pageSize)
      .limit(pageSize)
      .sort({ [sortField]: sortDir, _id: sortDir })
      .toArray();
    return {
      list: list.map((d) => this.toResponse(d as CompanyDocWithId)),
      total,
      hiddenByPolicy,
    };
  }

  async listTrash(
    projectId: string,
    pageIndex = 0,
    pageSize = 25,
    query?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    // Same visibility filter as list — trash must not be an alternate read path (company.md §3.10).
    return this.list(
      projectId,
      { pageIndex, pageSize, query, includeDeleted: true },
      scope,
      access,
    );
  }

  async update(
    projectId: string,
    id: string,
    data: Partial<CompanyDoc>,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    // Write gate = the read gate (scopedFilter + evalGate inside findOne): a record the
    // ABAC predicate hides on read must be NOT_FOUND on update too (fail-closed, TODO-012).
    const before = await this.findOne(projectId, id, scope, access);
    const coll = await this.mongo.companies();
    const update: Partial<CompanyDoc> = { updatedAt: new Date(), ...data };
    if (typeof update.name === 'string') {
      if (!update.name.trim()) {
        throw new AppError('invalid', 'Название обязательно', { field: 'name' });
      }
      update.name = update.name.trim();
    }
    if (typeof update.inn === 'string') update.inn = normalizeInn(update.inn);
    if (update.status && !STATUS_VALUES.includes(update.status)) {
      delete (update as Record<string, unknown>).status;
    }
    delete (update as Record<string, unknown>)._id;
    delete (update as Record<string, unknown>).projectId;
    delete (update as Record<string, unknown>).createdAt;
    delete (update as Record<string, unknown>).identityHash;

    // Recompute identityHash when inn/domain/name change (FR-MCOM-3).
    const nextInn = (update.inn as string) ?? before.inn;
    const nextDomain =
      (update.domain as string) ??
      deriveDomain(
        (update.email as string) ?? before.email,
        (update.website as string) ?? (before as { website?: string }).website,
      );
    const nextName = (update.name as string) ?? before.name;
    update.identityHash = computeIdentityHash(projectId, nextInn, nextDomain, nextName);
    update.domain = nextDomain;

    // Field-level diff for `crm.company.updated` (RFC-4; enough for consumer drift).
    // Compare applied business fields against the before-snapshot; skip service fields.
    const SERVICE_FIELDS = new Set(['updatedAt', 'identityHash', 'domain', 'updatedBy']);
    const beforeRec = before as unknown as Record<string, unknown>;
    const changedFields: { field: string; old: unknown; new: unknown }[] = [];
    for (const [field, next] of Object.entries(update as Record<string, unknown>)) {
      if (SERVICE_FIELDS.has(field)) continue;
      const prev = beforeRec[field];
      if (prev !== next) changedFields.push({ field, old: prev ?? null, new: next ?? null });
    }

    // E3-01 transactional outbox: business update + `crm.company.updated` row in one session.
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: new ObjectId(id) as unknown as CompanyDoc['_id'], projectId },
          { $set: update },
          session ? { session } : {},
        );
        const intents: EmitIntent[] = changedFields.length
          ? [
              this.emitIntent(
                'crm.company.updated',
                projectId,
                id,
                { companyId: id, changedFields, userId: ctx?.userId },
                // Idempotency keyed on the new updatedAt (each distinct write is a distinct event).
                `company.updated:${id}:${(update.updatedAt as Date).getTime()}`,
                ctx,
              ),
            ]
          : [];
        return { result: undefined, intents };
      });
    } catch (err) {
      // Editing inn/domain/name into an existing live identity trips the
      // partial-unique index — surface a clean 409 instead of a raw E11000.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('locked', 'Компания с такими реквизитами уже существует', {
          matchReason: 'identityHash',
        });
      }
      throw err;
    }
    return this.findOne(projectId, id, scope, access);
  }

  /** Owner reassignment (company.md §3.8). gateway PDP validates target membership/department. */
  async updateOwner(
    projectId: string,
    id: string,
    ownerId: string,
    departmentId: string | undefined,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    if (!ownerId || !ownerId.trim()) {
      throw new AppError('invalid', 'ownerId обязателен', { field: 'ownerId' });
    }
    const patch: Partial<CompanyDoc> = { ownerId };
    if (departmentId) patch.departmentId = departmentId;
    // Reuses update() → emits `crm.company.updated` with changedFields ⊇ ownerId (RFC-4 §3.8).
    return this.update(projectId, id, patch, scope, access, ctx);
  }

  async remove(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    // Same ABAC write gate as update: invisible-by-predicate → NOT_FOUND (TODO-012).
    await this.findOne(projectId, id, scope, access);
    const coll = await this.mongo.companies();
    const now = new Date();
    const purgeAt = new Date(now.getTime() + TRASH_TTL_MS);
    // E3-01 transactional outbox: soft-delete + `crm.company.deleted` row in one session
    // (contact/audit/search re-stitch/index on this event, RFC-4 §3.1).
    await this.outbox.withOutbox(async (session) => {
      await coll.updateOne(
        { _id: new ObjectId(id) as unknown as CompanyDoc['_id'], projectId },
        // Drop identityHash so the tombstone leaves the partial-unique index and
        // the same identity can be re-created; restore recomputes it from stored
        // inn/domain/name.
        { $set: { deletedAt: now, updatedAt: now, purgeAt }, $unset: { identityHash: '' } },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        this.emitIntent(
          'crm.company.deleted',
          projectId,
          id,
          { companyId: id },
          `company.deleted:${id}`,
          ctx,
        ),
      ];
      return { result: undefined, intents };
    });
    const doc = await coll.findOne({
      _id: new ObjectId(id) as unknown as CompanyDoc['_id'],
      projectId,
    });
    return doc ? this.toResponse(doc as CompanyDocWithId) : null;
  }

  /**
   * Hard-delete a record that is ALREADY IN THE TRASH — «удалить навсегда»
   * (FR-COMPANIES-040, TODO-157). `remove()` only soft-deletes and starts with
   * `findOne(... deletedAt: null)`, so it can never empty the trash: on an already
   * deleted row it answers NOT_FOUND. This is the missing terminal step.
   *
   * Invariants:
   *  - write gate = read gate (TODO-012): the caller must pass the very same
   *    visibility scope + ABAC predicate a plain GET applies. The target is
   *    soft-deleted by definition, hence the deletedAt-agnostic loader
   *    ({@link loadGatedAnyState}, the TODO-286 pattern) — `findOne` would
   *    filter it out and turn every purge into a spurious NOT_FOUND;
   *  - a LIVE record is refused (409). Purge is the trash-emptying operation, not
   *    an alternate delete: allowing it on a live row would let `force=true` skip
   *    the soft-delete safety net in a single call;
   *  - merge shadow copies referencing the record are dropped in the same session.
   *    A surviving `company_archives` row would let {@link restoreMerge} resurrect
   *    a physically deleted company (or roll a master back onto a dead loser).
   *
   * KNOWN GAP (out of this domain's reach): `companyId` back-references held by
   * contact / deal / order / activity are NOT rewritten here — a purge leaves
   * them dangling, where they render as an empty company chip rather than
   * resurrect data. Unlike `crm.company.merged` (whose consumers re-stitch onto
   * the master, see {@link MergeReconcileService}) there is no target to
   * re-point at, so the decision belongs to those domains: null the reference or
   * keep the historical id. `crm.company.purged` is on the bus for them to
   * consume when that call is made.
   */
  async purge(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ): Promise<{ id: string; purged: boolean }> {
    const doc = await this.loadGatedAnyState(projectId, id, scope, access);
    if (!doc) throw new AppError('notFound', 'Company not found');
    if (!doc.deletedAt) {
      throw new AppError('conflict', 'Компания не в корзине — сначала удалите её', { id });
    }
    const coll = await this.mongo.companies();
    const archives = await this.mongo.companyArchives();
    // E3-01 transactional outbox: physical delete + archive cleanup + a
    // `crm.company.purged` row in one session (canon §events). Consumers of that
    // fact: audit chains it via `crm.#`, and the search projection ERASES the
    // index row (search-projection.service.ts ROUTING_KEYS →
    // ProjectionApply.isPurge → SearchService.indexPurge). The erase is not
    // optional bookkeeping: `crm.company.deleted` only tombstones the row and
    // deliberately keeps `title`/`subtitle` (ИНН · e-mail)/`tokens` so a restore
    // can undo it, so without the purge consumer the operation whose whole point
    // is irreversible erasure (FR-COMPANIES-040, 152-ФЗ) would leave the
    // company's PII in `search_index` forever.
    await this.outbox.withOutbox(async (session) => {
      await coll.deleteOne(
        { _id: new ObjectId(id) as unknown as CompanyDoc['_id'], projectId },
        session ? { session } : {},
      );
      await archives.deleteMany(
        { projectId, $or: [{ originalId: id }, { masterId: id }] } as never,
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        this.emitIntent(
          'crm.company.purged',
          projectId,
          id,
          { companyId: id },
          `company.purged:${id}`,
          ctx,
        ),
      ];
      return { result: undefined, intents };
    });
    return { id, purged: true };
  }

  /**
   * Restore from trash (company.md §3.11). Checks visibility before restoring, and resolves
   * a live identityHash collision via strategy instead of throwing E11000.
   */
  async restore(
    projectId: string,
    id: string,
    strategy?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    if (!ObjectId.isValid(id)) throw new AppError('notFound', 'Company not found');
    const coll = await this.mongo.companies();
    // scopedFilter AND-s the abac `.mongo` fragment and denies on malformed (TODO-012);
    // trash must not be an alternate write path around the predicate.
    const filter = this.scopedFilter(
      projectId,
      scope,
      [{ _id: new ObjectId(id) as unknown as CompanyDoc['_id'] }, { deletedAt: { $ne: null } }],
      access,
    );
    const doc = (await coll.findOne(filter as never)) as CompanyDocWithId | null;
    if (!doc) throw new AppError('notFound', 'Company not found');
    // Visibility gate before restoring (company.md §3.11 — restore→read).
    if (
      !isRecordVisible(
        scope,
        doc.ownerId,
        scope?.sharedRecordIds.includes(id) ?? false,
        doc.departmentId,
      )
    ) {
      throw new AppError('notFound', 'Company not found');
    }
    // Single-record ABAC gate — the contract pair of the filter (loadForMerge pattern).
    if (!this.passesAccessGate(doc as unknown as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Company not found');
    }

    const update: Partial<CompanyDoc> = { deletedAt: null, updatedAt: new Date() };
    const restoreUnset: Record<string, ''> = { purgeAt: '' };
    // identityHash was $unset on soft-delete to free the partial-unique key;
    // recompute it from the stored inn/domain/name so the restored row re-enters
    // the index and duplicate detection still works.
    const restoredHash = computeIdentityHash(
      projectId,
      normalizeInn(doc.inn),
      doc.domain ?? deriveDomain(doc.email, doc.website),
      doc.name,
    );
    if (restoredHash) update.identityHash = restoredHash;
    if (restoredHash) {
      const conflict = (await coll.findOne({
        projectId,
        identityHash: restoredHash,
        deletedAt: null,
      })) as CompanyDocWithId | null;
      if (conflict) {
        if (!strategy) {
          throw new AppError('locked', 'Есть активный дубль по ключу — выберите действие', {
            conflictId: conflict._id.toString(),
            options: ['merge', 'clear_key', 'as_new'],
          });
        }
        if (strategy === 'clear_key' || strategy === 'as_new') {
          // Drop the colliding identity so the record can live alongside the active duplicate.
          update.identityHash = undefined;
        } else if (strategy === 'merge') {
          // Merge the trashed record into the live one instead of restoring it standalone.
          await this.mergeCompanies(
            projectId,
            conflict._id.toString(),
            id,
            [],
            ctx?.userId,
            scope,
            access,
            ctx,
          );
          return this.findOne(projectId, conflict._id.toString(), scope, access);
        } else {
          throw new AppError('invalid', 'Неизвестная стратегия', { field: 'strategy' });
        }
      }
    }

    // E3-01 transactional outbox: restore + a `crm.company.restored` row in one session.
    // The un-delete transition has its own registered key (RFC-4 §Р-3, be-event-keys-rfc4)
    // so audit reads it as a restore fact and search re-indexes the revived row.
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: new ObjectId(id) as unknown as CompanyDoc['_id'], projectId },
          update.identityHash === undefined
            ? {
                $set: { deletedAt: null, updatedAt: update.updatedAt },
                $unset: { identityHash: '', ...restoreUnset },
              }
            : { $set: update, $unset: restoreUnset },
          session ? { session } : {},
        );
        const intents: EmitIntent[] = [
          this.emitIntent(
            'crm.company.restored',
            projectId,
            id,
            {
              companyId: id,
              changedFields: [
                { field: 'deletedAt', old: doc.deletedAt?.getTime() ?? null, new: null },
              ],
              userId: ctx?.userId,
              reason: 'restored',
            },
            `company.restored:${id}:${(update.updatedAt as Date).getTime()}`,
            ctx,
          ),
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      // A live duplicate raced in between the conflict check and the write.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('locked', 'Есть активный дубль по ключу — выберите действие', {
          options: ['merge', 'clear_key', 'as_new'],
        });
      }
      throw err;
    }
    return this.findOne(projectId, id, scope, access);
  }

  /** Dedup hint, strictly project-scoped (company.md §3.12, FR-MCOM-4). */
  async findDuplicates(
    projectId: string,
    args: { inn?: string; name?: string; domain?: string; email?: string; website?: string },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const inn = normalizeInn(args.inn);
    // TODO-362: the else-branch used to be `deriveDomain(undefined, undefined)` — dead
    // code that always yielded undefined. The form fields the user actually fills are
    // email/website, so derive the domain from them when it is not passed explicitly
    // (same derivation create()/update() use to build the identity hash).
    const domain = args.domain
      ? args.domain.toLowerCase().trim()
      : deriveDomain(args.email, args.website);
    const name = args.name?.trim();
    if (!inn && !domain && !name) {
      throw new AppError('invalid', 'Передайте хотя бы один из inn/name/domain', {
        field: 'inn|name|domain',
      });
    }
    const coll = await this.mongo.companies();
    const or: Record<string, unknown>[] = [];
    if (inn) or.push({ inn });
    if (domain) or.push({ domain });
    if (name) or.push({ name: new RegExp(escapeRegExp(name), 'i') });
    // TODO-362: soft-deleted records stay in the hint (flagged `deleted`). NOT because
    // of the identity key — `remove()` $unsets identityHash (see above), so a trashed
    // duplicate can never produce a 409 on save. The reason is the opposite one: with
    // the trash hidden the user simply re-creates a company that is already in the
    // system, and their own record stays buried. Flagged candidates let the UI offer
    // «restore» instead of a third copy; the flag MUST reach the client (the UI also
    // excludes them from merge targets — `loadForMerge` only reads live rows).
    // Merge losers (mergeState pending|settled) are excluded: they are not a record
    // anyone can restore from here.
    const filter = this.scopedFilter(
      projectId,
      scope,
      [{ mergeState: { $nin: ['pending', 'settled'] } }, { $or: or }],
      access,
    );
    const docs = (await coll
      .find(filter)
      .sort({ deletedAt: 1 }) // live rows (deletedAt: null) before trashed ones
      .limit(20)
      .toArray()) as CompanyDocWithId[];
    const candidates = docs.map((d) => {
      let matchReason: string = 'name';
      if (inn && d.inn === inn) matchReason = 'inn';
      else if (domain && d.domain === domain) matchReason = 'domain';
      return {
        id: d._id.toString(),
        name: d.name,
        inn: d.inn ?? '',
        matchReason,
        deleted: d.deletedAt != null,
      };
    });
    return { candidates };
  }

  /** Trashed duplicate by inn/domain/name for create-path restore offer (FR-COMPANIES-100). */
  private async findTrashByIdentity(
    projectId: string,
    args: { inn?: string; domain?: string; name?: string; email?: string; website?: string },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<{ id: string; inn?: string; domain?: string; name: string } | null> {
    const inn = normalizeInn(args.inn);
    const domain = args.domain ?? deriveDomain(args.email, args.website);
    const name = args.name?.trim();
    if (!inn && !domain && !name) return null;
    const or: Record<string, unknown>[] = [];
    if (inn) or.push({ inn });
    if (domain) or.push({ domain });
    if (name) or.push({ name: new RegExp(`^${escapeRegExp(name)}$`, 'i') });
    const filter = this.scopedFilter(
      projectId,
      scope,
      [{ deletedAt: { $ne: null } }, { mergeState: { $nin: ['pending', 'settled'] } }, { $or: or }],
      access,
    );
    const coll = await this.mongo.companies();
    const rows = (await coll
      .find(filter)
      .sort({ deletedAt: 1 })
      .limit(20)
      .toArray()) as CompanyDocWithId[];
    for (const row of rows) {
      const id = row._id.toString();
      if (
        !isRecordVisible(
          scope,
          row.ownerId,
          scope?.sharedRecordIds.includes(id) ?? false,
          row.departmentId,
        )
      ) {
        continue;
      }
      if (!this.passesAccessGate(row as unknown as Record<string, unknown>, access)) continue;
      return { id, inn: row.inn, domain: row.domain, name: row.name };
    }
    return null;
  }

  /** Portfolio counters within the caller's visibility (company.md §3.13, FR-MCOM-31). */
  async aggregate(
    projectId: string,
    groupBy: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const field = AGGREGATE_GROUP_FIELDS[groupBy];
    if (!field) {
      throw new AppError('invalid', 'Неизвестный groupBy', { field: 'groupBy' });
    }
    const coll = await this.mongo.companies();
    const match = this.scopedFilter(projectId, scope, [{ deletedAt: null }], access);
    const rows = await coll
      .aggregate<{
        _id: unknown;
        count: number;
      }>([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();
    return {
      groups: rows.map((r) => ({ key: r._id == null ? '' : String(r._id), count: r.count })),
    };
  }

  /** dry-run of a merge: which fields conflict (company.md §3.14). */
  async previewMerge(
    projectId: string,
    masterId: string,
    loserId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (masterId === loserId) {
      throw new AppError('invalid', 'masterId и loserId совпадают', { field: 'loserId' });
    }
    const master = (await this.loadForMerge(
      projectId,
      masterId,
      scope,
      access,
    )) as CompanyDocWithId;
    const loser = (await this.loadForMerge(projectId, loserId, scope, access)) as CompanyDocWithId;
    const fields = [
      'name',
      'inn',
      'kpp',
      'phone',
      'email',
      'industry',
      'website',
      'ogrn',
      'region',
    ];
    const fieldConflicts = fields
      .map((f) => ({
        field: f,
        master: String((master as unknown as Record<string, unknown>)[f] ?? ''),
        loser: String((loser as unknown as Record<string, unknown>)[f] ?? ''),
      }))
      .filter((c) => c.master !== c.loser && (c.master || c.loser));
    return { fieldConflicts };
  }

  private async loadForMerge(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(id)) throw new AppError('notFound', 'Company not found');
    const coll = await this.mongo.companies();
    const filter = this.scopedFilter(
      projectId,
      scope,
      [{ _id: new ObjectId(id) as unknown as CompanyDoc['_id'] }, { deletedAt: null }],
      access,
    );
    const doc = (await coll.findOne(filter as never)) as CompanyDocWithId | null;
    if (!doc) throw new AppError('notFound', 'Company not found');
    if (
      !isRecordVisible(
        scope,
        doc.ownerId,
        scope?.sharedRecordIds.includes(id) ?? false,
        doc.departmentId,
      )
    ) {
      throw new AppError('notFound', 'Company not found');
    }
    if (!this.passesAccessGate(doc as unknown as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Company not found');
    }
    return doc;
  }

  /**
   * Merge loser into master → loser enters merge_pending (company.md §3.15).
   * Idempotent per (projectId, loserId): a repeat returns the previous archive (no-op).
   * NOTE: multi-document Mongo-TX requires a replica set; dev standalone Mongo cannot run
   * transactions, so this performs ordered writes + an archive for compensation/revert.
   */
  async mergeCompanies(
    projectId: string,
    masterId: string,
    loserId: string,
    fieldDecisions: { field: string; winner: string }[] = [],
    actorId?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    if (masterId === loserId) {
      throw new AppError('invalid', 'masterId и loserId совпадают', { field: 'loserId' });
    }
    const coll = await this.mongo.companies();
    const archives = await this.mongo.companyArchives();

    // Idempotency: loser already merged → return the prior result (no-op, FR-MCOM-9).
    const existingArchive = (await archives.findOne({
      projectId,
      originalId: loserId,
    })) as { _id: ObjectId; masterId: string; mergeState: string } | null;
    if (existingArchive) {
      return {
        masterId: existingArchive.masterId,
        loserId,
        archiveId: existingArchive._id.toString(),
        mergeState: existingArchive.mergeState,
      };
    }

    // Same ABAC gate previewMerge enforces — the commit path must not bypass it (TODO-012).
    const master = (await this.loadForMerge(
      projectId,
      masterId,
      scope,
      access,
    )) as CompanyDocWithId;
    const loser = (await this.loadForMerge(projectId, loserId, scope, access)) as CompanyDocWithId;

    // Resolve field decisions onto master (loser wins only where explicitly chosen).
    const masterPatch: Record<string, unknown> = {};
    for (const d of fieldDecisions) {
      if (d.winner === 'loser') {
        masterPatch[d.field] = (loser as unknown as Record<string, unknown>)[d.field];
      }
    }
    const now = new Date();

    const archiveDoc = {
      projectId,
      originalId: loserId,
      masterId,
      snapshotDoc: loser as CompanyDoc,
      mergeState: 'pending',
      mergedBy: actorId,
      mergedAt: now,
      expiresAt: new Date(now.getTime() + MERGE_SHADOW_DAYS * 24 * 60 * 60 * 1000),
    };
    // E3-01 transactional outbox: archive + master/loser writes + `crm.company.merged`
    // row in one session (idempotent per (projectId, loserId)). Consumers
    // (contact/deal/order/activity) re-stitch their own references on this event
    // within their own projectId only (FR-MCOM-10, RFC-4 §3.1).
    const archiveId = await this.outbox.withOutbox(async (session) => {
      const arc = await archives.insertOne(archiveDoc as never, session ? { session } : {});
      if (Object.keys(masterPatch).length) {
        masterPatch.updatedAt = now;
        await coll.updateOne(
          { _id: master._id as unknown as CompanyDoc['_id'], projectId },
          { $set: masterPatch },
          session ? { session } : {},
        );
      }
      // Mark loser as merge_pending + soft-deleted (loser identityHash cleared to free the key).
      const loserPurgeAt = new Date(now.getTime() + MERGE_SHADOW_DAYS * 24 * 60 * 60 * 1000);
      await coll.updateOne(
        { _id: loser._id as unknown as CompanyDoc['_id'], projectId },
        {
          $set: { mergeState: 'pending', deletedAt: now, updatedAt: now, purgeAt: loserPurgeAt },
          $unset: { identityHash: '' },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        this.emitIntent(
          'crm.company.merged',
          projectId,
          masterId,
          { masterId, loserId, fieldDecisions, mergedBy: actorId ?? ctx?.userId },
          `company.merged:${loserId}`,
          ctx,
        ),
      ];
      return { result: arc.insertedId.toString(), intents };
    });
    return {
      masterId,
      loserId,
      archiveId,
      mergeState: 'pending',
    };
  }

  /**
   * Load a company by id through the caller's visibility scope + ABAC predicate,
   * ignoring `deletedAt` — used by revert paths that must gate on records the merge
   * itself soft-deleted (TODO-286). Returns null when the caller may not read it.
   */
  private async loadGatedAnyState(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<CompanyDocWithId | null> {
    if (!ObjectId.isValid(id)) return null;
    const coll = await this.mongo.companies();
    const doc = (await coll.findOne(
      this.scopedFilter(
        projectId,
        scope,
        [{ _id: new ObjectId(id) as unknown as CompanyDoc['_id'] }],
        access,
      ) as never,
    )) as CompanyDocWithId | null;
    if (!doc) return null;
    if (
      !isRecordVisible(
        scope,
        doc.ownerId,
        scope?.sharedRecordIds.includes(id) ?? false,
        doc.departmentId,
      )
    ) {
      return null;
    }
    if (!this.passesAccessGate(doc as unknown as Record<string, unknown>, access)) return null;
    return doc;
  }

  /** Revert a merge from the shadow copy within the TTL window (company.md §3.16). */
  async restoreMerge(
    projectId: string,
    archiveId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    if (!ObjectId.isValid(archiveId)) {
      throw new AppError('notFound', 'Архив слияния не найден или истёк');
    }
    const archives = await this.mongo.companyArchives();
    // IDOR guard: archive must belong to the metadata project (company.md §3.16).
    const archive = (await archives.findOne({
      _id: new ObjectId(archiveId) as never,
      projectId,
    })) as {
      _id: ObjectId;
      originalId: string;
      masterId: string;
      snapshotDoc: CompanyDoc;
      expiresAt: Date;
    } | null;
    if (!archive || archive.expiresAt.getTime() < Date.now()) {
      throw new AppError('notFound', 'Архив слияния не найден или истёк', { archiveId });
    }
    // TODO-286: write gate = read gate. Reverting resurrects the loser and rolls the
    // master back, so `companies:manage` alone must not reach a pair the caller cannot
    // read — both parties go through the same scope + ABAC gate a plain GET applies
    // (the loser is soft-deleted by the merge, hence the deletedAt-agnostic loader).
    for (const partyId of [archive.masterId, archive.originalId]) {
      if (!(await this.loadGatedAnyState(projectId, partyId, scope, access))) {
        throw new AppError('notFound', 'Архив слияния не найден или истёк', { archiveId });
      }
    }
    const coll = await this.mongo.companies();
    const now = new Date();
    // Restore the loser: clear merge state + deletedAt, recompute its identity hash.
    const snap = archive.snapshotDoc;
    const identityHash = computeIdentityHash(projectId, snap.inn, snap.domain, snap.name);
    // E3-01 transactional outbox: loser restore + archive delete + `crm.company.merge_reverted`
    // row in one session (audit/search re-stitch references back, RFC-4 §3.1).
    // If the master already claimed this identity, the partial-unique index trips
    // on the recomputed loser hash — surface a clean conflict.
    const loserSet: Record<string, unknown> = { mergeState: null, deletedAt: null, updatedAt: now };
    const loserUnset: Record<string, ''> = { purgeAt: '' };
    if (identityHash) loserSet.identityHash = identityHash;
    else loserUnset.identityHash = '';
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: new ObjectId(archive.originalId) as unknown as CompanyDoc['_id'], projectId },
          Object.keys(loserUnset).length
            ? { $set: loserSet, $unset: loserUnset }
            : { $set: loserSet },
          session ? { session } : {},
        );
        await archives.deleteOne({ _id: archive._id as never }, session ? { session } : {});
        const intents: EmitIntent[] = [
          this.emitIntent(
            'crm.company.merge_reverted',
            projectId,
            archive.masterId,
            { masterId: archive.masterId, loserId: archive.originalId },
            `company.merge_reverted:${archive.originalId}:${now.getTime()}`,
            ctx,
          ),
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('locked', 'Активная компания уже занимает этот ключ идентичности');
      }
      throw err;
    }
    return { loserId: archive.originalId, masterId: archive.masterId, restored: true };
  }

  /**
   * Merges still sitting in `pending` whose consumer-ack window has elapsed
   * (TODO-154). Drives {@link reconcileMerge} from {@link MergeReconcileService};
   * the archive row is the authority (a reverted merge deletes it, so a reverted
   * pair never shows up here).
   */
  async listPendingMerges(
    mergedBefore: Date,
    limit = 100,
  ): Promise<{ projectId: string; loserId: string }[]> {
    const archives = await this.mongo.companyArchives();
    const rows = (await archives
      .find({ mergeState: 'pending', mergedAt: { $lte: mergedBefore } } as never)
      .limit(limit)
      .toArray()) as unknown as { projectId: string; originalId: string }[];
    return rows.map((r) => ({ projectId: String(r.projectId), loserId: String(r.originalId) }));
  }

  /**
   * Internal RPC: move a loser merge_pending → settled once consumers ack (company.md §1, FR-MCOM-11).
   * Called by {@link MergeReconcileService} (in-domain sweeper), no REST facade.
   * Idempotent by construction: a plain `$set` to the terminal state, and once settled
   * the archive no longer matches the `pending` sweep — no idempotency key to replay
   * and nothing to re-run.
   */
  async reconcileMerge(projectId: string, loserId: string) {
    const coll = await this.mongo.companies();
    const archives = await this.mongo.companyArchives();
    await coll.updateOne(
      { _id: new ObjectId(loserId) as unknown as CompanyDoc['_id'], projectId },
      { $set: { mergeState: 'settled' } },
    );
    await archives.updateOne(
      { projectId, originalId: loserId },
      { $set: { mergeState: 'settled' } },
    );
    return { loserId, mergeState: 'settled' };
  }

  /**
   * CSV import with column mapping + dedup mode (company.md §3.17).
   * Per-row errors do not abort the batch.
   */
  async importCompanies(
    projectId: string,
    fileContent: Buffer | undefined,
    mappingJson: string | undefined,
    dedupMode: string | undefined,
    ownerId: string | undefined,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    ctx?: EmitContext,
  ) {
    const text = fileContent?.toString('utf8') ?? '';
    // RFC 4180 (csv-import.ts), not `split(',')`: a quoted `ООО «Ромашка, Инк»` must
    // stay one cell, or every later column of that row lands in the wrong field.
    const records = parseCsv(text);
    // The header is recognised by its content, not by being first: a file exported
    // without captions used to lose its first company to an unconditional skip.
    const dataRecords =
      records.length && looksLikeHeaderRow(records[0].cells) ? records.slice(1) : records;
    if (!dataRecords.length) {
      return { created: 0, skipped: 0, updated: 0, errors: [] };
    }
    let mapping: Record<string, string> = {};
    if (mappingJson?.trim()) {
      try {
        mapping = JSON.parse(mappingJson) as Record<string, string>;
      } catch {
        throw new AppError('invalid', 'Некорректный mappingJson', { field: 'mappingJson' });
      }
    }
    // Duplicate defence for the gateway allowlist: a CSV column must never be able to
    // address a service/attribution field (`createdBy` forges the audit trail,
    // `departmentId`/`ownerId` re-bind the record and thus move it inside the ABAC
    // filter). Reject the whole batch — a silently dropped column would look like a
    // successful import of data that was never written.
    for (const fieldRaw of Object.values(mapping)) {
      const field = String(fieldRaw ?? '');
      if (!field.trim() || !Number.isNaN(Number(field))) continue; // index side of the pair
      if (!IMPORT_MAPPABLE_FIELDS.has(field)) {
        throw new AppError('invalid', `Поле «${field}» нельзя заполнять из файла импорта`, {
          field: 'mappingJson',
          rejectedField: field,
        });
      }
    }
    const mode = ['skip', 'update', 'create'].includes(dedupMode ?? '') ? dedupMode! : 'skip';
    const coll = await this.mongo.companies();

    let created = 0;
    let skipped = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];

    for (const record of dataRecords) {
      const parts = record.cells;
      // Row errors point at the physical line of the file the user can open, which is
      // not the record ordinal once a quoted field carries newlines.
      const rowLine = record.line;
      const row: Partial<CompanyDoc> = {};
      // Apply column mapping {colIndex: fieldName}; fall back to name=col0, inn=col1.
      if (Object.keys(mapping).length) {
        for (const [col, fieldRaw] of Object.entries(mapping)) {
          const idx = Number(col);
          const field = fieldRaw as keyof CompanyDoc;
          if (!IMPORT_MAPPABLE_FIELDS.has(String(fieldRaw))) continue;
          if (!Number.isNaN(idx) && parts[idx] != null) {
            (row as Record<string, unknown>)[field] =
              field === 'tags' ? splitImportTags(parts[idx]) : parts[idx];
          }
        }
      } else {
        row.name = parts[0];
        row.inn = parts[1];
      }
      if (!row.name || !row.name.trim()) {
        errors.push({ row: rowLine, message: 'Пустое название' });
        continue;
      }
      try {
        const inn = normalizeInn(row.inn);
        const domain = deriveDomain(row.email, row.website);
        const identityHash = computeIdentityHash(projectId, inn, domain, row.name);
        // TODO-071: the dedup probe must not read outside the caller's scope. The raw
        // lookup only answers "is the project-wide unique key taken" (it has to: the
        // `uniq_project_identity` index is project-wide, so an insert would fail anyway);
        // whether the row may be *acted on* is decided by the same scope + ABAC gate a
        // manual read applies.
        const raw = identityHash
          ? ((await coll.findOne({
              projectId,
              identityHash,
              deletedAt: null,
            })) as CompanyDocWithId | null)
          : null;
        let existing: CompanyDocWithId | null = null;
        if (raw) {
          existing = await this.loadGatedAnyState(projectId, raw._id.toString(), scope, access);
          if (!existing) {
            // Deliberate: never `skipped++` here — the summary counter would confirm the
            // existence of a record the importer cannot read. dedup='create' is not a way
            // around it either (the partial-unique index would reject the insert), so all
            // modes end in the same per-row access error and the batch continues.
            // Deliberately generic: must not confirm that an unreadable record exists
            // (oracle on the project-wide identity key — TODO-071 / prior pass §4).
            errors.push({
              row: rowLine,
              message: 'Строка не обработана — недостаточно прав доступа',
            });
            continue;
          }
        }
        if (existing) {
          if (mode === 'skip') {
            skipped++;
            continue;
          }
          if (mode === 'update') {
            // Import is not a bypass: the per-row write goes through the same
            // scope+predicate gate as a manual edit (update() → findOne()), so a
            // company hidden from the importer stays NOT_FOUND and lands in
            // `errors` instead of being silently overwritten by a crafted CSV.
            await this.update(
              projectId,
              (existing as CompanyDocWithId)._id.toString(),
              { ...row, inn },
              scope,
              access,
              ctx,
            );
            updated++;
            continue;
          }
          // mode === 'create' → fall through to a new record (duplicate allowed).
        }
        await this.create(projectId, { ...row, inn, ownerId, source: 'import' }, ctx);
        created++;
      } catch (e) {
        errors.push({ row: rowLine, message: formatImportRowError(e) });
      }
    }
    // Per-row `crm.company.created`/`crm.company.updated` events are emitted via
    // create()/update() above (each in its own outbox row, RFC-4 §3.1).
    return { created, skipped, updated, errors };
  }

  /**
   * BX-OFFB-2: reassign every live company owned by a departing member to the new
   * responsible. Emits one `crm.company.updated` per record (ownerId change) so
   * search/denorm stay in sync — never a blunt `updateMany` without events.
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
    const coll = await this.mongo.companies();
    const filter = { projectId, ownerId: from, deletedAt: null };
    const changedAt = Date.now();
    let reassigned = 0;
    await this.outbox.withOutbox(async (session) => {
      const affected = (await coll
        .find(filter, session ? { session } : {})
        .project({ _id: 1 })
        .toArray()) as { _id: ObjectId }[];
      if (!affected.length) return { result: undefined, intents: [] };
      const res = await coll.updateMany(
        filter,
        { $set: { ownerId: to, updatedAt: new Date() } },
        session ? { session } : {},
      );
      reassigned = res.modifiedCount;
      const intents: EmitIntent[] = affected.map((d) => {
        const id = d._id.toString();
        return this.emitIntent(
          'crm.company.updated',
          projectId,
          id,
          {
            companyId: id,
            changedFields: [{ field: 'ownerId', old: from, new: to, changedAt }],
          },
          `company.reassigned:${id}:${offboardTs}`,
        );
      });
      return { result: undefined, intents };
    });
    return { reassigned };
  }

  /**
   * FR-COMPANIES-220: bump the card-contacts revision for companies whose linked
   * contact set changed. Gateway keys its composed `/companies/:id/card` cache on
   * this counter — no domain data mutation beyond the revision stamp.
   */
  async bumpCardContactsRev(projectId: string, companyIds: string[]): Promise<number> {
    const unique = [...new Set(companyIds.map((id) => id.trim()).filter(Boolean))];
    if (!projectId || !unique.length) return 0;
    const coll = await this.mongo.companies();
    const oids = unique.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (!oids.length) return 0;
    const res = await coll.updateMany(
      { projectId, _id: { $in: oids }, deletedAt: null },
      { $inc: { cardContactsRev: 1 }, $set: { updatedAt: new Date() } },
    );
    return res.modifiedCount ?? 0;
  }

  /** FR-PROJ-215 */
  async countOwnedRecords(projectId: string, userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!projectId || !uid) return 0;
    const coll = await this.mongo.companies();
    return coll.countDocuments({ projectId, ownerId: uid, deletedAt: null });
  }
}
