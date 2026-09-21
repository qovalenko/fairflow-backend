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
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { grpcBffCall, toNum } from './grpc-bff-call';
import { jsonToStruct } from './grpc-struct';
import { decodeGrpcProject, encodeGrpcModulePolicyCondition } from './project-grpc.codec';
import { OrgLogoStorageService } from './org-logo-storage.service';
import { readMultipart } from './multipart';
import {
  IMPORT_MAPPABLE_COMPANY_FIELDS,
  normalizeImportMapping as normalizeImportMappingWithAllowlist,
} from './import-mapping';
import type { MultipartUpload } from './multipart';
import { decodeErrorDetails } from '../common/app-error.filter';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { GatewayModuleGuard, invalidateModuleCache } from '../guards/gateway-module.guard';
import { ProjectAccessGuard, type DonorAccess } from '../guards/project-access.guard';
import { SystemAccessGuard, invalidateSystemAccessCache } from '../guards/system-access.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';
import { RequireModule } from '../guards/require-module.decorator';
import { RequirePermission } from '../guards/require-permission.decorator';
import { RequireDonorSubjects } from '../guards/require-donor-subjects.decorator';
import { RequireSystemRole } from '../guards/require-system-role.decorator';
import { RequireOrgStructurePermission } from '../guards/require-org-structure-permission.decorator';
import { MembershipOnly } from '../guards/membership-only.decorator';
import { SkipProjectScope } from '../guards/skip-project-scope.decorator';
import { Public } from '../common/public.decorator';
import { AuthPublicThrottleGuard } from '../auth/auth-public-throttle.guard';
import { AuthPublicThrottle, AUTH_PUBLIC_HOURLY_5 } from '../auth/auth-public-throttle.decorator';
import { AppConfigService } from '../config/app-config.service';
import {
  MODULE_REGISTRY,
  MODULE_MANIFESTS,
  manifestToNavCard,
  resolveDependencies,
  ensureLockedModules,
  shorthandToJsonSchema,
  serializeVisibilityScope,
  parseCompiledPredicate,
  companySensitiveReveal,
  maskCompanySensitiveFields,
  type ModuleNavCard,
  type VisibilityScope,
  previewEnableCascade,
} from '@fairflow/shared';
import { AssigneeNameInterceptor } from './assignee-name.interceptor';
import { appendPiiEgressAudit } from './pii-egress-audit';

/** TTL кэша профилей при обогащении имён/почт участников (Д-8: «с кэшем»). */
const IDENTITY_CACHE_TTL_MS = 30_000;

/** FR-PLATFORM-160: read client idempotency key for lifecycle proto fields. */
function idempotencyKeyFromReq(req: { headers?: Record<string, unknown> }): string {
  const raw = req.headers?.['idempotency-key'];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}

/**
 * Merge-preview relation counters (company.md §3.14). Project-wide impact numbers
 * — see `V1DataBffController.projectWideMd` / `companyRelationCounts`.
 * `contactsTruncated` on merge-preview is always false: contact total is exact.
 */
type CompanyRelationCounts = {
  contacts: number;
  deals: number;
  orders: number;
  activities: number;
  documents: number;
  contactsTruncated: boolean;
};

function mapCompanyLinksFromProto(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((item) => {
      const l = (item ?? {}) as Record<string, unknown>;
      const companyId = String(l.companyId ?? l.company_id ?? '');
      if (!companyId) return null;
      const periodRaw = (l.period ?? {}) as Record<string, unknown>;
      const from = Number(periodRaw.from ?? 0);
      const to = Number(periodRaw.to ?? 0);
      return {
        companyId,
        role: typeof l.role === 'string' && l.role ? l.role : undefined,
        isPrimary: l.isPrimary === true || l.is_primary === true,
        position: typeof l.position === 'string' && l.position ? l.position : undefined,
        period: from || to ? { from: from || undefined, to: to || undefined } : undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

function toProtoCompanyLinks(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const l = (item ?? {}) as Record<string, unknown>;
      const companyId = String(l.companyId ?? l.company_id ?? '');
      if (!companyId) return null;
      const period = (l.period ?? {}) as Record<string, unknown>;
      return {
        company_id: companyId,
        role: typeof l.role === 'string' ? l.role : '',
        is_primary: l.isPrimary === true || l.is_primary === true,
        position: typeof l.position === 'string' ? l.position : '',
        period: {
          from: Number(period.from ?? 0),
          to: Number(period.to ?? 0),
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

function mapContact(c: Record<string, unknown>) {
  return {
    ...c,
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    // FR-CONTACTS-050: middle_name хранится и отдаётся доменом, но без этой строки
    // до фронта доезжал только snake-ключ — все экраны (список/карточка/слияние/
    // корзина/редактирование) читают camelCase и показывали пустое отчество.
    middleName: c.middle_name,
    ownerId: c.owner_id,
    // assigneeId зеркалит owner_id, чтобы AssigneeNameInterceptor заполнил assigneeName
    // (иначе на фронте показывается сырой UUID владельца вместо ФИО менеджера).
    assigneeId: c.owner_id,
    companyIds: c.company_ids,
    companyLinks: mapCompanyLinksFromProto(c.company_links),
    companyId: (c.company_ids as string[])?.[0],
    departmentId: c.department_id,
    lastActivityAt: c.last_activity_at ? Number(c.last_activity_at) : null,
    orphanedCompanyIds: c.orphaned_company_ids,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    // Поля корзины: 0 у живых записей → null для фронта.
    deletedAt: c.deleted_at ? c.deleted_at : null,
    purgeAt: c.purge_at ? c.purge_at : null,
  };
}

function mapDuplicateCandidate(c: Record<string, unknown>) {
  return {
    contactId: c.contact_id,
    displayName: c.display_name,
    matchedOn: c.matched_on,
    maskedValue: c.masked_value,
    deleted: Boolean(c.deleted),
  };
}

/**
 * TODO-158: размер страницы выгрузки компаний. Домен режет page_size до 100
 * (`companies.service.ts`), поэтому просить больше бессмысленно — листаем.
 */
const COMPANY_EXPORT_PAGE_SIZE = 100;
/** TODO-158: потолок выгрузки — 100 страниц × 100 = 10 000 записей за запрос. */
const COMPANY_EXPORT_MAX_PAGES = 100;

/** TTL of the composed `/companies/:id/card` cache (FR-COMPANIES-220). */
const COMPANY_CARD_CACHE_TTL_MS = 30_000;

type CompanyAccessReq = { __accessPredicate?: string };

function companySensitiveAccess(req?: CompanyAccessReq) {
  const raw = req?.__accessPredicate;
  if (!raw?.trim()) return undefined;
  const compiled = parseCompiledPredicate(raw);
  if (!compiled.ir) return undefined;
  return { present: true as const, ir: compiled.ir };
}

function mapCompany(c: Record<string, unknown>) {
  return {
    id: c.id,
    name: c.name,
    inn: c.inn,
    phone: c.phone,
    email: c.email,
    industry: c.industry,
    ownerId: c.owner_id,
    assigneeId: c.owner_id,
    kpp: c.kpp,
    legalAddress: c.legal_address,
    ogrn: c.ogrn,
    website: c.website,
    domain: c.domain,
    status: c.status,
    departmentId: c.department_id,
    region: c.region,
    tags: c.tags,
    notes: c.notes,
    bankName: c.bank_name,
    bik: c.bik,
    correspondentAccount: c.correspondent_account,
    settlementAccount: c.settlement_account,
    deletedAt: c.deleted_at ? c.deleted_at : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    // TODO-364: атрибуция карточки. Домен хранит source/createdBy/updatedBy в Mongo
    // и проецирует их в proto (Company.created_by/updated_by/source); без этого
    // домапа блок «Создал / Изменил» в CompanyDetails не рендерился никогда.
    createdBy: c.created_by,
    updatedBy: c.updated_by,
    source: c.source,
  };
}

/** Gateway REST projection with ABAC masking of sensitive requisites (FR-COMPANIES-380). */
function mapCompanyForClient(c: Record<string, unknown>, req?: FastifyRequest | CompanyAccessReq) {
  const row = mapCompany(c);
  const accessReq = req as CompanyAccessReq | undefined;
  const reveal = companySensitiveReveal(companySensitiveAccess(accessReq), row);
  return maskCompanySensitiveFields(row, reveal);
}

/**
 * FR-COMPANIES-440: нормализация карты колонок импорта компаний.
 * Реализация и allowlist — общий `./import-mapping` (та же копия используется для
 * импорта контактов в crm-bff, чтобы проверка целевых полей не разъехалась).
 */
function normalizeImportMapping(mappingJson: string): string {
  return normalizeImportMappingWithAllowlist(mappingJson, IMPORT_MAPPABLE_COMPANY_FIELDS);
}

/** Тело запроса → `repeated string`: строка с запятыми тоже принимается (старые клиенты). */
function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  return [];
}

/**
 * FR-CONTACTS-190: связь контакт↔компании — M2M. Фронт шлёт `companyIds` (multi-select)
 * и дублирует первую в `companyId` для совместимости; API-клиенты могут прислать только
 * `companyId`. Берём список, иначе одиночное значение.
 */
function toCompanyIds(companyIds: unknown, companyId: unknown): string[] {
  const list = toStringList(companyIds);
  if (list.length > 0) return list;
  if (Array.isArray(companyIds)) return [];
  const single = typeof companyId === 'string' ? companyId.trim() : '';
  return single ? [single] : [];
}

/**
 * FR-CONTACTS-300: поля, по которым разрешена серверная сортировка списка контактов.
 * Ключи — id колонок таблицы на фронте; `companyName`/`assigneeName` серверной
 * сортировке не подлежат (значения подставляются постобработкой шлюза), поэтому в
 * whitelist их нет — такой запрос молча падает в дефолтный порядок.
 */
const CONTACT_SORTABLE_FIELDS = new Set([
  'firstName',
  'lastName',
  'middleName',
  'email',
  'phone',
  'position',
  'source',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
]);

/**
 * Размер страницы, которой экспорт контактов вычитывает домен. Домен клампит
 * page_size до MAX_PAGE_SIZE=100 (`contact/src/grpc/contact.grpc.controller.ts`
 * clampPageSize + повторный кламп в `contacts.service.ts`), поэтому просить
 * больше бессмысленно — лишнее молча отрезается.
 */
const CONTACT_EXPORT_PAGE_SIZE = 100;
/**
 * Потолок одной выгрузки: память шлюза + PII-egress (152-ФЗ). Превышение —
 * явная 400 с подсказкой сузить выборку, а НЕ тихо обрезанный файл.
 */
const CONTACT_EXPORT_MAX_ROWS = 50_000;
/** Текст отказа виден пользователю в тосте — он должен объяснять, что делать. */
function exportTooLargeMessage(total: number): string {
  return `под выгрузку попало ${total} контактов, максимум за раз — ${CONTACT_EXPORT_MAX_ROWS}: уточните поиск или выгрузите частями`;
}

/**
 * Достать сортировку из query. Таблица на фронте держит её вложенным объектом
 * `sort: { order, key }`, axios сериализует это как `sort[key]=…&sort[order]=…`,
 * а Fastify отдаёт такие ключи «как есть» — @Query('sortBy') их не видит. Читаем
 * обе формы: плоскую (`sortBy`/`sortDir`, канон для API-клиентов) и вложенную.
 *
 * Поле проходит whitelist прямо здесь: неизвестное имя не уезжает в домен, иначе
 * сортировка превращалась бы в зонд «есть ли такое поле в документе».
 */
function readSortParam(
  req: FastifyRequest,
  sortBy?: string,
  sortDir?: string,
): { by: string; dir: string } {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const nested = q.sort;
  let key = sortBy ?? '';
  let dir = sortDir ?? '';
  if (!key && nested != null) {
    if (typeof nested === 'object') {
      const o = nested as Record<string, unknown>;
      key = String(o.key ?? '');
      dir = dir || String(o.order ?? '');
    } else if (typeof nested === 'string') {
      key = nested;
    }
  }
  if (!key) key = String(q['sort[key]'] ?? '');
  if (!dir) dir = String(q['sort[order]'] ?? '');
  key = key.trim();
  dir = dir.trim().toLowerCase();
  if (!CONTACT_SORTABLE_FIELDS.has(key)) return { by: '', dir: '' };
  return { by: key, dir: dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : '' };
}

/** Org gRPC response (snake_case) → frontend shape (camelCase). */
function mapOrganization(o: Record<string, unknown>) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    role: o.role,
    inn: o.inn,
    kpp: o.kpp,
    ogrn: o.ogrn,
    legalAddress: o.legal_address ?? o.legalAddress,
    actualAddress: o.actual_address ?? o.actualAddress,
    phone: o.phone,
    email: o.email,
    logoUrl: o.logo_url ?? o.logoUrl,
    description: o.description,
  };
}

type OrgRequisitesBody = {
  inn?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
  actualAddress?: string;
  phone?: string;
  email?: string;
  logoUrl?: string;
  description?: string;
};

function mapDepartment(d: Record<string, unknown>) {
  return {
    id: d.id,
    organizationId: d.organization_id ?? d.organizationId,
    name: d.name,
    parentId: (d.parent_id || d.parentId || null) as string | null,
    leaderUserId: (d.leader_user_id || d.leaderUserId || null) as string | null,
    createdAt: d.created_at ?? d.createdAt,
  };
}

/** DepartmentProjectBinding gRPC response → frontend shape (FR-MORG-7/8). */
function mapBinding(b: Record<string, unknown>) {
  return {
    id: b.id,
    organizationId: (b.organization_id ?? b.organizationId) as string,
    departmentId: (b.department_id ?? b.departmentId) as string,
    projectId: (b.project_id ?? b.projectId) as string,
    projectName: (b.project_name ?? b.projectName ?? '') as string,
    defaultRole: (b.default_role ?? b.defaultRole) as string,
    scope: b.scope as string,
    status: b.status as string,
    createdBy: (b.created_by || b.createdBy || null) as string | null,
    createdAt: b.created_at ?? b.createdAt,
    updatedAt: b.updated_at ?? b.updatedAt,
  };
}

/** AccessUnit (group) gRPC response → frontend shape (E2-06). */
function mapAccessUnit(u: Record<string, unknown>) {
  return {
    id: u.id,
    scopeType: (u.scope_type ?? u.scopeType) as string,
    scopeId: (u.scope_id ?? u.scopeId) as string,
    name: u.name,
    kind: u.kind,
    parentId: (u.parent_id || u.parentId || null) as string | null,
    leaderUserId: (u.leader_user_id || u.leaderUserId || null) as string | null,
    archivedAt: (u.archived_at || u.archivedAt || null) as string | null,
    createdAt: u.created_at ?? u.createdAt,
  };
}

/** AccessUnitMember gRPC response → frontend shape (E2-06). */
function mapAccessUnitMember(m: Record<string, unknown>) {
  return {
    id: m.id,
    unitId: (m.unit_id ?? m.unitId) as string,
    memberType: (m.member_type ?? m.memberType) as string,
    memberId: (m.member_id ?? m.memberId) as string,
    addedBy: (m.added_by || m.addedBy || null) as string | null,
    addedAt: m.added_at ?? m.addedAt,
  };
}

/** Integration gRPC response → frontend shape (the secret value is never exposed). */
function mapIntegration(i: Record<string, unknown>) {
  return {
    id: i.id,
    projectId: i.project_id ?? i.projectId,
    name: i.name,
    type: i.type,
    config: (i.config ?? {}) as Record<string, unknown>,
    secretSet: Boolean(i.secret_set ?? i.secretSet),
    secretMasked: (i.secret_masked ?? i.secretMasked ?? '') as string,
    status: i.status,
    createdBy: i.created_by ?? i.createdBy,
    createdAt: i.created_at ?? i.createdAt,
    updatedAt: i.updated_at ?? i.updatedAt,
  };
}

/** Webhook-delivery gRPC row → frontend shape (BX-INTEG-5 "Deliveries" panel). */
function mapWebhookDelivery(d: Record<string, unknown>) {
  const code = Number(d.http_code ?? d.httpCode ?? 0);
  return {
    id: d.id,
    projectId: d.project_id ?? d.projectId,
    integrationId: d.integration_id ?? d.integrationId,
    eventType: d.event_type ?? d.eventType,
    url: d.url,
    // 0 is the proto sentinel for "no HTTP response" (network error/timeout/blocked).
    httpCode: code > 0 ? code : null,
    status: d.status,
    attempts: Number(d.attempts ?? 0),
    error: ((d.error as string) || '') as string,
    createdAt: d.created_at ?? d.createdAt,
  };
}

/** API-key gRPC response → frontend shape (the plaintext is never in list/get). */
function mapApiKey(k: Record<string, unknown>) {
  return {
    id: k.id,
    projectId: k.project_id ?? k.projectId,
    name: k.name,
    prefix: k.prefix,
    keyMasked: (k.key_masked ?? k.keyMasked ?? '') as string,
    status: k.status,
    createdBy: k.created_by ?? k.createdBy,
    createdAt: k.created_at ?? k.createdAt,
    lastUsedAt: (k.last_used_at || k.lastUsedAt || null) as string | null,
    revokedAt: (k.revoked_at || k.revokedAt || null) as string | null,
  };
}

/** Invitation gRPC response → frontend shape (the secret token is never exposed). */
/** proto ProjectGrant[] (snake_case) → frontend shape (FR-ONB-10). */
function mapProjectGrants(raw: unknown): { projectId: string; role: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => ({
      projectId: String(
        (g as { project_id?: string; projectId?: string })?.project_id ??
          (g as { projectId?: string })?.projectId ??
          '',
      ).trim(),
      role: String((g as { role?: string })?.role ?? '').trim(),
    }))
    .filter((g) => g.projectId);
}

function mapInvitation(i: Record<string, unknown>) {
  return {
    id: i.id,
    organizationId: i.organization_id ?? i.organizationId,
    email: i.email,
    role: i.role,
    departmentId: (i.department_id || i.departmentId || null) as string | null,
    status: i.status,
    invitedByUserId: i.invited_by_user_id ?? i.invitedByUserId,
    acceptedUserId: (i.accepted_user_id || i.acceptedUserId || null) as string | null,
    // onboarding step 4 (FR-ONB-10): project access this invite grants. NB the
    // bearer `token` is intentionally NOT surfaced here (W0 secret hygiene).
    projectGrants: mapProjectGrants(i.project_grants ?? i.projectGrants),
    createdAt: i.created_at ?? i.createdAt,
    expiresAt: i.expires_at ?? i.expiresAt,
  };
}

/** Org audit entry gRPC response → frontend shape (metadata parsed from JSON). */
function mapAuditEntry(e: Record<string, unknown>) {
  let metadata: Record<string, unknown> | null = null;
  const raw = e.metadata_json ?? e.metadataJson;
  if (typeof raw === 'string' && raw) {
    try {
      metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: e.id,
    organizationId: e.organization_id ?? e.organizationId,
    userId: (e.actor_user_id ?? e.actorUserId ?? '') as string,
    action: e.action,
    entityType: e.entity_type ?? e.entityType,
    entityId: (e.entity_id || e.entityId || null) as string | null,
    metadata,
    createdAt: e.created_at ?? e.createdAt,
  };
}

/** Human labels for CRM record-history events (AuditGrpc event_name → summary). */
const HISTORY_EVENT_LABELS: Record<string, string> = {
  'crm.contact.created': 'Контакт создан',
  'crm.contact.updated': 'Изменены данные контакта',
  'crm.contact.deleted': 'Контакт удалён',
  'crm.contact.restored': 'Контакт восстановлен',
  'crm.contact.merged': 'Контакты объединены',
  'crm.company.created': 'Компания создана',
  'crm.company.updated': 'Изменены данные компании',
  'crm.company.deleted': 'Компания удалена',
  'crm.company.restored': 'Компания восстановлена',
  'crm.company.merged': 'Компании объединены',
};

function historyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** page_size for contact/company history. FE already sends `limit` (default 50). */
function parseHistoryPageSize(raw?: string): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

/**
 * AuditGrpc event (snake_case, keepCase loader) → frontend history item shape
 * consumed by ContactDetails/CompanyDetails (`{ id, type, userId, userName,
 * timestamp, summary, changedFields }`). Normalizes field-level changes from
 * either the contact payload (`changes:[{field,oldValue,newValue}]`) or the
 * company payload (`changedFields:[{field,old,new}]`).
 */
function mapHistoryEvent(e: Record<string, unknown>) {
  const eventName = String(e.event_name ?? e.eventName ?? '');
  let payload: Record<string, unknown> = {};
  const raw = e.payload_json ?? e.payloadJson;
  if (typeof raw === 'string' && raw) {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  const rawChanges = (
    Array.isArray(payload.changedFields)
      ? payload.changedFields
      : Array.isArray(payload.changes)
        ? payload.changes
        : []
  ) as Record<string, unknown>[];
  const changedFields = rawChanges.map((c) => ({
    field: String(c.field ?? ''),
    old: historyValue(c.old !== undefined ? c.old : c.oldValue),
    new: historyValue(c.new !== undefined ? c.new : c.newValue),
  }));
  return {
    id: String(e.id ?? ''),
    type: eventName,
    userId: String(e.actor_id ?? e.actorId ?? ''),
    userName: '',
    timestamp: Number(e.created_at ?? e.createdAt ?? 0),
    summary: HISTORY_EVENT_LABELS[eventName] ?? eventName,
    changedFields,
  };
}

/**
 * AuditGrpc event (snake_case, keepCase loader) → project audit-tab entry shape
 * consumed by the project-settings "Audit" tab. Identity (name/email/avatarUrl)
 * is added by enrichWithIdentity via `userId`; payload is parsed from JSON
 * (mirrors mapHistoryEvent's try/catch). camelCase fallbacks tolerate a
 * keepCase-off loader.
 */
function mapProjectAuditEntry(e: Record<string, unknown>) {
  let metadata: Record<string, unknown> | null = null;
  const raw = e.payload_json ?? e.payloadJson;
  if (typeof raw === 'string' && raw) {
    try {
      metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: String(e.id ?? ''),
    projectId: (e.project_id ?? e.projectId ?? '') as string,
    userId: (e.actor_id ?? e.actorId ?? '') as string,
    actorType: (e.actor_type ?? e.actorType ?? '') as string,
    action: (e.event_name ?? e.eventName ?? '') as string,
    entityType: (e.entity_type ?? e.entityType ?? '') as string,
    entityId: (e.entity_id || e.entityId || null) as string | null,
    metadata,
    createdAt: Number(e.created_at ?? e.createdAt ?? 0),
  };
}

/** Base employee shape (identity is added by enrichWithIdentity). */
function mapEmployee(e: Record<string, unknown>) {
  return {
    id: e.id,
    userId: (e.user_id ?? e.userId) as string,
    role: e.role,
    departmentId: (e.department_id || e.departmentId || null) as string | null,
    // FR-MORG-23/43: offboarded employees are returned with isActive=false so the
    // FE can render/seat-account them; default true for legacy rows.
    isActive: (e.is_active ?? e.isActive ?? true) as boolean,
    createdAt: e.created_at ?? e.createdAt,
  };
}

/** Map a requisites body to snake_case gRPC fields, omitting undefined keys. */
function toGrpcRequisites(body: OrgRequisitesBody) {
  const out: Record<string, string> = {};
  if (body.inn !== undefined) out.inn = body.inn;
  if (body.kpp !== undefined) out.kpp = body.kpp;
  if (body.ogrn !== undefined) out.ogrn = body.ogrn;
  if (body.legalAddress !== undefined) out.legal_address = body.legalAddress;
  if (body.actualAddress !== undefined) out.actual_address = body.actualAddress;
  if (body.phone !== undefined) out.phone = body.phone;
  if (body.email !== undefined) out.email = body.email;
  if (body.logoUrl !== undefined) out.logo_url = body.logoUrl;
  if (body.description !== undefined) out.description = body.description;
  return out;
}

@ApiBearerAuth()
// SystemOrgContextGuard (DEORG-GW-1) runs FIRST: it resolves the single-tenant org
// anchor server-side and stashes `req.__systemOrgId` (the client no longer supplies
// an orgId). SystemAccessGuard (DEORG-GW-3, ex-OrgAccessGuard, defense-in-depth):
// PEP #1 for system routes, symmetric to ProjectAccessGuard. It acts on routes
// annotated with @RequireSystemRole; control keeps its own PDP checks
// (assertCanManage/assertMember) — this is a second rubber-band.
@UseGuards(SystemOrgContextGuard, ProjectAccessGuard, SystemAccessGuard)
@UseInterceptors(AssigneeNameInterceptor)
@Controller({ path: '', version: '1' })
export class V1DataBffController implements OnModuleInit {
  private project!: {
    listProjectsByOwner: (x: unknown, m?: unknown) => unknown;
    listMyProjects: (x: unknown, m?: unknown) => unknown;
    createProject: (x: unknown, m?: unknown) => unknown;
    getProject: (x: unknown, m?: unknown) => unknown;
    updateProject: (x: unknown, m?: unknown) => unknown;
    listMembers: (x: unknown, m?: unknown) => unknown;
    addMember: (x: unknown, m?: unknown) => unknown;
    updateMemberRole: (x: unknown, m?: unknown) => unknown;
    removeMember: (x: unknown, m?: unknown) => unknown;
    previewRemoveMember: (x: unknown, m?: unknown) => unknown;
    createProjectInvitation: (x: unknown, m?: unknown) => unknown;
    getProjectInvitation: (x: unknown, m?: unknown) => unknown;
    acceptProjectInvitation: (x: unknown, m?: unknown) => unknown;
    archiveProject: (x: unknown, m?: unknown) => unknown;
    requestProjectDeletion: (x: unknown, m?: unknown) => unknown;
    restoreProject: (x: unknown, m?: unknown) => unknown;
    applyTemplate: (x: unknown, m?: unknown) => unknown;
    getModuleDisableImpact: (x: unknown, m?: unknown) => unknown;
    shareRecord: (x: unknown, m?: unknown) => unknown;
    listRecordShares: (x: unknown, m?: unknown) => unknown;
    unshareRecord: (x: unknown, m?: unknown) => unknown;
  };
  private lifecycle!: {
    listModuleStates: (x: unknown, m?: unknown) => unknown;
    installModule: (x: unknown, m?: unknown) => unknown;
    uninstallModule: (x: unknown, m?: unknown) => unknown;
    enableModule: (x: unknown, m?: unknown) => unknown;
    disableModule: (x: unknown, m?: unknown) => unknown;
    upgradeModulePreview: (x: unknown, m?: unknown) => unknown;
    upgradeModule: (x: unknown, m?: unknown) => unknown;
    resumeModuleDelivery: (x: unknown, m?: unknown) => unknown;
  };
  // F3-integ-be (U8/U4): project integrations + per-project API keys.
  private integration!: {
    listIntegrations: (x: unknown, m?: unknown) => unknown;
    getIntegration: (x: unknown, m?: unknown) => unknown;
    createIntegration: (x: unknown, m?: unknown) => unknown;
    updateIntegration: (x: unknown, m?: unknown) => unknown;
    deleteIntegration: (x: unknown, m?: unknown) => unknown;
    listApiKeys: (x: unknown, m?: unknown) => unknown;
    createApiKey: (x: unknown, m?: unknown) => unknown;
    revokeApiKey: (x: unknown, m?: unknown) => unknown;
    listWebhookDeliveries: (x: unknown, m?: unknown) => unknown;
  };
  private organization!: {
    createOrganization: (x: unknown, m?: unknown) => unknown;
    getOrganization: (x: unknown, m?: unknown) => unknown;
    updateOrganization: (x: unknown, m?: unknown) => unknown;
    listMyOrganizations: (x: unknown, m?: unknown) => unknown;
    listEmployees: (x: unknown, m?: unknown) => unknown;
    listColleagueDirectory: (x: unknown, m?: unknown) => unknown;
    addEmployee: (x: unknown, m?: unknown) => unknown;
    updateEmployee: (x: unknown, m?: unknown) => unknown;
    removeEmployee: (x: unknown, m?: unknown) => unknown;
    deactivateEmployee: (x: unknown, m?: unknown) => unknown;
    reactivateEmployee: (x: unknown, m?: unknown) => unknown;
    transferOwnership: (x: unknown, m?: unknown) => unknown;
    getOrgPermissionProjection: (x: unknown, m?: unknown) => unknown;
    deactivateOrganization: (x: unknown, m?: unknown) => unknown;
    reactivateOrganization: (x: unknown, m?: unknown) => unknown;
    previewReorg: (x: unknown, m?: unknown) => unknown;
    getMyMembership: (x: unknown, m?: unknown) => unknown;
    previewOffboard: (x: unknown, m?: unknown) => unknown;
    listDepartments: (x: unknown, m?: unknown) => unknown;
    createDepartment: (x: unknown, m?: unknown) => unknown;
    updateDepartment: (x: unknown, m?: unknown) => unknown;
    deleteDepartment: (x: unknown, m?: unknown) => unknown;
    listDepartmentBindings: (x: unknown, m?: unknown) => unknown;
    createDepartmentBinding: (x: unknown, m?: unknown) => unknown;
    updateDepartmentBinding: (x: unknown, m?: unknown) => unknown;
    deleteDepartmentBinding: (x: unknown, m?: unknown) => unknown;
    createInvitation: (x: unknown, m?: unknown) => unknown;
    listInvitations: (x: unknown, m?: unknown) => unknown;
    revokeInvitation: (x: unknown, m?: unknown) => unknown;
    resendInvitation: (x: unknown, m?: unknown) => unknown;
    getInvitation: (x: unknown, m?: unknown) => unknown;
    acceptInvitation: (x: unknown, m?: unknown) => unknown;
    listOrgAudit: (x: unknown, m?: unknown) => unknown;
    getDepartmentSummary: (x: unknown, m?: unknown) => unknown;
  };
  private accessUnit!: {
    listAccessUnits: (x: unknown, m?: unknown) => unknown;
    createAccessUnit: (x: unknown, m?: unknown) => unknown;
    updateAccessUnit: (x: unknown, m?: unknown) => unknown;
    setUnitParent: (x: unknown, m?: unknown) => unknown;
    archiveAccessUnit: (x: unknown, m?: unknown) => unknown;
    listUnitMembers: (x: unknown, m?: unknown) => unknown;
    listUnitsOfUser: (x: unknown, m?: unknown) => unknown;
    addUnitMember: (x: unknown, m?: unknown) => unknown;
    removeUnitMember: (x: unknown, m?: unknown) => unknown;
    previewUnitComposition: (x: unknown, m?: unknown) => unknown;
  };
  private auth!: {
    me: (x: unknown, m?: unknown) => unknown;
    provisionUser: (x: unknown, m?: unknown) => unknown;
    getUserByEmail: (x: unknown, m?: unknown) => unknown;
  };
  private directory!: { resolveUsers: (x: unknown, m?: unknown) => unknown };
  /** Короткоживущий кэш профилей для enrichWithIdentity (Д-8: «с кэшем»). */
  private readonly identityCache = new Map<
    string,
    { name: string; email: string; avatarUrl: string; position?: string; expiresAt: number }
  >();
  /** FR-COMPANIES-220: short-lived cache for composed company cards keyed by `cardContactsRev`. */
  private readonly companyCardCache = new Map<
    string,
    { expiresAt: number; payload: Record<string, unknown> }
  >();
  private notification!: {
    send: (x: unknown, m?: unknown) => unknown;
    sendTransactionalEmail: (x: unknown, m?: unknown) => unknown;
  };
  private readonly logger = new Logger(V1DataBffController.name);
  private contact!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private company!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private audit!: {
    listEvents: (x: unknown, m?: unknown) => unknown;
    appendEvent: (x: unknown, m?: unknown) => unknown;
  };
  // Cross-domain donors for card/links aggregates (each carries its own visibility scope).
  private pipe!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private orders!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private activity!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private documents!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private search!: { listUnassigned: (x: unknown, m?: unknown) => unknown };

  private toGrpcModuleConfigs(input: unknown) {
    if (!Array.isArray(input)) return undefined;
    const list = input
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .map((cfg) => ({
        module_id: String(cfg.moduleId ?? ''),
        enabled: Boolean(cfg.enabled),
        // Struct wire format — a plain map serializes to an EMPTY Struct, so a
        // Modules-tab save would silently wipe every module's stored settings
        // (control/src/grpc/module-settings-struct.spec.ts).
        personal_settings: jsonToStruct(cfg.personalSettings),
        integration_settings: jsonToStruct(cfg.integrationSettings),
        integration_methods_enabled: Array.isArray(cfg.integrationMethodsEnabled)
          ? cfg.integrationMethodsEnabled.filter((v): v is string => typeof v === 'string')
          : [],
        ...(cfg.runtimeStatus === 'active' || cfg.runtimeStatus === 'suspended'
          ? { runtime_status: cfg.runtimeStatus }
          : {}),
        ...(cfg.everSuspended === true ? { ever_suspended: true } : {}),
        ...(cfg.configState === 'ready' || cfg.configState === 'needs_config'
          ? { config_state: cfg.configState }
          : {}),
      }))
      .filter((cfg) => cfg.module_id.length > 0);
    return list;
  }

  private toGrpcModulePolicies(input: unknown) {
    if (!Array.isArray(input)) return undefined;
    const list = input
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .map((rule) => ({
        id: String(rule.id ?? ''),
        module_id: String(rule.moduleId ?? ''),
        effect: String(rule.effect ?? 'allow'),
        subject: String(rule.subject ?? ''),
        action: String(rule.action ?? ''),
        resource: String(rule.resource ?? '*'),
        condition: encodeGrpcModulePolicyCondition(rule.condition),
      }))
      .filter((rule) => rule.id.length > 0 && rule.module_id.length > 0);
    return list;
  }

  /**
   * FR-COMPANIES-440: прочитать multipart-загрузку (файл + текстовые поля) из
   * Fastify-запроса. Возвращает `null`, если тело не multipart — тогда работает
   * старый JSON-путь.
   *
   * m5: реализация — общий `./multipart`, тот же, что использует crm-bff
   * (`req.parts()`, файл — необязательная часть, лимит 20 МБ отдаётся клиенту как
   * чистый 400). Раньше здесь лежала дословная копия, и при смене лимита две
   * копии разъехались бы.
   */
  private async readMultipart(req: FastifyRequest): Promise<MultipartUpload | null> {
    return readMultipart(req);
  }

  constructor(
    @Inject('CONTROL_GRPC') private control: ClientGrpcProxy,
    @Inject('CONTACT_GRPC') private contactClient: ClientGrpcProxy,
    @Inject('COMPANY_GRPC') private companyClient: ClientGrpcProxy,
    @Inject('AUTH_GRPC') private authClient: ClientGrpcProxy,
    @Inject('NOTIFICATION_GRPC') private notificationClient: ClientGrpcProxy,
    @Inject('AUDIT_GRPC') private auditClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private ordersClient: ClientGrpcProxy,
    @Inject('ACTIVITY_GRPC') private activityClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private documentsClient: ClientGrpcProxy,
    @Inject('SEARCH_GRPC') private searchClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly config: AppConfigService,
    private readonly orgLogoStorage: OrgLogoStorageService,
  ) {}

  onModuleInit() {
    this.project = this.control.getService('ProjectGrpc');
    this.lifecycle = this.control.getService('ModuleLifecycleControlGrpc');
    this.integration = this.control.getService('IntegrationGrpc');
    this.organization = this.control.getService('OrganizationGrpc');
    this.accessUnit = this.control.getService('AccessUnitGrpc');
    this.contact = this.contactClient.getService('ContactGrpc');
    this.company = this.companyClient.getService('CompanyGrpc');
    this.auth = this.authClient.getService('AuthGrpc');
    this.directory = this.authClient.getService('UserDirectoryGrpc');
    this.notification = this.notificationClient.getService('NotificationGrpc');
    this.audit = this.auditClient.getService('AuditGrpc');
    this.pipe = this.pipeClient.getService('PipeGrpc');
    this.orders = this.ordersClient.getService('OrdersGrpc');
    this.activity = this.activityClient.getService('ActivityGrpc');
    this.documents = this.documentsClient.getService('DocumentsGrpc');
    this.search = this.searchClient.getService('SearchGrpc');
  }

  /**
   * Enrich rows carrying a `userId` with real name/email/avatar from auth (Д-8).
   * Один батч-вызов `UserDirectoryGrpc.ResolveUsers` (вместо N×`auth.me`) + кэш профилей.
   * Неразрешённый профиль → `name` падает на userId (явный маркер), не фейк-почта.
   */
  private async enrichWithIdentity<T extends { userId: string }>(
    req: FastifyRequest & { user?: { userId?: string } },
    rows: T[],
  ): Promise<Array<T & { name: string; email: string; avatarUrl: string }>> {
    const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
    const now = Date.now();
    const byId = new Map<string, { name: string; email: string; avatarUrl: string }>();
    const miss: string[] = [];
    for (const id of ids) {
      const c = this.identityCache.get(id);
      if (c && c.expiresAt > now) byId.set(id, c);
      else miss.push(id);
    }

    if (miss.length > 0) {
      const md = this.outboundMeta.build(req);
      try {
        const r = (await grpcBffCall(this.directory.resolveUsers({ ids: miss }, md) as never)) as {
          users?: Array<Record<string, unknown>>;
        };
        const expiresAt = now + IDENTITY_CACHE_TTL_MS;
        for (const u of r.users ?? []) {
          const id = u.id as string;
          if (!id) continue;
          const entry = {
            name: (u.name as string) || (u.login as string) || id,
            email: (u.email as string) || '',
            avatarUrl: (u.avatar_url as string) || (u.avatarUrl as string) || '',
            position: (u.position as string) || '',
          };
          byId.set(id, entry);
          this.identityCache.set(id, { ...entry, expiresAt });
        }
      } catch {
        // auth недоступен — неразрешённые id получат fallback на userId ниже
      }
    }

    return rows.map((r) => {
      const u = byId.get(r.userId);
      return {
        ...r,
        name: u?.name || r.userId,
        email: u?.email || '',
        avatarUrl: u?.avatarUrl || '',
      };
    });
  }

  /**
   * FR-ORG-150: enrich colleague-directory rows with name/avatar/position only —
   * email is resolved internally but NEVER forwarded to the client.
   */
  private async enrichColleagueDirectory<T extends { userId: string; managerUserId?: string }>(
    req: FastifyRequest & { user?: { userId?: string } },
    rows: T[],
  ): Promise<
    Array<
      T & {
        name: string;
        avatarUrl: string;
        position: string;
        managerName: string;
      }
    >
  > {
    const ids = [
      ...new Set(rows.flatMap((r) => [r.userId, r.managerUserId].filter(Boolean) as string[])),
    ];
    const now = Date.now();
    const byId = new Map<string, { name: string; avatarUrl: string; position: string }>();
    const miss: string[] = [];
    for (const id of ids) {
      const c = this.identityCache.get(id);
      if (c && c.expiresAt > now) {
        byId.set(id, {
          name: c.name,
          avatarUrl: c.avatarUrl,
          position: (c as { position?: string }).position ?? '',
        });
      } else miss.push(id);
    }
    if (miss.length > 0) {
      const md = this.outboundMeta.build(req);
      try {
        const r = (await grpcBffCall(this.directory.resolveUsers({ ids: miss }, md) as never)) as {
          users?: Array<Record<string, unknown>>;
        };
        const expiresAt = now + IDENTITY_CACHE_TTL_MS;
        for (const u of r.users ?? []) {
          const id = u.id as string;
          if (!id) continue;
          const entry = {
            name: (u.name as string) || (u.login as string) || id,
            email: (u.email as string) || '',
            avatarUrl: (u.avatar_url as string) || (u.avatarUrl as string) || '',
            position: (u.position as string) || '',
          };
          byId.set(id, { name: entry.name, avatarUrl: entry.avatarUrl, position: entry.position });
          this.identityCache.set(id, { ...entry, expiresAt });
        }
      } catch {
        // auth unreachable — fallback to userId below
      }
    }
    return rows.map((r) => {
      const self = byId.get(r.userId);
      const mgr = r.managerUserId ? byId.get(r.managerUserId) : undefined;
      return {
        ...r,
        name: self?.name || r.userId,
        avatarUrl: self?.avatarUrl || '',
        position: self?.position || '',
        managerName: mgr?.name || (r.managerUserId ? r.managerUserId : ''),
      };
    });
  }

  /** List projects: by userId (my projects) or by ownerType+ownerId */
  @Get('projects')
  @ApiTags('Projects')
  // T-001-BE: "my projects" is scoped by the caller's userId (JWT), NOT by any
  // single project — the ambient x-project-id header is irrelevant here. This is
  // one of the first routes a freshly-onboarded / org-switching user hits, when
  // that header may still point at a stale or foreign project; letting the guard
  // gate on it would 403 → empty project menu. control scopes the list by the
  // JWT user, so ignoring the header weakens nothing.
  @SkipProjectScope()
  async projects(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('userId') userIdQuery: string,
    @Query('ownerType') _ownerType: string,
    @Query('ownerId') _ownerId: string,
  ) {
    const md = this.outboundMeta.build(req);
    // FR-PROJ-080 (BOX): ignore ownerType/ownerId listing — it enumerated every
    // project of the System without membership checks. Membership-scoped list only.
    const userId = (userIdQuery ?? req.user?.userId ?? '').trim();
    if (!userId) return [];
    const r = (await grpcBffCall(
      this.project.listMyProjects({ user_id: userId }, md) as never,
    )) as { list: unknown[] };
    // Same decode as GET /projects/:id — the FE seeds Settings/ModulesTab state
    // from this list and PATCHes it back; a raw Struct wire shape here would be
    // double-encoded on save and corrupt stored module settings/conditions.
    return (r.list ?? []).map((p) =>
      p && typeof p === 'object' ? decodeGrpcProject(p as Record<string, unknown>) : p,
    );
  }

  // DEORG-GW-1/GW-5: the single-tenant org anchor, resolved server-side and stashed
  // on the request by SystemOrgContextGuard. The client no longer carries an orgId;
  // handlers read the anchor from here. control (DEORG-BE-16) also re-resolves the
  // singleton and ignores this value for most RPCs — GetOrganization/UpdateOrganization
  // are the exceptions that still key on the id, hence the server-side resolution.
  private sysOrgId(req: FastifyRequest & { __systemOrgId?: string }): string {
    return req.__systemOrgId?.trim() ?? '';
  }

  @Post('system')
  @ApiTags('Organizations')
  // T-001-BE: creating a NEW organization has no project context at all — owner is
  // the JWT user (never the body). It is an onboarding route hit before any project
  // exists, when the ambient x-project-id header may be stale/foreign; without this
  // marker ProjectAccessGuard would resolve membership in that unrelated project and
  // 403. control authorizes the create by the JWT user, so no scope is weakened.
  @SkipProjectScope()
  async createOrganization(
    @Body() body: { name?: string; slug?: string } & OrgRequisitesBody,
    @Req() req: FastifyRequest & { user?: { userId?: string } },
  ) {
    const name = body.name?.trim() ?? '';
    const userId = req.user?.userId ?? '';
    if (!name) throw new BadRequestException('name required');
    if (!userId) throw new UnauthorizedException('user not authenticated');

    const md = this.outboundMeta.build(req);

    // box (on-prem, §5.5): single-tenant invariant. A second organization is not
    // allowed — the FE hides the action (features.multiOrg:false), and this is the
    // defense-in-depth backstop closing a direct-API bypass. Once the caller
    // already owns/belongs to an org → 403.
    const existing = (await grpcBffCall(
      this.organization.listMyOrganizations({ user_id: userId }, md) as never,
    ).catch(() => ({ list: [] as unknown[] }))) as { list?: unknown[] };
    if (Array.isArray(existing.list) && existing.list.length > 0) {
      throw new ForbiddenException({ code: 'MULTI_ORG_DISABLED' });
    }

    const res = (await grpcBffCall(
      this.organization.createOrganization(
        {
          name,
          slug: body.slug,
          user_id: userId,
          ...toGrpcRequisites(body),
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapOrganization(res);
  }

  // DEORG-GW-6: resolve THE single system organization for the FE session. box is
  // single-tenant (FR-DEORG-1/15) — the session holds ONE system + the caller's
  // system role, not an `organizations[]` array. The subject is always the JWT user
  // (control ignores any body userId, W0/IDOR); returns `null` before bootstrap.
  @Get('system')
  @ApiTags('Organizations')
  @MembershipOnly()
  async getSystem(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const userId = (req.user?.userId ?? '').trim();
    if (!userId) throw new UnauthorizedException('user not authenticated');
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listMyOrganizations({ user_id: userId }, md) as never,
    )) as { list?: Record<string, unknown>[] };
    const first = Array.isArray(r.list) ? r.list[0] : undefined;
    return first ? mapOrganization(first) : null;
  }

  @Get('system/requisites')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  async getOrganization(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const res = (await grpcBffCall(
      this.organization.getOrganization(
        { id: this.sysOrgId(req), user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapOrganization(res);
  }

  @Patch('system/requisites')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  async updateOrganization(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { name?: string; logoUrl?: string } & OrgRequisitesBody,
  ) {
    const md = this.outboundMeta.build(req);
    const res = (await grpcBffCall(
      this.organization.updateOrganization(
        {
          id: this.sysOrgId(req),
          actor_user_id: req.user?.userId ?? '',
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...toGrpcRequisites(body),
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapOrganization(res);
  }

  @Post('system/logo-upload-url')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  async createLogoUploadUrl(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body()
    body: { contentType?: string; fileName?: string; contentLength?: number },
  ) {
    const orgId = this.sysOrgId(req);
    const presigned = await this.orgLogoStorage.createPresignedUpload({
      organizationId: orgId,
      contentType: body.contentType,
      fileName: body.fileName,
      contentLength: body.contentLength,
    });
    return {
      uploadUrl: presigned.uploadUrl,
      logoUrl: presigned.logoUrl,
      objectKey: presigned.objectKey,
      expiresAt: presigned.expiresAt,
    };
  }

  // ─── Org structure: employees ───────────────────────────────────────────

  @Get('system/employees')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  @RequireOrgStructurePermission('org:employees', 'read')
  async listEmployees(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listEmployees(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    const base = (Array.isArray(r.list) ? r.list : []).map(mapEmployee);
    return this.enrichWithIdentity(req, base);
  }

  /**
   * FR-ORG-150: colleague directory — name, photo, position, manager/department;
   * no email/phone/role (PII-safe contract).
   */
  @Get('system/colleagues')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  @RequireOrgStructurePermission('org:employees', 'read')
  async listColleagueDirectory(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listColleagueDirectory(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    const base = (Array.isArray(r.list) ? r.list : []).map((row) => ({
      userId: (row.user_id ?? row.userId ?? '') as string,
      departmentId: (row.department_id ?? row.departmentId ?? '') as string,
      departmentName: (row.department_name ?? row.departmentName ?? '') as string,
      managerUserId: (row.manager_user_id ?? row.managerUserId ?? '') as string,
    }));
    return this.enrichColleagueDirectory(req, base);
  }

  @Post('system/employees')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async addEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { userId?: string; role?: string; departmentId?: string },
  ) {
    if (!body.userId) throw new BadRequestException('userId required');
    const md = this.outboundMeta.build(req);
    const e = (await grpcBffCall(
      this.organization.addEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: body.userId,
          role: body.role,
          department_id: body.departmentId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const [enriched] = await this.enrichWithIdentity(req, [mapEmployee(e)]);
    invalidateSystemAccessCache(body.userId);
    return enriched;
  }

  @Patch('system/employees/:userId')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async updateEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
    @Body() body: { role?: string; departmentId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const e = (await grpcBffCall(
      this.organization.updateEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          role: body.role,
          department_id: body.departmentId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const [enriched] = await this.enrichWithIdentity(req, [mapEmployee(e)]);
    invalidateSystemAccessCache(userId);
    return enriched;
  }

  @Delete('system/employees/:userId')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async removeEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.organization.removeEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
    invalidateSystemAccessCache(userId);
    return { ok: true };
  }

  // ─── Employee offboard lifecycle (FR-MORG-43 / OQ-MORG-5) ────────────────
  // Owner/admin only (enforced fail-closed in control). Deactivate frees the
  // seat (isActive=false); reactivate re-takes a seat → 402 seat_limit if full.

  @Post('system/employees/:userId/deactivate')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async deactivateEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req);
    const e = (await grpcBffCall(
      this.organization.deactivateEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const [enriched] = await this.enrichWithIdentity(req, [mapEmployee(e)]);
    invalidateSystemAccessCache(userId);
    return enriched;
  }

  @Post('system/employees/:userId/reactivate')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async reactivateEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req);
    const e = (await grpcBffCall(
      this.organization.reactivateEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const [enriched] = await this.enrichWithIdentity(req, [mapEmployee(e)]);
    return enriched;
  }

  // Offboard (SCR-MORG-EMPLOYEE-OFFBOARD) — the full deactivation cascade run in
  // control: soft-delete + revoke ALL project access + kill live auth sessions
  // (BX-OFFB, security HIGH / 152-ФЗ). Same effect and owner-guard as `deactivate`
  // but named for the offboard wizard, returning the wizard's result shape.
  // BX-OFFB-2: control now also emits a per-project `control.member.offboarded`
  // event so the Mongo CRM domains reassign the leaver's records to
  // `reassignToUserId` (empty → the acting admin). That cascade is EVENTUAL, so
  // exact counts aren't known synchronously → `processing: true` and the counters
  // stay 0 (the FE surfaces the background transfer).
  @Post('system/employees/:userId/offboard')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async offboardEmployee(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
    @Body() body: { reassignToUserId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.organization.deactivateEmployee(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
          reassign_to_user_id: (body?.reassignToUserId ?? '').trim(),
        },
        md,
      ) as never,
    );
    invalidateSystemAccessCache(userId);
    return { reassigned: 0, unassigned: 0, processing: true };
  }

  // ─── Transfer ownership ──────────────────────────────────────────────────
  // Owner-only hand-off. The gateway 'manage' gate is defense-in-depth; control
  // re-checks that the caller is the CURRENT platform_owner (fail-closed) and
  // performs the atomic old-owner→admin / target→owner swap. Symmetric to the
  // org (de)activation routes which are also owner-only in control.

  @Post('system/transfer-ownership')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:profile', 'manage')
  async transferOwnership(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { newOwnerUserId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const e = (await grpcBffCall(
      this.organization.transferOwnership(
        {
          organization_id: this.sysOrgId(req),
          new_owner_user_id: body.newOwnerUserId ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const [enriched] = await this.enrichWithIdentity(req, [mapEmployee(e)]);
    invalidateSystemAccessCache(req.user?.userId);
    if (body.newOwnerUserId) invalidateSystemAccessCache(body.newOwnerUserId);
    return enriched;
  }

  // ─── Seats / licenses ────────────────────────────────────────────────────
  // DEORG-W3: box is single-tenant with no billing/seats/licences — the
  // `/organizations/:orgId/seats` BFF route and its `getOrgSeats` client binding
  // are removed. control's SeatsService stays neutered (unlimited) and its
  // `GetOrgSeats` RPC / `org:seats` catalog entry are left for the Stage-2 sweep
  // (plan §8), per the SINGLETON rule that does not rename/drop `org:*` literals.

  /**
   * P8-T4.3: org-structure permission projection for the FE gating — the org
   * counterpart of `GET /projects/:projectId/permissions`. Any active member may
   * read their OWN effective org-structure rights (@RequireSystemRole('member')); the
   * `allowed[]` is the PDP allow-set (org:* keys). The FE caches this itself, so no
   * gateway-side cache — the SystemAccessGuard's short-TTL role cache already bounds
   * the per-request control cost. Reshapes keepCase gRPC → the FE contract.
   */
  @Get('system/me/permissions')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  async orgPermissionProjection(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const res = (await grpcBffCall(
      this.organization.getOrgPermissionProjection(
        { organization_id: this.sysOrgId(req), user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { allowed?: string[]; org_role?: string; orgRole?: string; is_member?: boolean };
    return {
      organizationId: this.sysOrgId(req),
      orgRole: res.org_role ?? res.orgRole ?? '',
      allowed: res.allowed ?? [],
    };
  }

  /**
   * P8-T6.2 (SCR-MORG-MY-MEMBERSHIP, FR-MORG-30/37): the caller's own membership
   * context — org role, department + leader, org-owned projects, active flag. Any
   * active member reads their OWN data (@RequireSystemRole('member')); the subject is
   * always the gateway-verified x-user-id (control ignores any body userId). The
   * leader's display name is resolved here via the identity directory. The
   * `reassignedToMe` indicator is omitted — record ownership lives in the Mongo CRM
   * domains, out of this control-only snapshot's scope.
   */
  @Get('system/me')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  async getMyMembership(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const m = (await grpcBffCall(
      this.organization.getMyMembership(
        { organization_id: this.sysOrgId(req), user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as {
      is_member?: boolean;
      user_id?: string;
      role?: string;
      is_active?: boolean;
      department_id?: string;
      department_name?: string;
      leader_user_id?: string;
      projects?: { project_id?: string; project_name?: string }[];
    };
    const leaderUserId = (m.leader_user_id ?? '').trim();
    let leaderName: string | null = null;
    if (leaderUserId) {
      const [enriched] = await this.enrichWithIdentity(req, [{ userId: leaderUserId }]);
      leaderName = enriched?.name || null;
    }
    return {
      userId: m.user_id ?? req.user?.userId ?? '',
      role: m.role ?? '',
      departmentId: (m.department_id || null) as string | null,
      departmentName: (m.department_name || null) as string | null,
      leaderName,
      projects: (m.projects ?? []).map((p) => ({
        projectId: p.project_id ?? '',
        projectName: p.project_name ?? '',
      })),
      isActive: (m.is_active ?? false) as boolean,
    };
  }

  /**
   * P8-T6.2 (SCR-MORG-EMPLOYEE-OFFBOARD preview, FR-MORG-25): dry-run of an
   * employee offboard — the org-owned projects the target loses access to + owner
   * guard. Manage-gated (owner/admin action; control re-checks `org:employees`).
   * Per-project record reassignment counts are NOT computed here (Mongo CRM domains,
   * out of scope) → `partial: true` and empty `reassign[]`.
   */
  @Get('system/employees/:userId/offboard/preview')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:employees', 'manage')
  async previewOffboard(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.previewOffboard(
        {
          organization_id: this.sysOrgId(req),
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as {
      user_id?: string;
      is_owner?: boolean;
      projects?: { project_id?: string; project_name?: string }[];
      partial?: boolean;
    };
    return {
      userId: r.user_id ?? userId,
      isOwner: (r.is_owner ?? false) as boolean,
      projects: (r.projects ?? []).map((p) => ({
        projectId: p.project_id ?? '',
        projectName: p.project_name ?? '',
      })),
      // Reassignment counts live in the Mongo CRM domains — not computed here.
      reassign: [] as { projectId: string; projectName?: string; recordCount: number }[],
      partial: (r.partial ?? true) as boolean,
    };
  }

  // ─── Reorg preview (FR-MORG-21/-13, dry-run) ─────────────────────────────

  @Post('system/reorg/preview')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:departments', 'manage')
  async previewReorg(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { departmentId?: string; targetParentId?: string | null },
  ) {
    if (!body.departmentId) throw new BadRequestException('departmentId required');
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.previewReorg(
        {
          organization_id: this.sysOrgId(req),
          department_id: body.departmentId,
          target_parent_id: body.targetParentId ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return {
      organizationId: r.organization_id ?? this.sysOrgId(req),
      departmentId: r.department_id,
      departmentName: r.department_name,
      currentParentId: (r.current_parent_id || null) as string | null,
      targetParentId: (r.target_parent_id || null) as string | null,
      affectedDepartmentCount: r.affected_department_count ?? 0,
      affectedDepartmentIds: r.affected_department_ids ?? [],
      affectedEmployeeCount: r.affected_employee_count ?? 0,
      valid: (r.valid ?? false) as boolean,
      issues: r.issues ?? [],
    };
  }

  // ─── Organization deactivate / reactivate (FR-MORG-43, owner only) ───────

  @Post('system/deactivate')
  @ApiTags('Organizations')
  @RequireSystemRole('owner')
  async deactivateOrganization(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    return grpcBffCall(
      this.organization.deactivateOrganization(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
  }

  @Post('system/reactivate')
  @ApiTags('Organizations')
  @RequireSystemRole('owner')
  async reactivateOrganization(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    return grpcBffCall(
      this.organization.reactivateOrganization(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
  }

  // ─── Org structure: departments ─────────────────────────────────────────

  @Get('system/departments')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  @RequireOrgStructurePermission('org:departments', 'read')
  async listDepartments(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listDepartments(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    return (Array.isArray(r.list) ? r.list : []).map(mapDepartment);
  }

  @Post('system/departments')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:departments', 'manage')
  async createDepartment(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { name?: string; parentId?: string; leaderUserId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const d = (await grpcBffCall(
      this.organization.createDepartment(
        {
          organization_id: this.sysOrgId(req),
          name: body.name,
          parent_id: body.parentId,
          leader_user_id: body.leaderUserId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapDepartment(d);
  }

  // NB: /departments/:deptId is keyed by department id — the SystemAccessGuard
  // gates by system role (member/manage) not by a nested entity, so this route is
  // intentionally NOT @RequireSystemRole-annotated and passes through the gateway;
  // control's assertCanManage (owner/admin) remains authoritative.
  @Patch('departments/:deptId')
  @ApiTags('Organizations')
  @MembershipOnly()
  async updateDepartment(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
    @Body() body: { name?: string; parentId?: string; leaderUserId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const d = (await grpcBffCall(
      this.organization.updateDepartment(
        {
          id: deptId,
          name: body.name,
          parent_id: body.parentId,
          leader_user_id: body.leaderUserId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    invalidateSystemAccessCache();
    return mapDepartment(d);
  }

  @Delete('departments/:deptId')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:departments', 'manage')
  async deleteDepartment(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
    @Query('strategy') strategy?: string,
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.organization.deleteDepartment(
        { id: deptId, actor_user_id: req.user?.userId ?? '', strategy: strategy ?? '' },
        md,
      ) as never,
    );
    invalidateSystemAccessCache();
    return { ok: true };
  }

  // ─── Department→project bindings (FR-MORG-7/8/9/10/11) ─────────────────────
  // Under /system/departments/:deptId so the SystemAccessGuard gates by system role
  // (read=member, manage=owner/admin); control resolves the system anchor itself for
  // its isolation check + `org:bindings` PDP gate (defense-in-depth).

  @Get('system/departments/:deptId/bindings')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  @RequireOrgStructurePermission('org:bindings', 'read')
  async listDepartmentBindings(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
  ) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listDepartmentBindings(
        {
          organization_id: this.sysOrgId(req),
          department_id: deptId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    return (Array.isArray(r.list) ? r.list : []).map(mapBinding);
  }

  @Post('system/departments/:deptId/bindings')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:bindings', 'manage')
  async createDepartmentBinding(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
    @Body() body: { projectId?: string; defaultRole?: string; scope?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const b = (await grpcBffCall(
      this.organization.createDepartmentBinding(
        {
          organization_id: this.sysOrgId(req),
          department_id: deptId,
          project_id: body.projectId ?? '',
          default_role: body.defaultRole ?? '',
          scope: body.scope ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapBinding(b);
  }

  @Patch('system/departments/:deptId/bindings/:bindingId')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:bindings', 'manage')
  async updateDepartmentBinding(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
    @Param('bindingId') bindingId: string,
    @Body() body: { defaultRole?: string; scope?: string; status?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const b = (await grpcBffCall(
      this.organization.updateDepartmentBinding(
        {
          organization_id: this.sysOrgId(req),
          department_id: deptId,
          id: bindingId,
          default_role: body.defaultRole ?? '',
          scope: body.scope ?? '',
          status: body.status ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapBinding(b);
  }

  @Delete('system/departments/:deptId/bindings/:bindingId')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:bindings', 'manage')
  async deleteDepartmentBinding(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('deptId') deptId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.organization.deleteDepartmentBinding(
        {
          organization_id: this.sysOrgId(req),
          department_id: deptId,
          id: bindingId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
    return { ok: true };
  }

  // ─── E2-06 Access Units / Groups ──────────────────────────────────────────
  // scope = ORGANIZATION (scopeId=orgId) | PROJECT (scopeId=projectId). The
  // resolver/guard enforce isolation; the gateway only relays actor identity.
  //
  // SystemAccessGuard note (P8-T3.1): access-unit routes are NOT @RequireSystemRole-
  // annotated on purpose. They are DUAL-SCOPED (scopeType/scopeId in query, or a
  // :unitId in the path) — a blanket "system owner/admin" gate would
  // be wrong for PROJECT-scoped units (which control gates at manager+ via
  // assertCanManageScope). Enforcement stays in control, which sees the unit's
  // real scope; adding it here would need a per-request lookup and duplicate that
  // scope logic at the edge. Left to control (still fail-closed there).

  @Get('access-units')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async listAccessUnits(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('scopeType') scopeType: string,
    @Query('scopeId') scopeId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    if (!scopeType || !scopeId) throw new BadRequestException('scopeType and scopeId required');
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.accessUnit.listAccessUnits(
        {
          scope_type: scopeType,
          scope_id: scopeId,
          actor_user_id: req.user?.userId ?? '',
          include_archived: includeArchived === 'true',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    return (Array.isArray(r.list) ? r.list : []).map(mapAccessUnit);
  }

  @Post('access-units')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async createAccessUnit(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body()
    body: {
      scopeType?: string;
      scopeId?: string;
      name?: string;
      kind?: string;
      parentId?: string;
      leaderUserId?: string;
    },
  ) {
    if (!body.scopeType || !body.scopeId) {
      throw new BadRequestException('scopeType and scopeId required');
    }
    if (!body.name) throw new BadRequestException('name required');
    const md = this.outboundMeta.build(req);
    const u = (await grpcBffCall(
      this.accessUnit.createAccessUnit(
        {
          scope_type: body.scopeType,
          scope_id: body.scopeId,
          name: body.name,
          kind: body.kind,
          parent_id: body.parentId,
          leader_user_id: body.leaderUserId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapAccessUnit(u);
  }

  @Patch('access-units/:unitId')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async updateAccessUnit(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Body() body: { name?: string; kind?: string; leaderUserId?: string },
  ) {
    const md = this.outboundMeta.build(req);
    const u = (await grpcBffCall(
      this.accessUnit.updateAccessUnit(
        {
          id: unitId,
          name: body.name,
          kind: body.kind,
          leader_user_id: body.leaderUserId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapAccessUnit(u);
  }

  @Put('access-units/:unitId/parent')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async setAccessUnitParent(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Body() body: { parentId?: string | null },
  ) {
    const md = this.outboundMeta.build(req);
    const u = (await grpcBffCall(
      this.accessUnit.setUnitParent(
        {
          id: unitId,
          parent_id: body.parentId ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapAccessUnit(u);
  }

  @Post('access-units/:unitId/archive')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async archiveAccessUnit(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Body() body: { archived?: boolean },
  ) {
    const md = this.outboundMeta.build(req);
    const u = (await grpcBffCall(
      this.accessUnit.archiveAccessUnit(
        {
          id: unitId,
          archived: body.archived ?? true,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapAccessUnit(u);
  }

  @Get('access-units/:unitId/members')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async listAccessUnitMembers(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
  ) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.accessUnit.listUnitMembers(
        { unit_id: unitId, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    return (Array.isArray(r.list) ? r.list : []).map(mapAccessUnitMember);
  }

  @Post('access-units/:unitId/members')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async addAccessUnitMember(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Body() body: { memberType?: string; memberId?: string },
  ) {
    if (!body.memberId) throw new BadRequestException('memberId required');
    const md = this.outboundMeta.build(req);
    const m = (await grpcBffCall(
      this.accessUnit.addUnitMember(
        {
          unit_id: unitId,
          member_type: body.memberType ?? 'user',
          member_id: body.memberId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapAccessUnitMember(m);
  }

  @Delete('access-units/:unitId/members/:memberType/:memberId')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async removeAccessUnitMember(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Param('memberType') memberType: string,
    @Param('memberId') memberId: string,
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.accessUnit.removeUnitMember(
        {
          unit_id: unitId,
          member_type: memberType,
          member_id: memberId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
    return { ok: true };
  }

  /**
   * §7.2 composition preview — the EFFECTIVE user count of a unit's composition,
   * optionally with a candidate nested group applied, so the UI can show "состав
   * вырастет N→M" BEFORE the add is persisted. Pure read (no mutation).
   */
  @Get('access-units/:unitId/composition-preview')
  @ApiTags('AccessUnits')
  @MembershipOnly()
  async previewAccessUnitComposition(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('unitId') unitId: string,
    @Query('addGroupId') addGroupId?: string,
  ) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.accessUnit.previewUnitComposition(
        {
          unit_id: unitId,
          add_group_id: addGroupId ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return {
      currentUserCount: Number(r.current_user_count ?? 0),
      projectedUserCount: Number(r.projected_user_count ?? 0),
      addedUserCount: Number(r.added_user_count ?? 0),
      crossScopeDropped: Number(r.cross_scope_dropped ?? 0),
    };
  }

  // ─── Org structure: invitations ─────────────────────────────────────────

  private buildInvitationAcceptUrl(raw: Record<string, unknown>): string | null {
    const token = raw.token as string | undefined;
    if (!token) return null;
    return `${this.config.appPublicUrl}/auth/invite/${encodeURIComponent(token)}`;
  }

  private buildProjectInvitationAcceptUrl(raw: Record<string, unknown>): string | null {
    const token = raw.token as string | undefined;
    if (!token) return null;
    return `${this.config.appPublicUrl}/auth/project-invite/${encodeURIComponent(token)}`;
  }

  private async sendProjectInvitationEmail(
    req: FastifyRequest & { user?: { userId?: string } },
    raw: Record<string, unknown>,
  ): Promise<boolean> {
    const token = raw.token as string | undefined;
    const email = ((raw.email ?? '') as string).trim();
    if (!token || !email) return false;
    const acceptUrl = this.buildProjectInvitationAcceptUrl(raw);
    if (!acceptUrl) return false;
    try {
      const md = this.outboundMeta.build(req);
      const outcome = (await grpcBffCall(
        this.notification.sendTransactionalEmail(
          {
            to: email,
            kind: 'project_invitation',
            action_url: acceptUrl,
          },
          md,
        ) as never,
      )) as { status?: string; error?: string };
      return outcome?.status === 'sent';
    } catch {
      return false;
    }
  }

  /**
   * Best-effort invitation email for a "cold" invite (the invitee may not have an
   * account yet, so there is NO user_id). Routed through the notification domain's
   * transactional-email RPC — the same project-less SMTP path auth uses for
   * verify-email / password-reset — because the in-app `Send` RPC requires
   * project_id+user_id and cannot address a raw external address.
   *
   * Never fails the HTTP request (the invitation itself is already persisted), but
   * delivery is NOT silently swallowed: returns `true`/`false` so the caller can
   * surface `emailSent` and logs a visible error on failure.
   */
  private async sendInvitationEmail(
    req: FastifyRequest & { user?: { userId?: string } },
    raw: Record<string, unknown>,
  ): Promise<boolean> {
    const token = raw.token as string | undefined;
    const email = ((raw.email ?? '') as string).trim();
    if (!token || !email) {
      this.logger.error(
        `Invitation email skipped — missing ${!token ? 'token' : 'email'} (invitation id=${String(raw.id ?? '')})`,
      );
      return false;
    }
    const acceptUrl = this.buildInvitationAcceptUrl(raw);
    if (!acceptUrl) return false;
    try {
      const md = this.outboundMeta.build(req);
      const outcome = (await grpcBffCall(
        this.notification.sendTransactionalEmail(
          {
            to: email,
            kind: 'org_invitation',
            action_url: acceptUrl,
          },
          md,
        ) as never,
      )) as { status?: string; error?: string };
      const sent = outcome?.status === 'sent';
      if (!sent) {
        this.logger.error(
          `Invitation email to ${email} not delivered (status=${outcome?.status ?? 'unknown'}` +
            `${outcome?.error ? `, error=${outcome.error}` : ''})`,
        );
      }
      return sent;
    } catch (e) {
      this.logger.error(`Invitation email to ${email} failed: ${(e as Error).message}`);
      return false;
    }
  }

  @Get('system/invitations')
  @ApiTags('Organizations')
  // Invitations expose invitee PII (emails) → owner/admin only, matching control's
  // assertCanManage on the read path (NOT the "any member" structure-read default).
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:invitations', 'manage')
  async listInvitations(@Req() req: FastifyRequest & { user?: { userId?: string } }) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listInvitations(
        { organization_id: this.sysOrgId(req), actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[] };
    return (Array.isArray(r.list) ? r.list : []).map(mapInvitation);
  }

  @Post('system/invitations')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:invitations', 'manage')
  async createInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body()
    body: {
      email?: string;
      role?: string;
      departmentId?: string;
      // onboarding wizard step 4 (FR-ONB-10): [{ projectId, role }] (project role).
      projectGrants?: { projectId?: string; role?: string }[];
    },
  ) {
    if (!body.email?.trim()) throw new BadRequestException('email required');
    const md = this.outboundMeta.build(req);
    const projectGrants = (Array.isArray(body.projectGrants) ? body.projectGrants : [])
      .map((g) => ({ project_id: (g.projectId ?? '').trim(), role: (g.role ?? '').trim() }))
      .filter((g) => g.project_id);
    const raw = (await grpcBffCall(
      this.organization.createInvitation(
        {
          organization_id: this.sysOrgId(req),
          email: body.email.trim(),
          role: body.role,
          department_id: body.departmentId,
          invited_by_user_id: req.user?.userId ?? '',
          actor_user_id: req.user?.userId ?? '',
          project_grants: projectGrants,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const emailSent = await this.sendInvitationEmail(req, raw);
    const inviteUrl = this.buildInvitationAcceptUrl(raw);
    return { ...mapInvitation(raw), emailSent, ...(inviteUrl ? { inviteUrl } : {}) };
  }

  @Post('system/invitations/:id/resend')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:invitations', 'manage')
  async resendInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
  ) {
    const md = this.outboundMeta.build(req);
    const raw = (await grpcBffCall(
      this.organization.resendInvitation(
        { id, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    )) as Record<string, unknown>;
    const emailSent = await this.sendInvitationEmail(req, raw);
    const inviteUrl = this.buildInvitationAcceptUrl(raw);
    return { ...mapInvitation(raw), emailSent, ...(inviteUrl ? { inviteUrl } : {}) };
  }

  @Delete('system/invitations/:id')
  @ApiTags('Organizations')
  @RequireSystemRole('manage')
  @RequireOrgStructurePermission('org:invitations', 'manage')
  async revokeInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
  ) {
    const md = this.outboundMeta.build(req);
    await grpcBffCall(
      this.organization.revokeInvitation(
        { id, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
    return { ok: true };
  }

  // ─── Org audit ──────────────────────────────────────────────────────────

  @Get('system/audit')
  @ApiTags('Organizations')
  // FR-ORG-600: leaders with `org:audit:read` may read their subtree; control PDP
  // enforces scope — gateway only requires membership.
  @RequireSystemRole('member')
  @RequireOrgStructurePermission('org:audit', 'read')
  async listOrgAudit(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('entityType') entityType?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.organization.listOrgAudit(
        {
          organization_id: this.sysOrgId(req),
          actor_user_id: req.user?.userId ?? '',
          limit: parseInt(limit ?? '100', 10),
          cursor: cursor ?? '',
          filter_entity_type: entityType ?? '',
          filter_actor_user_id: actorUserId ?? '',
          from_ts: from ?? '',
          to_ts: to ?? '',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; next_cursor?: string; nextCursor?: string };
    const base = (Array.isArray(r.list) ? r.list : []).map(mapAuditEntry);
    const enriched = await this.enrichWithIdentity(req, base);
    return {
      list: enriched,
      nextCursor: (r.next_cursor ?? r.nextCursor ?? '') as string,
    };
  }

  @Get('system/departments/:departmentId/summary')
  @ApiTags('Organizations')
  @RequireSystemRole('member')
  async getDepartmentSummary(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('departmentId') departmentId: string,
    @Query('projectId') projectId?: string,
  ) {
    const md = this.outboundMeta.build(req);
    const summary = (await grpcBffCall(
      this.organization.getDepartmentSummary(
        {
          organization_id: this.sysOrgId(req),
          department_id: departmentId,
          actor_user_id: req.user?.userId ?? '',
          project_id: projectId ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    let unassigned = Number(summary.unassigned_records_count ?? 0);
    if (projectId) {
      const un = (await grpcBffCall(
        this.search.listUnassigned(
          { project_id: projectId, resource: 'all', limit: 1 },
          this.outboundMeta.build(req, { projectId }),
        ) as never,
      )) as { total?: number };
      unassigned = Number(un.total ?? 0);
    }
    return {
      employeeCount: Number(summary.employee_count ?? 0),
      activeSeats: Number(summary.active_seats ?? 0),
      pendingInvitations: Number(summary.pending_invitations ?? 0),
      unassignedRecordsCount: unassigned,
    };
  }

  @Get('projects/:projectId/unassigned')
  @ApiTags('Organizations')
  @RequirePermission('project', 'manage')
  async listUnassignedRecords(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Query('resource') resource?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.search.listUnassigned(
        {
          project_id: projectId,
          resource: resource ?? 'all',
          limit: parseInt(limit ?? '50', 10),
          cursor: cursor ?? '',
        },
        md,
      ) as never,
    )) as {
      list?: Array<Record<string, unknown>>;
      next_cursor?: string;
      total?: number;
    };
    const list = (Array.isArray(r.list) ? r.list : []).map((row) => ({
      entityType: row.entity_type ?? row.entityType,
      entityId: row.entity_id ?? row.entityId,
      title: row.title,
      updatedAt: row.updated_at ?? row.updatedAt,
    }));
    return {
      list,
      nextCursor: (r.next_cursor ?? '') as string,
      total: Number(r.total ?? list.length),
    };
  }

  @Post('projects/:projectId/unassigned/bulk-reassign')
  @ApiTags('Organizations')
  @RequirePermission('project', 'manage')
  async bulkReassignUnassigned(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      newOwnerUserId?: string;
      items?: Array<{ entityType?: string; entityId?: string }>;
    },
  ) {
    const to = (body.newOwnerUserId ?? '').trim();
    if (!to) throw new BadRequestException('newOwnerUserId is required');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new BadRequestException('items is required');
    const md = this.outboundMeta.build(req, { projectId });
    let reassigned = 0;
    const skipped: Array<{ entityType: string; entityId: string; reason: string }> = [];
    for (const item of items) {
      const entityType = String(item.entityType ?? '').toLowerCase();
      const entityId = String(item.entityId ?? '').trim();
      if (!entityId) {
        skipped.push({
          entityType: entityType || 'unknown',
          entityId: '',
          reason: 'missing_entity_id',
        });
        continue;
      }
      if (entityType === 'contact') {
        await grpcBffCall(
          this.contact.reassignContacts(
            { project_id: projectId, contact_ids: [entityId], new_owner_id: to },
            md,
          ) as never,
        );
        reassigned += 1;
      } else if (entityType === 'deal') {
        await grpcBffCall(
          this.pipe.updateDeal(
            { project_id: projectId, id: entityId, assignee_id: to },
            md,
          ) as never,
        );
        reassigned += 1;
      } else if (entityType === 'order') {
        await grpcBffCall(
          this.orders.updateOrder(
            { project_id: projectId, id: entityId, assignee_id: to },
            md,
          ) as never,
        );
        reassigned += 1;
      } else if (entityType === 'company') {
        await grpcBffCall(
          this.company.updateOwner(
            { project_id: projectId, id: entityId, owner_id: to },
            md,
          ) as never,
        );
        reassigned += 1;
      } else if (entityType === 'activity') {
        await grpcBffCall(
          this.activity.updateActivity(
            { project_id: projectId, id: entityId, assignee_id: to },
            md,
          ) as never,
        );
        reassigned += 1;
      } else if (entityType === 'document' || entityType === 'documents') {
        // Documents domain has bulk offboard reassign only — no per-record owner RPC yet.
        skipped.push({ entityType, entityId, reason: 'no_owner_update_rpc' });
      } else {
        skipped.push({
          entityType: entityType || 'unknown',
          entityId,
          reason: 'unsupported_entity_type',
        });
      }
    }
    return { reassigned, skipped, processing: false };
  }

  // ─── Public invitation accept (no JWT — invitee may have no account yet) ──

  @Public()
  @SkipProjectScope()
  @Get('invitations/:token')
  @ApiTags('Organizations')
  async getInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('token') token: string,
  ) {
    const md = this.outboundMeta.build(req);
    const d = (await grpcBffCall(
      this.organization.getInvitation({ token }, md) as never,
    )) as Record<string, unknown>;
    let userExists = false;
    try {
      const u = (await grpcBffCall(this.auth.getUserByEmail({ email: d.email }, md) as never)) as {
        found?: boolean;
      };
      userExists = u?.found === true;
    } catch {
      // Identity lookup is best-effort; default to treating the invitee as new.
    }
    return {
      organizationId: d.organization_id,
      organizationName: d.organization_name,
      email: d.email,
      role: d.role,
      status: d.status,
      expired: d.expired === true,
      userExists,
      // FR-ONB-10: project access this invite grants (for the accept-screen
      // "you'll join project Y" context). No bearer token surfaced.
      projectGrants: mapProjectGrants(d.project_grants),
    };
  }

  @Public()
  @SkipProjectScope()
  @UseGuards(AuthPublicThrottleGuard)
  @AuthPublicThrottle({
    ...AUTH_PUBLIC_HOURLY_5,
    extraKeys: (req) => {
      const token = String(req.body?.token ?? '').trim();
      return token ? [`invite-accept:token:${token.slice(0, 16)}`] : [];
    },
  })
  @Post('invitations/accept')
  @ApiTags('Organizations')
  async acceptInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { token?: string; name?: string; password?: string },
  ) {
    const token = body.token?.trim();
    if (!token) throw new BadRequestException('token required');
    const md = this.outboundMeta.build(req);

    const d = (await grpcBffCall(
      this.organization.getInvitation({ token }, md) as never,
    )) as Record<string, unknown>;
    if (d.status !== 'pending' || d.expired === true) {
      throw new BadRequestException('Invitation is no longer valid');
    }

    try {
      const u = (await grpcBffCall(this.auth.getUserByEmail({ email: d.email }, md) as never)) as {
        found?: boolean;
        user?: { id?: string };
      };
      if (u?.found === true) {
        const jwtUserId = req.user?.userId?.trim();
        const existingId = u?.user?.id?.trim();
        if (!jwtUserId || !existingId || jwtUserId !== existingId) {
          throw new UnauthorizedException('Sign in as the invited user to accept this invitation');
        }
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      // Fail-closed: an unreachable directory must not skip the JWT gate
      // and let a third party accept on behalf of an existing account.
      throw new ServiceUnavailableException('Could not verify invitee identity');
    }

    // Provision (or resolve) the auth user by the *invitation* email — never a
    // client-supplied address — then finalize the membership in control.
    const prov = (await grpcBffCall(
      this.auth.provisionUser(
        { email: d.email, name: body.name ?? '', password: body.password ?? '' },
        md,
      ) as never,
    )) as { user?: { id?: string }; created?: boolean };
    const userId = prov?.user?.id;
    if (!userId) throw new BadRequestException('Could not resolve the invited user');
    // Authoritative FR-AUTH-320 gate: provisionUser is the identity source.
    // If the account already existed, require the matching session even when
    // the pre-check saw found=false (lookup race / stale directory).
    if (prov?.created !== true) {
      const jwtUserId = req.user?.userId?.trim();
      if (!jwtUserId || jwtUserId !== userId) {
        throw new UnauthorizedException('Sign in as the invited user to accept this invitation');
      }
    }

    const r = (await grpcBffCall(
      this.organization.acceptInvitation({ token, user_id: userId }, md) as never,
    )) as Record<string, unknown>;
    // FR-ONB-10: projects the accepter just joined → FE lands on /p/<projectId>
    // (not the §4.5 "no projects" stub). project role kept for the landing UI.
    const projectGrants = mapProjectGrants(r.project_grants);
    return {
      ok: true,
      organizationId: r.organization_id,
      created: prov?.created === true,
      projectGrants,
      // convenience: first granted project for the landing redirect (FR-ONB-1).
      landingProjectId: projectGrants[0]?.projectId ?? null,
    };
  }

  @Public()
  @SkipProjectScope()
  @Get('project-invitations/:token')
  @ApiTags('Projects')
  async getProjectInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('token') token: string,
  ) {
    const md = this.outboundMeta.build(req);
    const d = (await grpcBffCall(
      this.project.getProjectInvitation({ token }, md) as never,
    )) as Record<string, unknown>;
    let userExists = false;
    try {
      const u = (await grpcBffCall(this.auth.getUserByEmail({ email: d.email }, md) as never)) as {
        found?: boolean;
      };
      userExists = u?.found === true;
    } catch {
      // best-effort
    }
    return {
      projectId: d.project_id,
      projectName: d.project_name,
      email: d.email,
      role: d.role,
      status: d.status,
      expired: d.expired === true,
      userExists,
    };
  }

  @Public()
  @SkipProjectScope()
  @Post('project-invitations/accept')
  @ApiTags('Projects')
  async acceptProjectInvitation(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: { token?: string; name?: string; password?: string },
  ) {
    const token = body.token?.trim();
    if (!token) throw new BadRequestException('token required');
    const md = this.outboundMeta.build(req);
    const d = (await grpcBffCall(
      this.project.getProjectInvitation({ token }, md) as never,
    )) as Record<string, unknown>;
    if (d.status !== 'pending' || d.expired === true) {
      throw new BadRequestException('Invitation is no longer valid');
    }
    try {
      const u = (await grpcBffCall(this.auth.getUserByEmail({ email: d.email }, md) as never)) as {
        found?: boolean;
        user?: { id?: string };
      };
      if (u?.found === true) {
        const jwtUserId = req.user?.userId?.trim();
        const existingId = u?.user?.id?.trim();
        if (!jwtUserId || !existingId || jwtUserId !== existingId) {
          throw new UnauthorizedException('Sign in as the invited user to accept this invitation');
        }
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new ServiceUnavailableException('Could not verify invitee identity');
    }
    const prov = (await grpcBffCall(
      this.auth.provisionUser(
        { email: d.email, name: body.name ?? '', password: body.password ?? '' },
        md,
      ) as never,
    )) as { user?: { id?: string }; created?: boolean };
    const userId = prov?.user?.id;
    if (!userId) throw new BadRequestException('Could not resolve the invited user');
    if (prov?.created !== true) {
      const jwtUserId = req.user?.userId?.trim();
      if (!jwtUserId || jwtUserId !== userId) {
        throw new UnauthorizedException('Sign in as the invited user to accept this invitation');
      }
    }
    const r = (await grpcBffCall(
      this.project.acceptProjectInvitation({ token, user_id: userId }, md) as never,
    )) as Record<string, unknown>;
    return {
      ok: true,
      projectId: r.project_id,
      projectName: r.project_name,
      role: r.role,
      landingProjectId: r.project_id,
      created: prov?.created === true,
    };
  }

  @Post('projects')
  @ApiTags('Projects')
  // T-001-BE: creating a NEW project has no existing-project context. The client
  // still sends the ambient x-project-id header (currently-open project, possibly
  // stale/foreign); without this marker ProjectAccessGuard would resolve the
  // caller's membership in THAT project and 403. Owner is taken from the JWT (Д-7)
  // and control is the authority for who may create — no scope is weakened.
  @SkipProjectScope()
  async createProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body()
    body: {
      name?: string;
      templateId?: string;
      modules?: string[];
      moduleConfigs?: Array<{
        moduleId: string;
        enabled: boolean;
        personalSettings?: Record<string, unknown>;
        integrationSettings?: Record<string, unknown>;
        integrationMethodsEnabled?: string[];
      }>;
      modulePolicies?: Array<{
        id: string;
        moduleId: string;
        effect: string;
        subject: string;
        action: string;
        resource: string;
        condition?: Record<string, unknown>;
      }>;
      createdByUserId?: string;
      seedDemoData?: boolean;
    },
  ) {
    const md = this.outboundMeta.build(req);
    // Д-7: владелец создаваемого проекта = аутентифицированный пользователь из
    // JWT, НИКОГДА не из тела (тело — недоверенный вход; иначе можно создать
    // проект «на чужое имя»). Без userId — fail-closed (control тоже отклонит).
    const createdByUserId = req.user?.userId;
    if (!createdByUserId)
      throw new BadRequestException('Authenticated user required to create a project');
    // DEORG-FIX-2: box is single-tenant — the owner is ALWAYS the singleton
    // organization, resolved server-side from the anchor (req.__systemOrgId set by
    // SystemOrgContextGuard). The de-orged FE no longer sends an owner; any
    // body.ownerType/ownerId would be untrusted input, so we ignore it entirely.
    const res = (await grpcBffCall(
      this.project.createProject(
        {
          owner_type: 'organization',
          owner_id: this.sysOrgId(req),
          name: body.name,
          template_id: body.templateId,
          modules: body.modules,
          module_configs: this.toGrpcModuleConfigs(body.moduleConfigs),
          module_policies: this.toGrpcModulePolicies(body.modulePolicies),
          created_by_user_id: createdByUserId,
          seed_demo_data: body.seedDemoData === true,
        },
        md,
      ) as never,
    )) as { id: string; name: string; owner_type?: string; owner_id?: string };
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  @Get('projects/:projectId')
  @ApiTags('Projects')
  @MembershipOnly()
  async getProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const project = await grpcBffCall(this.project.getProject({ id: projectId }, md) as never);
    return decodeGrpcProject(project as Record<string, unknown>);
  }

  @Patch('projects/:projectId')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async updateProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      name?: string;
      modules?: string[];
      moduleConfigs?: Array<{
        moduleId: string;
        enabled: boolean;
        personalSettings?: Record<string, unknown>;
        integrationSettings?: Record<string, unknown>;
        integrationMethodsEnabled?: string[];
      }>;
      modulePolicies?: Array<{
        id: string;
        moduleId: string;
        effect: string;
        subject: string;
        action: string;
        resource: string;
        condition?: Record<string, unknown>;
      }>;
      // Phase 4d: per-project record-visibility config { projectRole: visibilityLevel }.
      visibilityConfig?: Record<string, string>;
      // BX-MODEL-6: access-preset key when this save comes from applying a preset;
      // drives the `preset.applied` audit fact in control (§7.3).
      appliedPreset?: string;
      // FR-PSET-055: explicit cascade when disabling a module with dependents.
      cascade?: boolean;
    },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.project.updateProject(
        {
          id: projectId,
          name: body.name,
          modules: body.modules,
          module_configs: this.toGrpcModuleConfigs(body.moduleConfigs),
          module_policies: this.toGrpcModulePolicies(body.modulePolicies),
          visibility_config: body.visibilityConfig,
          applied_preset: body.appliedPreset,
          cascade: body.cascade === true,
        },
        md,
      ) as never,
    );
    // Bug B/B2 fix: the module guard caches a project's effective modules for 30s.
    // Enabling/disabling a module here must drop that cache so the very next
    // module-gated request (e.g. /products right after toggling products on) sees
    // the new set instead of 403 MODULE_DISABLED for up to the TTL window.
    invalidateModuleCache(projectId);
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  @Get('projects/:projectId/members')
  @ApiTags('Projects')
  @MembershipOnly()
  async members(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.project.listMembers({ project_id: projectId }, md) as never,
    )) as { list: unknown[] };
    return r.list;
  }

  // ─── Project audit (settings → "Аудит" tab). Sensitive project-management
  // data, gated like other project-management surfaces (project:manage). ──────

  @Get('projects/:projectId/audit/events')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async listProjectAudit(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const pageSize = Math.min(parseInt(limit ?? '200', 10), 500);
    const r = (await grpcBffCall(
      this.audit.listEvents(
        { project_id: projectId, page_index: 0, page_size: pageSize },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const base = (Array.isArray(r.list) ? r.list : []).map(mapProjectAuditEntry);
    return this.enrichWithIdentity(req, base);
  }

  // ─── Project membership mutations (WM5, FR-MPRJ-1). Gated by project:manage
  // (owner/admin); ProjectAccessGuard enforces membership; control scopes all
  // mutations by x-project-id and protects the last owner (FR-MPRJ-4). ────────

  @Post('projects/:projectId/members')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async addMember(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body() body: { userId?: string; email?: string; role?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    let userId = body.userId?.trim() ?? '';
    // FR-PROJ-240: never reveal whether an email is registered — uniform accept.
    if (!userId && body.email?.trim()) {
      const email = body.email.trim().toLowerCase();
      const u = (await grpcBffCall(this.auth.getUserByEmail({ email }, md) as never)) as {
        found?: boolean;
        user?: { id?: string };
      };
      if (u?.found && u.user?.id) {
        userId = u.user.id;
      } else {
        const inv = (await grpcBffCall(
          this.project.createProjectInvitation(
            {
              project_id: projectId,
              email,
              role: body.role ?? 'member',
              invited_by_user_id: req.user?.userId ?? '',
              actor_user_id: req.user?.userId ?? '',
            },
            md,
          ) as never,
        )) as Record<string, unknown>;
        const emailSent = await this.sendProjectInvitationEmail(req, inv);
        const inviteUrl = this.buildProjectInvitationAcceptUrl(inv);
        return {
          accepted: true,
          message: 'Если пользователь зарегистрирован в FairFlow, он получит доступ к проекту.',
          invitationId: inv.id,
          emailSent,
          ...(inviteUrl ? { inviteUrl } : {}),
        };
      }
    }
    if (!userId) throw new BadRequestException('userId or email required');
    return grpcBffCall(
      this.project.addMember(
        {
          project_id: projectId,
          user_id: userId,
          role: body.role ?? 'member',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
  }

  @Patch('projects/:projectId/members/:userId')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async updateMemberRole(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { role?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.project.updateMemberRole(
        {
          project_id: projectId,
          user_id: userId,
          role: body.role ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
  }

  @Get('projects/:projectId/members/:userId/remove-preview')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async previewRemoveMember(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.project.previewRemoveMember(
        {
          project_id: projectId,
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as { owned_count?: number; breakdown?: { domain?: string; count?: number }[] };
    return {
      ownedCount: Number(r.owned_count ?? 0),
      breakdown: (r.breakdown ?? []).map((b) => ({
        domain: b.domain ?? '',
        count: Number(b.count ?? 0),
      })),
    };
  }

  @Delete('projects/:projectId/members/:userId')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async removeMember(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { reassignToUserId?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(
      this.project.removeMember(
        {
          project_id: projectId,
          user_id: userId,
          actor_user_id: req.user?.userId ?? '',
          reassign_to_user_id: (body?.reassignToUserId ?? '').trim(),
        },
        md,
      ) as never,
    );
    return { ok: true };
  }

  // ─── Archive / unarchive a project (WM5, US-MPRJ-17). DELETE archives;
  // POST .../unarchive restores. Gated by project:manage. ────────────────────

  @Delete('projects/:projectId')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async archiveProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.project.archiveProject(
        { id: projectId, archived: true, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  @Post('projects/:projectId/unarchive')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async unarchiveProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.project.archiveProject(
        { id: projectId, archived: false, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  // ─── C5 (FR-MPRJ-17): project lifecycle — request soft-delete (pending_deletion
  // with grace window) / restore. Both gated by project:manage; control re-checks
  // PEP and scopes by x-project-id. ───────────────────────────────────────────

  @Post('projects/:projectId/request-deletion')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async requestProjectDeletion(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body() body: { confirmName?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const confirmName = body?.confirmName?.trim() ?? '';
    if (!confirmName) {
      throw new BadRequestException('confirmName is required');
    }
    const res = await grpcBffCall(
      this.project.requestProjectDeletion(
        {
          id: projectId,
          actor_user_id: req.user?.userId ?? '',
          confirm_name: confirmName,
        },
        md,
      ) as never,
    );
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  @Post('projects/:projectId/restore')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async restoreProject(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.project.restoreProject(
        { id: projectId, actor_user_id: req.user?.userId ?? '' },
        md,
      ) as never,
    );
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  // ─── C5 (FR-ONB-5/7): (re)apply an onboarding template to an existing project.
  // Idempotent (re)provisioning of pipeline/order-types. Gated by project:manage.
  @Post('projects/:projectId/apply-template')
  @ApiTags('Projects')
  @RequirePermission('project', 'manage')
  async applyTemplate(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body() body: { templateId?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.project.applyTemplate(
        {
          project_id: projectId,
          template_id: body.templateId ?? '',
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    );
    return decodeGrpcProject(res as Record<string, unknown>);
  }

  // ─── Record sharing (phase 4d, spec §13.4) ───────────────────────────────
  // Project-scoped: ProjectAccessGuard enforces membership; control enforces
  // fine-grained share/unshare (FR-ACCESS-400/420 — manage, manager, record owner).

  private ownerUserIdFromRecord(
    row:
      | {
          owner_id?: string;
          assignee_id?: string;
        }
      | null
      | undefined,
  ): string {
    // Contacts/companies use owner_id; deals/orders/activities use assignee_id.
    return (row?.owner_id ?? row?.assignee_id ?? '').trim();
  }

  private async resolveShareRecordOwnerUserId(
    projectId: string,
    resource: string,
    recordId: string,
    md: unknown,
  ): Promise<string> {
    if (!recordId) return '';
    try {
      switch (resource) {
        case 'contacts': {
          const row = (await grpcBffCall(
            this.contact.getContact({ project_id: projectId, id: recordId }, md) as never,
          )) as { owner_id?: string; assignee_id?: string };
          return this.ownerUserIdFromRecord(row);
        }
        case 'companies': {
          const row = (await grpcBffCall(
            this.company.getCompany({ project_id: projectId, id: recordId }, md) as never,
          )) as { owner_id?: string; assignee_id?: string };
          return this.ownerUserIdFromRecord(row);
        }
        case 'deals': {
          const row = (await grpcBffCall(
            this.pipe.getDeal({ project_id: projectId, id: recordId }, md) as never,
          )) as { owner_id?: string; assignee_id?: string };
          return this.ownerUserIdFromRecord(row);
        }
        case 'orders': {
          const row = (await grpcBffCall(
            this.orders.getOrder({ project_id: projectId, id: recordId }, md) as never,
          )) as { owner_id?: string; assignee_id?: string };
          return this.ownerUserIdFromRecord(row);
        }
        case 'activities': {
          const row = (await grpcBffCall(
            this.activity.getActivity({ project_id: projectId, id: recordId }, md) as never,
          )) as { owner_id?: string; assignee_id?: string };
          return this.ownerUserIdFromRecord(row);
        }
        default:
          return '';
      }
    } catch {
      return '';
    }
  }

  @Post('projects/:projectId/shares')
  @ApiTags('Sharing')
  @MembershipOnly()
  async shareRecord(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      resource?: string;
      recordId?: string;
      granteeType?: string;
      granteeId?: string;
      expiresAt?: string;
    },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const recordOwnerUserId = await this.resolveShareRecordOwnerUserId(
      projectId,
      body.resource ?? '',
      body.recordId ?? '',
      md,
    );
    return grpcBffCall(
      this.project.shareRecord(
        {
          project_id: projectId,
          resource: body.resource ?? '',
          record_id: body.recordId ?? '',
          grantee_type: body.granteeType ?? 'user',
          grantee_id: body.granteeId ?? '',
          actor_user_id: req.user?.userId ?? '',
          expires_at: body.expiresAt ?? '',
          record_owner_user_id: recordOwnerUserId,
        },
        md,
      ) as never,
    );
  }

  @Get('projects/:projectId/shares')
  @ApiTags('Sharing')
  @MembershipOnly()
  async listRecordShares(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Query('resource') resource: string,
    @Query('recordId') recordId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.project.listRecordShares(
        { project_id: projectId, resource: resource ?? '', record_id: recordId ?? '' },
        md,
      ) as never,
    )) as { list?: unknown[] };
    return Array.isArray(r.list) ? r.list : [];
  }

  @Delete('projects/:projectId/shares/:shareId')
  @ApiTags('Sharing')
  @MembershipOnly()
  async unshareRecord(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('shareId') shareId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(
      this.project.unshareRecord(
        { id: shareId, actor_user_id: req.user?.userId ?? '', project_id: projectId },
        md,
      ) as never,
    );
    return { ok: true };
  }

  // ─── F3-integ-be (U8/U4): project integrations + per-project API keys ───────
  // Project-scoped: ProjectAccessGuard enforces membership, x-project-id isolates
  // every call, and mutations are gated by project:manage (owner/admin). Secrets
  // never leak: integration secret is masked, the API key plaintext is returned
  // only once on creation (lists carry a masked prefix). Config-only v1 — actual
  // external event delivery is out of scope (stage-3 event axis).
  //
  // TODO-279: the READS are gated with the writes (`project:manage`). An
  // integration row names the external endpoint URL/topic and the key list names
  // the issued project credentials — administration data, surfaced only on the
  // manage-gated "Интеграции" settings tab (Settings.tsx:3314,:3559). Before this
  // the tab's gate was client-side only and any project member could enumerate
  // both over the API.

  @Get('projects/:projectId/integrations')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async listIntegrations(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.integration.listIntegrations({ project_id: projectId }, md) as never,
    )) as { list?: Array<Record<string, unknown>> };
    // FE (F3-integ-ui) expects `{ list }`; keep the gRPC envelope shape.
    return { list: (r.list ?? []).map(mapIntegration) };
  }

  @Get('projects/:projectId/integrations/:integrationId')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async getIntegration(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('integrationId') integrationId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.integration.getIntegration({ project_id: projectId, id: integrationId }, md) as never,
    )) as Record<string, unknown>;
    return mapIntegration(r);
  }

  // BX-INTEG-5: outbound webhook delivery journal of one REST integration.
  // Manage-gated (owner/admin) — the panel carries endpoint URLs + failure
  // reasons, so it lives behind project:manage like the integration mutations.
  @Get('projects/:projectId/integrations/:integrationId/deliveries')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async listWebhookDeliveries(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('integrationId') integrationId: string,
    @Query('limit') limit?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const parsed = Number.parseInt(limit ?? '', 10);
    const r = (await grpcBffCall(
      this.integration.listWebhookDeliveries(
        {
          project_id: projectId,
          integration_id: integrationId,
          limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
        },
        md,
      ) as never,
    )) as { list?: Array<Record<string, unknown>> };
    return { list: (r.list ?? []).map(mapWebhookDelivery) };
  }

  @Post('projects/:projectId/integrations')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async createIntegration(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      name?: string;
      type?: string;
      config?: Record<string, unknown>;
      secret?: string;
      status?: string;
    },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.integration.createIntegration(
        {
          project_id: projectId,
          actor_user_id: req.user?.userId ?? '',
          name: body.name ?? '',
          type: body.type ?? '',
          config: body.config && typeof body.config === 'object' ? body.config : {},
          secret: body.secret ?? '',
          status: body.status ?? '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapIntegration(r);
  }

  @Patch('projects/:projectId/integrations/:integrationId')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async updateIntegration(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('integrationId') integrationId: string,
    @Body()
    body: {
      name?: string;
      config?: Record<string, unknown>;
      secret?: string; // present (incl. "") => replace/clear the stored secret
      status?: string;
    },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // set_secret only when the client explicitly sent the `secret` field, so a
    // plain rename never wipes an existing secret.
    const setSecret = Object.prototype.hasOwnProperty.call(body, 'secret');
    const r = (await grpcBffCall(
      this.integration.updateIntegration(
        {
          project_id: projectId,
          actor_user_id: req.user?.userId ?? '',
          id: integrationId,
          name: body.name,
          config: body.config && typeof body.config === 'object' ? body.config : undefined,
          secret: body.secret ?? '',
          set_secret: setSecret,
          status: body.status,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapIntegration(r);
  }

  @Delete('projects/:projectId/integrations/:integrationId')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async deleteIntegration(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('integrationId') integrationId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(
      this.integration.deleteIntegration(
        { project_id: projectId, actor_user_id: req.user?.userId ?? '', id: integrationId },
        md,
      ) as never,
    );
    return { ok: true };
  }

  @Get('projects/:projectId/api-keys')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async listApiKeys(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.integration.listApiKeys({ project_id: projectId }, md) as never,
    )) as { list?: Array<Record<string, unknown>> };
    return { list: (r.list ?? []).map(mapApiKey) };
  }

  @Post('projects/:projectId/api-keys')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async createApiKey(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Body() body: { name?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.integration.createApiKey(
        { project_id: projectId, actor_user_id: req.user?.userId ?? '', name: body.name ?? '' },
        md,
      ) as never,
    )) as { key?: Record<string, unknown>; plaintext?: string };
    // The full key is surfaced ONCE here ("copy now, you won't see it again").
    return { ...mapApiKey(r.key ?? {}), key: r.plaintext ?? '' };
  }

  @Delete('projects/:projectId/api-keys/:keyId')
  @ApiTags('Integrations')
  @RequirePermission('project', 'manage')
  async revokeApiKey(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('keyId') keyId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(
      this.integration.revokeApiKey(
        { project_id: projectId, actor_user_id: req.user?.userId ?? '', id: keyId },
        md,
      ) as never,
    );
    return { ok: true };
  }

  @Get('modules/registry')
  @ApiTags('Modules')
  @MembershipOnly()
  modulesRegistry() {
    return {
      list: Object.values(MODULE_REGISTRY).map((moduleDef) => ({
        id: moduleDef.id,
        name: moduleDef.name,
        description: moduleDef.description,
        locked: moduleDef.locked,
        dependencies: moduleDef.dependencies,
        integrationMethods: moduleDef.integrationMethods,
        // Legacy shorthand (kept for back-compat) + real JSON Schema 2020-12
        // (`settingsSchema.{personal,integration}`) for schema-driven FE forms.
        personalSettingsSchema: moduleDef.personalSettingsSchema,
        integrationSettingsSchema: moduleDef.integrationSettingsSchema,
        settingsSchema: {
          personal: shorthandToJsonSchema(moduleDef.personalSettingsSchema),
          integration: shorthandToJsonSchema(moduleDef.integrationSettingsSchema),
        },
        policyCapabilities: moduleDef.policyCapabilities,
      })),
    };
  }

  /**
   * Navigation-ready catalog of modules ENABLED for the current project (E1-08).
   * Source of truth for host manifest-navigation: builds `ModuleNavCard[]` from
   * the shared module registry (→ manifest → card) and marks `enabled` per the
   * project's effective modules resolved via `control.ProjectGrpc.GetProject`.
   * Project scope comes from `x-project-id` (resolved by the outbound metadata
   * and enforced by `ProjectAccessGuard`).
   */
  @Get('platform/modules')
  @ApiTags('Modules')
  @MembershipOnly()
  async platformModules(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectIdQuery?: string,
  ): Promise<ModuleNavCard[]> {
    const projectId = (
      projectIdQuery ??
      (req.headers?.['x-project-id'] as string | undefined) ??
      ''
    ).trim();

    const enabled = new Set(await this.resolveEnabledModules(req, projectId));

    // I2a: nav cards are built from the REAL `ModuleManifestV1` set (declared
    // navigation, version, kind, events) — not the synthesized legacy bridge.
    // `enabled` gates the contribution per-project: a disabled module's card is
    // returned with `enabled:false`, so the host drops its menu/slots (FR-MOD-27).
    return Object.values(MODULE_MANIFESTS).map((manifest) =>
      manifestToNavCard(manifest, enabled.has(manifest.id)),
    );
  }

  /**
   * Effective enabled module ids for a project (E1-08). Reads the project from
   * control and normalizes across `effective_modules` / `module_configs` /
   * `modules`, then resolves hard dependencies + locked modules so the set
   * matches what is actually reachable. Empty/unknown project → no modules
   * enabled (cards still returned, all `enabled:false`).
   */
  private async resolveEnabledModules(
    req: FastifyRequest & { user?: { userId?: string } },
    projectId: string,
  ): Promise<string[]> {
    if (!projectId) return [];
    try {
      const md = this.outboundMeta.build(req, { projectId });
      const project = (await grpcBffCall(
        this.project.getProject({ id: projectId }, md) as never,
      )) as {
        modules?: string[];
        effective_modules?: string[];
        module_configs?: Array<{ module_id?: string; enabled?: boolean }>;
      };

      let ids: string[] = [];
      if (Array.isArray(project?.effective_modules) && project.effective_modules.length > 0) {
        ids = project.effective_modules.filter((m): m is string => typeof m === 'string');
      } else if (Array.isArray(project?.module_configs) && project.module_configs.length > 0) {
        ids = project.module_configs
          .filter(
            (c): c is { module_id: string; enabled?: boolean } => typeof c?.module_id === 'string',
          )
          .filter((c) => c.enabled !== false)
          .map((c) => c.module_id);
      } else if (Array.isArray(project?.modules)) {
        ids = project.modules.filter((m): m is string => typeof m === 'string');
      }

      return resolveDependencies(ids);
    } catch (err) {
      // Fmig-modulegate: don't mask a control GetProject outage/schema-drift with
      // a silent `[]` (which would hide every system/locked module). Log the
      // cause and fall back to the locked/system module set, which is enabled by
      // definition — nav cards for system modules stay correct; optional modules
      // remain `enabled:false` (fail-closed).
      this.logger.error(
        `resolveEnabledModules(${projectId}) failed; falling back to system/locked modules: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return ensureLockedModules([]);
    }
  }

  // ─── Module lifecycle (R4-E1-05) — per-project install/upgrade/uninstall on
  // top of enable/disable. Project-scoped → ProjectAccessGuard enforces
  // membership; mutations gated by `project:manage` (TZ §6.1). ───────────────

  /**
   * Full module state matrix for the project (read).
   *
   * FR-PLATFORM-250 / FR-LIFE-36: membership-scoped read — managers and observers
   * see the matrix without `project:manage`. Mutations stay manage-gated below.
   */
  @Get('projects/:projectId/modules')
  @ApiTags('Modules')
  @MembershipOnly()
  async listProjectModuleStates(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.lifecycle.listModuleStates({ project_id: projectId }, md) as never,
    )) as { list?: unknown[] };
    return Array.isArray(r.list) ? r.list : [];
  }

  /**
   * FR-PSET-055 / SCR-PRJSET-MODULE-DISABLE-IMPACT — preview consequences before
   * disabling a project module (dependents, unfinished records, automations).
   */
  @Get('projects/:projectId/modules/:moduleId/disable-impact')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async getModuleDisableImpact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.project.getModuleDisableImpact(
        { project_id: projectId, module_id: moduleId },
        md,
      ) as never,
    )) as {
      dependent_enabled_modules?: Array<{ id?: string; name?: string }>;
      unfinished_records?: number | string;
      stopped_automations?: Array<{ id?: string; name?: string }>;
      webhook_dlq_suspended?: boolean;
    };
    return {
      dependentEnabledModules: (r.dependent_enabled_modules ?? []).map((m) => ({
        id: m.id ?? '',
        name: m.name ?? m.id ?? '',
      })),
      unfinishedRecords: r.unfinished_records == null ? -1 : Number(r.unfinished_records),
      stoppedAutomations: (r.stopped_automations ?? []).map((a) => ({
        id: a.id ?? '',
        name: a.name ?? a.id ?? '',
      })),
      webhookDlqSuspended: r.webhook_dlq_suspended === true,
    };
  }

  /**
   * FR-PSET-050 — preview hard-dependency modules that enabling `moduleId` would
   * also turn on (same `resolveDependencies` projection as control on save).
   */
  @Get('projects/:projectId/modules/:moduleId/enable-impact')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async getModuleEnableImpact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const enabled = await this.resolveEnabledModules(req, projectId);
    const cascadeIds = previewEnableCascade(moduleId, enabled);
    return {
      cascadeModules: cascadeIds.map((id) => ({
        id,
        name: MODULE_REGISTRY[id]?.name ?? id,
      })),
    };
  }

  /** install a module into the project space (first-time activation). */
  @Post('projects/:projectId/modules/:moduleId/install')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async installProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.installModule(
        {
          project_id: projectId,
          module_id: moduleId,
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
        },
        md,
      ) as never,
    );
    // Drop the guard's per-project module cache so a freshly installed/enabled
    // module is reachable immediately (see updateProject).
    invalidateModuleCache(projectId);
    return res;
  }

  /** uninstall a module from the project space (must be disabled first). */
  @Post('projects/:projectId/modules/:moduleId/uninstall')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async uninstallProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.uninstallModule(
        {
          project_id: projectId,
          module_id: moduleId,
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
        },
        md,
      ) as never,
    );
    invalidateModuleCache(projectId);
    return res;
  }

  /** enable a module in the project (FR-PLATFORM-080 / FR-LIFE-14). */
  @Post('projects/:projectId/modules/:moduleId/enable')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async enableProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.enableModule(
        {
          project_id: projectId,
          module_id: moduleId,
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
        },
        md,
      ) as never,
    );
    invalidateModuleCache(projectId);
    return res;
  }

  /** disable a module in the project (FR-PLATFORM-080 / FR-LIFE-19). */
  @Post('projects/:projectId/modules/:moduleId/disable')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async disableProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { cascade?: boolean },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.disableModule(
        {
          project_id: projectId,
          module_id: moduleId,
          cascade: Boolean(body?.cascade),
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
        },
        md,
      ) as never,
    );
    invalidateModuleCache(projectId);
    return res;
  }

  /** upgrade preview: class (patch/minor/major) + migration requirement. */
  @Post('projects/:projectId/modules/:moduleId/upgrade/preview')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async previewUpgradeProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { toVersion?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    return grpcBffCall(
      this.lifecycle.upgradeModulePreview(
        { project_id: projectId, module_id: moduleId, to_version: body?.toVersion ?? '' },
        md,
      ) as never,
    );
  }

  /** upgrade a module's active version (major requires `confirmMajor:true`). */
  @Post('projects/:projectId/modules/:moduleId/upgrade')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async upgradeProjectModule(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { toVersion?: string; confirmMajor?: boolean },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.upgradeModule(
        {
          project_id: projectId,
          module_id: moduleId,
          to_version: body?.toVersion ?? '',
          confirm_major: Boolean(body?.confirmMajor),
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
        },
        md,
      ) as never,
    );
    invalidateModuleCache(projectId);
    return res;
  }

  /** resume runtime delivery after re-enable (FR-PLATFORM-115). */
  @Post('projects/:projectId/modules/:moduleId/resume-delivery')
  @ApiTags('Modules')
  @RequirePermission('project', 'manage')
  async resumeProjectModuleDelivery(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { dlq?: 'discard' | 'deliver' },
  ) {
    const dlq = body?.dlq === 'deliver' ? 'deliver' : body?.dlq === 'discard' ? 'discard' : '';
    if (!dlq) {
      throw new BadRequestException({
        code: 'INVALID_DLQ_FATE',
        message: 'dlq must be discard or deliver',
      });
    }
    const md = this.outboundMeta.build(req, { projectId });
    const res = await grpcBffCall(
      this.lifecycle.resumeModuleDelivery(
        {
          project_id: projectId,
          module_id: moduleId,
          actor_user_id: req.user?.userId ?? '',
          idempotency_key: idempotencyKeyFromReq(req),
          dlq,
        },
        md,
      ) as never,
    );
    invalidateModuleCache(projectId);
    return res;
  }

  @Get('contacts')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async listContacts(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    @Query('state') state?: string,
    // FR-CONTACTS-030/300: серверные фильтры «источник»/«ответственный» и
    // сортировка по колонке. До этой правки список объявлял только query/state,
    // поэтому выбор в фильтрах и клик по заголовку колонки не меняли выборку —
    // а клиентской фильтрации в таблице нет вовсе.
    @Query('source') source?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('ownerId') ownerId?: string,
    @Query('filterTags') filterTags?: string,
    @Query('ownerScope') ownerScope?: string,
    @Query('inactiveDays') inactiveDays?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const sort = readSortParam(req, sortBy, sortDir);
    const payload = {
      project_id: projectId,
      page_index: parseInt(pageIndex ?? '0', 10),
      page_size: parseInt(pageSize ?? '25', 10),
      query: query ?? '',
    };
    // state=trashed → корзина (только удалённые) через отдельный ListTrash-путь.
    // Фильтры/сортировка идут только в ListContacts: ListTrashRequest их не
    // объявляет, а proto-loader выкинул бы их молча — «применилось, но не видно».
    const r = (await grpcBffCall(
      (state === 'trashed'
        ? this.contact.listTrash(payload, md)
        : this.contact.listContacts(
            {
              ...payload,
              source: source ?? '',
              // assigneeId — имя поля во фронте, owner_id — в домене (mapContact зеркалит их).
              owner_id: ownerId || assigneeId || '',
              owner_scope: ownerScope ?? '',
              inactive_days: inactiveDays ? parseInt(inactiveDays, 10) : 0,
              filter_tags: filterTags ?? '',
              sort_by: sort.by,
              sort_dir: sort.dir,
            },
            md,
          )) as never,
    )) as { list?: Record<string, unknown>[]; total?: number; hidden_by_policy?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    const total = typeof r.total === 'number' ? r.total : list.length;
    const hiddenByPolicy = typeof r.hidden_by_policy === 'number' ? r.hidden_by_policy : undefined;
    return {
      list: list.map(mapContact),
      total,
      ...(hiddenByPolicy !== undefined ? { hiddenByPolicy } : {}),
    };
  }

  // --- Collection-level routes (must precede 'contacts/:id' to avoid path capture). ---

  @Get('contacts/trash')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async listContactsTrash(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.contact.listTrash(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
          query: query ?? '',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      list: list.map(mapContact),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }

  @Get('contacts/export')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'export')
  @Header('Cache-Control', 'no-store')
  async exportContacts(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('projectId') projectId: string,
    @Query('format') format?: string,
    @Query('query') query?: string,
  ) {
    const requested = (format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const md = this.outboundMeta.build(req, { projectId });
    // Export reuses ListContacts with the *same* visibility scope as the list — never a full
    // project dump. Fail-closed visibility is pushed down and enforced domain-side.
    //
    // Кнопка обещает «все контакты», поэтому идём по страницам домена: один запрос
    // с page_size=1000 домен молча клампил до MAX_PAGE_SIZE=100 (clampPageSize +
    // повторный кламп в service) — в проекте с 500 контактами файл содержал 100
    // строк, и пользователь об этом не узнавал.
    //
    // Сортировка принудительно createdAt asc: дефолт `updatedAt desc` при
    // параллельной правке переносит запись на первую страницу, и skip-пагинация
    // теряет/дублирует строки. createdAt неизменен, вторичный ключ _id — в домене.
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    // undefined = домен не сообщил total: тогда идём до короткой страницы, а не
    // останавливаемся на первой (иначе «нет total» = снова файл из 100 строк).
    let total: number | undefined;
    const maxPages = Math.ceil(CONTACT_EXPORT_MAX_ROWS / CONTACT_EXPORT_PAGE_SIZE) + 1;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const r = (await grpcBffCall(
        this.contact.listContacts(
          {
            project_id: projectId,
            page_index: pageIndex,
            page_size: CONTACT_EXPORT_PAGE_SIZE,
            query: query ?? '',
            sort_by: 'createdAt',
            sort_dir: 'asc',
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      if (pageIndex === 0) {
        total = typeof r.total === 'number' ? r.total : undefined;
        // Верхняя граница выгрузки (память gateway + PII-egress). Тихо обрезать
        // нельзя: либо полный файл, либо явный отказ с указанием, что сузить.
        if (total !== undefined && total > CONTACT_EXPORT_MAX_ROWS) {
          throw new BadRequestException(exportTooLargeMessage(total));
        }
      }
      const page = Array.isArray(r.list) ? r.list : [];
      if (page.length === 0) break;
      for (const raw of page) {
        const row = mapContact(raw);
        const id = typeof row.id === 'string' ? row.id : '';
        // Дедуп на случай «плывущих» страниц (запись создана/удалена во время выгрузки).
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        rows.push(row);
      }
      if (page.length < CONTACT_EXPORT_PAGE_SIZE) break;
      if (total !== undefined && rows.length >= total) break;
      // Упёрлись в потолок, а данные не кончились — это усечение. Отдавать
      // «почти всё» молча нельзя, тот же отказ, что и по известному total.
      if (rows.length >= CONTACT_EXPORT_MAX_ROWS) {
        throw new BadRequestException(exportTooLargeMessage(total ?? rows.length));
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    void appendPiiEgressAudit(this.audit, this.outboundMeta, req, projectId, {
      channel: 'export',
      subject: 'contacts',
      format: requested,
      rowCount: rows.length,
    });
    let payload: string;
    let contentType: string;
    if (requested === 'json') {
      payload = JSON.stringify(rows, null, 2);
      contentType = 'application/json; charset=utf-8';
    } else {
      const cols = ['firstName', 'lastName', 'phone', 'email', 'position', 'companyId'] as const;
      const escape = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      payload = [
        cols.join(','),
        ...rows.map((row) => cols.map((c) => escape(row[c])).join(',')),
      ].join('\n');
      contentType = 'text/csv; charset=utf-8';
    }
    void res.header('Content-Type', contentType);
    // Сколько строк реально ушло: усечения тут уже быть не может (>max — это 400 выше),
    // но короткий файл должен объясняться по логам, а не по догадкам.
    void res.header('X-Export-Row-Count', String(rows.length));
    void res.header('Content-Disposition', `attachment; filename="contacts-${stamp}.${requested}"`);
    return Buffer.from(payload, 'utf8');
  }

  @Get('contacts/:id')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async getContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.contact.getContact({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;
    return mapContact(c);
  }

  @Post('contacts')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'write')
  async createContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.contact.createContact(
        {
          project_id: projectId,
          first_name: body.firstName,
          last_name: body.lastName,
          phone: body.phone,
          email: body.email,
          position: body.position,
          company_id: body.companyId,
          source: body.source,
          assignee_id: body.assigneeId,
          department_id: body.departmentId,
          // FR-CONTACTS-050/170/190: отчество, заметки, теги и M2M-компании.
          // Форма их честно шлёт, модель их хранит — терялись ровно здесь.
          middle_name: body.middleName,
          notes: body.notes,
          tags: toStringList(body.tags),
          company_ids: toCompanyIds(body.companyIds, body.companyId),
          company_links: toProtoCompanyLinks(body.companyLinks),
          force_create: Boolean(body.forceCreate),
          trash_collision_resolution:
            typeof body.trashCollisionResolution === 'string' ? body.trashCollisionResolution : '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapContact(c);
  }

  @Put('contacts/:id')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'write')
  async updateContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.contact.updateContact(
        {
          project_id: projectId,
          id,
          first_name: body.firstName,
          last_name: body.lastName,
          phone: body.phone,
          email: body.email,
          position: body.position,
          company_id: body.companyId,
          source: body.source,
          assignee_id: body.assigneeId,
          middle_name: body.middleName,
          notes: body.notes,
          // set_* — явное «список прислали» (в т.ч. пустой = очистить): proto3
          // не отличает пропущенный repeated от пустого, без флага частичный PUT
          // стирал бы теги и привязку к компаниям.
          tags: toStringList(body.tags),
          set_tags: body.tags !== undefined,
          company_ids: toCompanyIds(body.companyIds, body.companyId),
          set_company_ids: body.companyIds !== undefined || body.companyId !== undefined,
          company_links: toProtoCompanyLinks(body.companyLinks),
          set_company_links: body.companyLinks !== undefined,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapContact(c);
  }

  @Delete('contacts/:id')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'delete')
  async deleteContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(this.contact.deleteContact({ project_id: projectId, id }, md) as never);
    return { ok: true };
  }

  @Post('contacts/:id/restore')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'write')
  async restoreContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body?: { collisionResolution?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // collisionResolution фронта ('merge'|'clear_keys') → strategy домена как есть.
    const strategy = body?.collisionResolution ?? '';
    try {
      const c = (await grpcBffCall(
        this.contact.restoreContact({ project_id: projectId, id, strategy }, md) as never,
      )) as Record<string, unknown>;
      return { outcome: 'restored', contact: mapContact(c) };
    } catch (err) {
      // Живой дубль без стратегии → домен кидает FAILED_PRECONDITION с details.options.
      // Отдаём 200-collision (envelope-ошибка не несёт машинного кода RESTORE_COLLISION).
      const e = err as { code?: number; metadata?: unknown };
      if (e?.code === GrpcStatus.FAILED_PRECONDITION) {
        const details = decodeErrorDetails(e.metadata) as
          | { candidates?: unknown[]; options?: string[] }
          | undefined;
        if (details?.options) {
          return {
            outcome: 'collision',
            collision: { candidates: details.candidates ?? [], options: details.options },
          };
        }
      }
      throw err;
    }
  }

  @Get('contacts/duplicates')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async findContactDuplicates(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('email') email?: string,
    @Query('phone') phone?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.contact.findDuplicates(
        {
          project_id: projectId,
          email: email ?? '',
          phone: phone ?? '',
          exclude_id: excludeId ?? '',
        },
        md,
      ) as never,
    )) as { candidates?: Record<string, unknown>[]; possible_external_duplicate?: boolean };
    return {
      candidates: (r.candidates ?? []).map(mapDuplicateCandidate),
      possibleExternalDuplicate: Boolean(r.possible_external_duplicate),
    };
  }

  @Get('contacts/duplicate-queue')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'manage')
  async listContactDuplicateQueue(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.contact.listDuplicateQueue(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
        },
        md,
      ) as never,
    )) as { pairs?: Record<string, unknown>[]; total?: number };
    const pairs = Array.isArray(r.pairs) ? r.pairs : [];
    return {
      pairs: pairs.map((p) => ({
        left: mapDuplicateCandidate((p.left ?? {}) as Record<string, unknown>),
        right: mapDuplicateCandidate((p.right ?? {}) as Record<string, unknown>),
        matchedOn: p.matched_on,
      })),
      total: typeof r.total === 'number' ? r.total : pairs.length,
    };
  }

  @Post('contacts/merge')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'manage')
  async mergeContacts(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const survivor = (body.survivorFields ?? {}) as Record<string, string>;
    const survivorFields = Object.entries(survivor).map(([field, from]) => ({ field, from }));
    const c = (await grpcBffCall(
      this.contact.mergeContacts(
        {
          project_id: projectId,
          source_id: body.sourceId,
          target_id: body.targetId,
          survivor_fields: survivorFields,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapContact(c);
  }

  @Post('contacts/:id/unmerge')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'manage')
  async unmergeContact(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.contact.unmergeContact({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;
    return mapContact(c);
  }

  @Post('contacts/reassign')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'manage')
  async reassignContacts(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.contact.reassignContacts(
        {
          project_id: projectId,
          contact_ids: (body.contactIds as string[]) ?? [],
          new_owner_id: (body.newOwnerId as string) ?? '',
          new_department_id: (body.newDepartmentId as string) ?? '',
        },
        md,
      ) as never,
    )) as { reassigned?: number };
    return { reassigned: typeof r.reassigned === 'number' ? r.reassigned : 0 };
  }

  @Post('contacts/reassign-from-owner')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'manage')
  async reassignContactsFromOwner(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.contact.reassignContactsFromOwner(
        {
          project_id: projectId,
          from_owner_id: (body.fromOwnerId as string) ?? '',
          to_owner_id: (body.toOwnerId as string) ?? '',
        },
        md,
      ) as never,
    )) as { reassigned?: number };
    return { reassigned: typeof r.reassigned === 'number' ? r.reassigned : 0 };
  }

  @Get('contacts/:id/links')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async getContactLinks(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // Visibility + existence check via the contact domain (404-mask if hidden).
    const c = (await grpcBffCall(
      this.contact.getContact({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;
    const companyIds = (c.company_ids as string[]) ?? [];
    // Cross-domain reverse indexes (contract §3.12). Each donor carries its own
    // per-domain visibility scope (md); a donor being down degrades to an empty
    // block (fail-soft) instead of failing the whole preview with a 500.
    const [deals, orders, activities, documents, companies] = await Promise.all([
      this.linksFromDeals(md, projectId, { contact_id: id }),
      this.linksFromOrders(md, projectId, { contact_id: id }),
      this.linksFromActivities(md, projectId, 'contact', id),
      this.linksFromDocuments(md, projectId, 'contact', id),
      this.linksFromContactCompanies(md, projectId, companyIds),
    ]);
    return {
      deals,
      orders,
      activities,
      documents,
      companies,
    };
  }

  /** Max reverse-index rows pulled per donor for card/links aggregates. */
  private static readonly LINKS_PAGE_SIZE = 100;

  /**
   * Outbound metadata carrying the DONOR subject's own visibility scope + ABAC
   * predicate (resolved by `ProjectAccessGuard` via `@RequireDonorSubjects`).
   *
   * FR-COMPANIES-375: a composite route resolves ONE scope — its own subject's —
   * and forwarding it to donor domains turns `companies:read` into a read gate for
   * deals/contacts/orders/activities. `undefined` here means the caller may not
   * read that donor (or it could not be resolved) ⇒ the block renders empty.
   *
   * When the route is not annotated with `@RequireDonorSubjects` (`__donorAccess`
   * absent), fail-closed: return `undefined` so donor blocks stay empty instead of
   * inheriting the host route's companies scope (FR-COMPANIES-375). Production
   * composites are always annotated; unit tests must set `__donorAccess` explicitly.
   */
  private donorMd(
    req: FastifyRequest,
    projectId: string,
    subject: string,
  ): ReturnType<GatewayOutboundMetadataService['build']> | undefined {
    const donors = (req as unknown as { __donorAccess?: Record<string, DonorAccess | null> })
      .__donorAccess;
    if (!donors) return undefined;
    const entry = donors[subject];
    if (!entry) return undefined;
    // Prototype-delegating view of the request: everything the metadata builder
    // reads (headers, user, __projectRole, __enabledModules, __systemOrgId…) stays
    // the request's, only the two access fields are swapped for the donor's.
    const scoped = Object.create(req) as {
      __visibilityScope?: string;
      __accessPredicate?: string;
    };
    scoped.__visibilityScope = entry.scope;
    scoped.__accessPredicate = entry.predicate;
    return this.outboundMeta.build(scoped as never, { projectId });
  }

  /**
   * Outbound metadata with an EXPLICIT project-wide visibility scope
   * (`mode:'all'`, no ABAC predicate), caller identity otherwise intact.
   *
   * Not a bypass of the record gate and never to be used for payload routes: it
   * exists for IMPACT counters — numbers that must describe what an operation
   * will do to the project, not what the caller happens to see. `POST
   * /companies/merge/preview` is the only such route: the merge relinks EVERY
   * record of the project that points at the loser (`crm.company.merged` is
   * consumed by contact/pipe/orders/activity and re-stitched project-wide, see
   * `companies.service.mergeCompanies`), so a counter resolved under the actor's
   * own scope would understate the blast radius of an irreversible-ish action.
   * The route stays gated by `companies:manage` + the domain's ABAC gate on BOTH
   * companies (`loadForMerge`), and the response carries only cardinalities,
   * never record content — see `relationsScope: 'project'` in the payload.
   */
  private projectWideMd(
    req: FastifyRequest,
    projectId: string,
  ): ReturnType<GatewayOutboundMetadataService['build']> {
    const allScope: VisibilityScope = {
      mode: 'all',
      level: 'custom',
      selfId: '',
      ownerIds: [],
      sharedRecordIds: [],
    };
    // Same prototype-delegating view as `donorMd`: only the two access fields
    // are swapped, everything else the builder reads stays the request's.
    const scoped = Object.create(req) as {
      __visibilityScope?: string;
      __accessPredicate?: string;
    };
    scoped.__visibilityScope = serializeVisibilityScope(allScope);
    scoped.__accessPredicate = undefined;
    return this.outboundMeta.build(scoped as never, { projectId });
  }

  /**
   * Cache key for `/companies/:id/card` — includes `cardContactsRev` so contact-link
   * events invalidate stale composed payloads (FR-COMPANIES-220).
   */
  private companyCardCacheKey(
    projectId: string,
    companyId: string,
    cardContactsRev: number,
    req: FastifyRequest,
  ): string {
    const donors = (req as unknown as { __donorAccess?: Record<string, DonorAccess | null> })
      .__donorAccess;
    const donorFp = donors
      ? Object.keys(donors)
          .sort()
          .map((k) => `${k}:${donors[k]?.scope ?? ''}:${donors[k]?.predicate ?? ''}`)
          .join('|')
      : '';
    const scope = (req as { __visibilityScope?: string }).__visibilityScope ?? '';
    const pred = (req as { __accessPredicate?: string }).__accessPredicate ?? '';
    return `${projectId}:${companyId}:${cardContactsRev}:${scope}:${pred}:${donorFp}`;
  }

  /**
   * Contacts linked to a company (reverse M2M over `Contact.companyIds`).
   * Domain filter: `ListContacts.filter_company_id` + index `{ projectId, companyIds }`.
   */
  private async contactsOfCompany(
    md: unknown,
    projectId: string,
    companyId: string,
  ): Promise<{ list: Record<string, unknown>[]; total: number; truncated: boolean }> {
    const r = (await grpcBffCall(
      this.contact.listContacts(
        {
          project_id: projectId,
          page_index: 0,
          page_size: V1DataBffController.LINKS_PAGE_SIZE,
          query: '',
          filter_company_id: companyId,
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const list = Array.isArray(r.list) ? r.list.map(mapContact) : [];
    const total = typeof r.total === 'number' ? r.total : list.length;
    // total — точный (доменный filter_company_id). truncated — про список:
    // карточка/вкладка рисуют только первую страницу (LINKS_PAGE_SIZE).
    return { list, total, truncated: list.length < total };
  }

  /** Deals linked to a contact/company → LinkRef[]. Fail-soft: donor down ⇒ []. */
  private async linksFromDeals(
    md: unknown,
    projectId: string,
    filter: { contact_id?: string; company_id?: string },
  ): Promise<{ id: unknown; title: unknown }[]> {
    try {
      const r = (await grpcBffCall(
        this.pipe.listDeals(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            ...filter,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map((d) => ({ id: d.id, title: d.name || d.id }));
    } catch {
      return [];
    }
  }

  /** Orders linked to a contact/company → LinkRef[]. Fail-soft. */
  private async linksFromOrders(
    md: unknown,
    projectId: string,
    filter: { contact_id?: string; company_id?: string },
  ): Promise<{ id: unknown; title: unknown }[]> {
    try {
      const r = (await grpcBffCall(
        this.orders.listOrders(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            ...filter,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map((o) => ({ id: o.id, title: o.number || o.id }));
    } catch {
      return [];
    }
  }

  /** Activities linked to an entity (contact/company/deal) → LinkRef[]. Fail-soft. */
  private async linksFromActivities(
    md: unknown,
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<{ id: unknown; title: unknown }[]> {
    try {
      const r = (await grpcBffCall(
        this.activity.listActivities(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            link_entity_type: entityType,
            link_entity_id: entityId,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map((a) => ({ id: a.id, title: a.title || a.type || a.id }));
    } catch {
      return [];
    }
  }

  /** Document groups attached to an entity context → LinkRef[]. Fail-soft. */
  private async linksFromDocuments(
    md: unknown,
    projectId: string,
    contextType: string,
    recordId: string,
  ): Promise<{ id: unknown; title: unknown }[]> {
    try {
      const r = (await grpcBffCall(
        this.documents.listDocuments(
          {
            project_id: projectId,
            context_type: contextType,
            record_id: recordId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map((g) => ({ id: g.group_id, title: g.name || g.group_id }));
    } catch {
      return [];
    }
  }

  /** Companies linked on a contact (`company_ids`) → LinkRef[]. Per-id fail-soft. */
  private async linksFromContactCompanies(
    md: unknown,
    projectId: string,
    companyIds: string[],
  ): Promise<{ id: string; title: string }[]> {
    if (!companyIds.length) return [];
    return Promise.all(
      companyIds.map(async (cid) => {
        try {
          const co = (await grpcBffCall(
            this.company.getCompany({ project_id: projectId, id: cid }, md) as never,
          )) as { name?: string };
          const title = String(co.name ?? '').trim();
          return { id: cid, title: title || cid };
        } catch {
          return { id: cid, title: cid };
        }
      }),
    );
  }

  @Get('companies')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async listCompanies(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
    // FR-COMPANIES-010/280/290: серверные фильтры и сортировка. proto
    // (ListCompaniesRequest.filter_*/sort_*) и домен (companies.service.list)
    // их полностью поддерживают — до этой правки gateway их просто не объявлял,
    // поэтому «только мои», фильтр статуса/отрасли/региона и клик по заголовку
    // колонки не меняли выборку.
    @Query('filterOwnerId') filterOwnerId?: string,
    @Query('filterDepartmentId') filterDepartmentId?: string,
    @Query('filterStatus') filterStatus?: string,
    @Query('filterIndustry') filterIndustry?: string,
    @Query('filterRegion') filterRegion?: string,
    @Query('filterTags') filterTags?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.listCompanies(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
          query: query ?? '',
          filter_owner_id: filterOwnerId ?? '',
          filter_department_id: filterDepartmentId ?? '',
          filter_status: filterStatus ?? '',
          filter_industry: filterIndustry ?? '',
          filter_region: filterRegion ?? '',
          filter_tags: filterTags ?? '',
          sort_by: sortBy ?? '',
          sort_dir: sortDir ?? '',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number; hidden_by_policy?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    const total = typeof r.total === 'number' ? r.total : list.length;
    const hiddenByPolicy = typeof r.hidden_by_policy === 'number' ? r.hidden_by_policy : undefined;
    return {
      list: list.map((c) => mapCompanyForClient(c, req)),
      total,
      ...(hiddenByPolicy !== undefined ? { hiddenByPolicy } : {}),
    };
  }

  // --- Collection-level routes (must precede 'companies/:id' to avoid path capture). ---

  @Get('companies/trash')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async listCompaniesTrash(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.listTrash(
        {
          project_id: projectId,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
          query: query ?? '',
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      list: list.map((c) => mapCompanyForClient(c, req)),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }

  @Get('companies/duplicates')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async findCompanyDuplicates(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('inn') inn?: string,
    @Query('name') name?: string,
    @Query('domain') domain?: string,
    // TODO-362: форма создания компании заполняет e-mail и сайт, а не «домен» —
    // домен выводит его сам (deriveDomain), но только если gateway эти поля
    // пробросит. Без проброса мягкая подсказка о дубле по домену не срабатывала.
    @Query('email') email?: string,
    @Query('website') website?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.findDuplicates(
        {
          project_id: projectId,
          inn: inn ?? '',
          name: name ?? '',
          domain: domain ?? '',
          email: email ?? '',
          website: website ?? '',
        },
        md,
      ) as never,
    )) as { candidates?: Record<string, unknown>[] };
    return {
      candidates: (r.candidates ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        inn: c.inn,
        matchReason: c.match_reason,
        // TODO-362: кандидат лежит в корзине. Ключ идентичности он НЕ держит
        // (soft-delete снимает identityHash), 409 отсюда не бывает — флаг нужен для
        // другого: UI обязан предложить восстановление вместо «открыть» и не брать
        // такого кандидата в слияние (merge читает только живые записи).
        deleted: Boolean(c.deleted),
      })),
    };
  }

  @Get('companies/aggregate')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async aggregateCompanies(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Query('groupBy') groupBy: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.aggregateCompanies({ project_id: projectId, group_by: groupBy }, md) as never,
    )) as { groups?: Record<string, unknown>[] };
    return { groups: r.groups ?? [] };
  }

  @Get('companies/export')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'export')
  @Header('Cache-Control', 'no-store')
  async exportCompanies(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('projectId') projectId: string,
    @Query('format') format?: string,
    @Query('query') query?: string,
    @Query('filterStatus') filterStatus?: string,
    @Query('filterOwnerId') filterOwnerId?: string,
    @Query('filterDepartmentId') filterDepartmentId?: string,
    @Query('filterIndustry') filterIndustry?: string,
    @Query('filterRegion') filterRegion?: string,
    @Query('filterTags') filterTags?: string,
    // TODO-158: экспорт обязан повторять ВИДИМЫЙ набор — значит и сортировку тоже,
    // иначе выгрузка и таблица расходятся порядком (и при усечении — составом).
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    const requested = (format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const md = this.outboundMeta.build(req, { projectId });
    // Export reuses ListCompanies with the *same* visibility scope as the list — never a full
    // project dump (company.md §3.18, FR-MCOM-17). Fail-closed visibility is enforced domain-side.
    //
    // TODO-158: домен жёстко режет страницу до 100 (`companies.service.ts`
    // `Math.min(pageSize ?? 25, 100)`), поэтому прежний одиночный запрос с
    // page_size: 1000 выгружал максимум 100 строк и молчал об этом. Листаем
    // страницами по 100 до исчерпания, с общим потолком; факт усечения отдаём
    // заголовками, а не тишиной. Общий лимит списка НЕ поднимаем.
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (let pageIndex = 0; pageIndex < COMPANY_EXPORT_MAX_PAGES; pageIndex += 1) {
      const r = (await grpcBffCall(
        this.company.listCompanies(
          {
            project_id: projectId,
            page_index: pageIndex,
            page_size: COMPANY_EXPORT_PAGE_SIZE,
            query: query ?? '',
            filter_status: filterStatus ?? '',
            filter_owner_id: filterOwnerId ?? '',
            filter_department_id: filterDepartmentId ?? '',
            filter_industry: filterIndustry ?? '',
            filter_region: filterRegion ?? '',
            filter_tags: filterTags ?? '',
            sort_by: sortBy ?? '',
            sort_dir: sortDir ?? '',
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      const page = Array.isArray(r.list) ? r.list : [];
      rows.push(...page.map((c) => mapCompanyForClient(c, req)));
      // Последняя страница: домен вернул меньше запрошенного.
      if (page.length < COMPANY_EXPORT_PAGE_SIZE) break;
      // Потолок исчерпан. Частичной выгрузка считается, только если данные реально
      // остались: домен отдаёт total — на ровно 10 000 записей ложного «усечено» нет.
      if (pageIndex === COMPANY_EXPORT_MAX_PAGES - 1) {
        truncated = typeof r.total === 'number' ? rows.length < r.total : true;
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    void appendPiiEgressAudit(this.audit, this.outboundMeta, req, projectId, {
      channel: 'export',
      subject: 'companies',
      format: requested,
      rowCount: rows.length,
      truncated,
    });
    let payload: string;
    let contentType: string;
    if (requested === 'json') {
      payload = JSON.stringify(rows, null, 2);
      contentType = 'application/json; charset=utf-8';
    } else {
      const cols = [
        'name',
        'inn',
        'kpp',
        'ogrn',
        'phone',
        'email',
        'website',
        'industry',
        'region',
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
    void res.header(
      'Content-Disposition',
      `attachment; filename="companies-${stamp}.${requested}"`,
    );
    // TODO-158: признак частичности — явный, чтобы «выгрузилось не всё» не было
    // молчаливым (X-Export-Count всегда, X-Export-Truncated только при усечении).
    void res.header('X-Export-Count', String(rows.length));
    if (truncated) void res.header('X-Export-Truncated', 'true');
    return Buffer.from(payload, 'utf8');
  }

  @Post('companies/merge/preview')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  // TODO-110/TODO-153 (OQ-COMPANIES-140): merge гейтится `companies:manage`, а не
  // несуществующим `companies:execute`. Ключа `companies:execute` нет ни в каталоге
  // модуля (shared/module-registry policyCapabilities), ни в DECORATOR_SUBJECT_MAP,
  // поэтому FE-проекция allowed[] его никогда не содержала и кнопка слияния была
  // скрыта у ВСЕХ ролей, включая владельца проекта. Приведено к прецеденту контактов
  // (`POST /contacts/merge` → `contacts:manage`). Гейт FE обязан совпадать:
  // can('companies','manage').
  @RequirePermission('companies', 'manage')
  async previewCompanyMerge(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body() body: { masterId?: string; loserId?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.previewMerge(
        { project_id: projectId, master_id: body.masterId, loser_id: body.loserId },
        md,
      ) as never,
    )) as { field_conflicts?: Record<string, unknown>[] };
    // Relation counters (company.md §3.14 — "что переедет"). The canonical flat
    // `relations` block is the LOSER's linked-entity counts: everything the merge
    // re-links onto master (the deployed FE renders it as «Что переедет к основной
    // компании»). `relationsByCompany` additionally exposes both sides for a
    // before/after view. Each donor query is fail-soft (donor down ⇒ 0, never 500).
    //
    // Counted under an explicit PROJECT-WIDE scope (`projectWideMd`), NOT the
    // route's companies scope. Forwarding the companies scope to pipe/orders/
    // activity/documents/contact made the donors filter by THEIR own ownerId
    // predicate against companies-resolved ownerIds: the result was neither the
    // number of records the merge relinks (it relinks all of them) nor the number
    // the caller can see — a hybrid nobody could act on. `relationsScope` labels
    // the semantics for the contract and the UI.
    const countMd = this.projectWideMd(req, projectId);
    const masterId = body.masterId ?? '';
    const loserId = body.loserId ?? '';
    const [loserRel, masterRel] = await Promise.all([
      loserId
        ? this.companyRelationCounts(countMd, projectId, loserId)
        : this.emptyRelationCounts(),
      masterId
        ? this.companyRelationCounts(countMd, projectId, masterId)
        : this.emptyRelationCounts(),
    ]);
    return {
      fieldConflicts: r.field_conflicts ?? [],
      relations: loserRel,
      relationsByCompany: { master: masterRel, loser: loserRel },
      // 'project' = counters cover every record of the project that will be
      // relinked, including records outside the caller's own visibility scope.
      relationsScope: 'project' as const,
    };
  }

  private emptyRelationCounts(): CompanyRelationCounts {
    return {
      contacts: 0,
      deals: 0,
      orders: 0,
      activities: 0,
      documents: 0,
      contactsTruncated: false,
    };
  }

  /**
   * Relation counters for a single company (merge/preview, company.md §3.14).
   * Every donor query is fail-soft (donor down ⇒ 0), so a missing consumer
   * degrades a counter to 0, never a 500.
   *
   * `md` must be the project-wide metadata (`projectWideMd`): these are IMPACT
   * counters — "what the merge will relink" — not "what you can see".
   *
   * Counters read the donor's own `total`, never the length of the first page:
   * activities/documents used to report `min(real, LINKS_PAGE_SIZE)`, so a company
   * with 400 activities previewed as 100. Contacts use `filter_company_id` —
   * `total` is exact, `contactsTruncated` stays false on the count path.
   */
  private async companyRelationCounts(
    md: unknown,
    projectId: string,
    companyId: string,
  ): Promise<CompanyRelationCounts> {
    const [deals, orders, activities, documents, contacts] = await Promise.all([
      this.cardDeals(md, projectId, { company_id: companyId }).then((x) => x.total),
      this.cardOrders(md, projectId, { company_id: companyId }).then((x) => x.total),
      this.countLinkedActivities(md, projectId, 'company', companyId),
      this.countLinkedDocuments(md, projectId, 'company', companyId),
      this.countCompanyContacts(md, projectId, companyId),
    ]);
    return {
      contacts: contacts.total,
      deals,
      orders,
      activities,
      documents,
      contactsTruncated: contacts.truncated,
    };
  }

  /** Count of activities linked to an entity (donor `total`, not page length). Fail-soft ⇒ 0. */
  private async countLinkedActivities(
    md: unknown,
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<number> {
    try {
      const r = (await grpcBffCall(
        this.activity.listActivities(
          {
            project_id: projectId,
            page_index: 0,
            page_size: 1,
            link_entity_type: entityType,
            link_entity_id: entityId,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      return typeof r.total === 'number' ? r.total : (r.list ?? []).length;
    } catch {
      return 0;
    }
  }

  /** Count of document groups attached to an entity (donor `total`). Fail-soft ⇒ 0. */
  private async countLinkedDocuments(
    md: unknown,
    projectId: string,
    contextType: string,
    recordId: string,
  ): Promise<number> {
    try {
      const r = (await grpcBffCall(
        this.documents.listDocuments(
          {
            project_id: projectId,
            context_type: contextType,
            record_id: recordId,
            page_index: 0,
            page_size: 1,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      return typeof r.total === 'number' ? r.total : (r.list ?? []).length;
    } catch {
      return 0;
    }
  }

  /**
   * Count of contacts linked to companyId (reverse M2M). Fail-soft ⇒ 0.
   * Domain filter `ListContacts.filter_company_id` — точный total, без свипа.
   * `truncated` здесь всегда false: счётчик берёт `total` домена, а не длину
   * превью-страницы (усечение списка живёт в `contactsOfCompany`).
   */
  private async countCompanyContacts(
    md: unknown,
    projectId: string,
    companyId: string,
  ): Promise<{ total: number; truncated: boolean }> {
    try {
      const { total } = await this.contactsOfCompany(md, projectId, companyId);
      return { total, truncated: false };
    } catch {
      return { total: 0, truncated: false };
    }
  }

  @Post('companies/merge')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  // TODO-110/TODO-153: см. комментарий у `companies/merge/preview` — тот же гейт
  // `companies:manage` (ключ из каталога), а не `companies:execute`.
  @RequirePermission('companies', 'manage')
  async mergeCompanies(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body() body: { masterId?: string; loserId?: string; fieldDecisions?: Record<string, string> },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const fieldDecisions = Object.entries(body.fieldDecisions ?? {}).map(([field, winner]) => ({
      field,
      winner,
    }));
    const r = (await grpcBffCall(
      this.company.mergeCompanies(
        {
          project_id: projectId,
          master_id: body.masterId,
          loser_id: body.loserId,
          field_decisions: fieldDecisions,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return {
      masterId: r.master_id,
      loserId: r.loser_id,
      archiveId: r.archive_id,
      mergeState: r.merge_state,
    };
  }

  @Post('companies/merge/:archiveId/restore')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'manage')
  async restoreCompanyMerge(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('archiveId') archiveId: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const r = (await grpcBffCall(
      this.company.restoreMerge({ project_id: projectId, archive_id: archiveId }, md) as never,
    )) as Record<string, unknown>;
    return { loserId: r.loser_id, masterId: r.master_id, restored: r.restored };
  }

  @Post('companies/import')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'import')
  async importCompanies(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Query('projectId') projectId: string,
    @Body()
    body?: { fileContent?: string; filename?: string; mappingJson?: string; dedupMode?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // FR-COMPANIES-440: фронт (apiImportCompanies) шлёт multipart/form-data
    // (file + mappingJson + dedupMode) — @Body() для него пустой, файл до домена
    // не доезжал вовсе. Читаем части сами; JSON-путь оставлен для API-клиентов.
    const mp = await this.readMultipart(req);
    const fileContent = mp
      ? (mp.buffer ?? Buffer.alloc(0))
      : Buffer.from(body?.fileContent ?? '', 'utf8');
    if (fileContent.length === 0) throw new BadRequestException('файл импорта не передан');
    const mappingJson = normalizeImportMapping(
      mp ? (mp.field('mappingJson') ?? '') : (body?.mappingJson ?? ''),
    );
    const dedupMode = (mp ? mp.field('dedupMode') : body?.dedupMode) || 'skip';
    const filename = (mp ? mp.filename : body?.filename) ?? '';

    const r = (await grpcBffCall(
      this.company.importCompanies(
        {
          project_id: projectId,
          file_content: fileContent,
          filename,
          mapping_json: mappingJson,
          dedup_mode: dedupMode,
        },
        md,
      ) as never,
    )) as {
      created?: number;
      skipped?: number;
      updated?: number;
      errors?: { row?: number; message?: string }[];
    };
    // Домен отдаёт errors как repeated ImportRowError — мастер импорта ждёт
    // числовой счётчик `errors` + отдельный список `errorRows`. Без маппинга
    // React получал массив объектов в счётчик и падал на рендере шага «Итог».
    const errorRows = Array.isArray(r.errors) ? r.errors : [];
    return {
      created: Number(r.created ?? 0),
      updated: Number(r.updated ?? 0),
      skipped: Number(r.skipped ?? 0),
      errors: errorRows.length,
      errorRows: errorRows.map((e) => ({
        row: Number(e.row ?? 0),
        message: String(e.message ?? ''),
      })),
    };
  }

  @Get('companies/:id')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async getCompany(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.company.getCompany({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;
    return mapCompanyForClient(c, req);
  }

  @Post('companies')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'write')
  async createCompany(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.company.createCompany(
        {
          project_id: projectId,
          name: body.name,
          inn: body.inn,
          // TODO-042: forward the full requisites set the proto/domain already
          // supports — these were silently dropped here (FE save looked ok, data
          // lost). No defaults: undefined fields do not go over the wire, so a
          // partial payload never clears stored values.
          kpp: body.kpp,
          ogrn: body.ogrn,
          website: body.website,
          status: body.status,
          department_id: body.departmentId,
          region: body.region,
          legal_address: body.legalAddress,
          tags: body.tags,
          notes: body.notes,
          phone: body.phone,
          email: body.email,
          industry: body.industry,
          assignee_id: body.assigneeId,
          bank_name: body.bankName,
          bik: body.bik,
          correspondent_account: body.correspondentAccount,
          settlement_account: body.settlementAccount,
          trash_collision_resolution:
            typeof body.trashCollisionResolution === 'string' ? body.trashCollisionResolution : '',
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapCompanyForClient(c, req);
  }

  @Put('companies/:id')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'write')
  async updateCompany(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.company.updateCompany(
        {
          project_id: projectId,
          id,
          name: body.name,
          inn: body.inn,
          // TODO-042: forward the full requisites set (see createCompany above).
          kpp: body.kpp,
          ogrn: body.ogrn,
          website: body.website,
          status: body.status,
          department_id: body.departmentId,
          region: body.region,
          legal_address: body.legalAddress,
          tags: body.tags,
          notes: body.notes,
          phone: body.phone,
          email: body.email,
          industry: body.industry,
          assignee_id: body.assigneeId,
          bank_name: body.bankName,
          bik: body.bik,
          correspondent_account: body.correspondentAccount,
          settlement_account: body.settlementAccount,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapCompanyForClient(c, req);
  }

  @Delete('companies/:id')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'delete')
  async deleteCompany(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    // TODO-157: `force=true` — жёсткое удаление записи ИЗ КОРЗИНЫ («удалить
    // навсегда», CompanyTrash). Раньше параметр молча игнорировался, и кнопка
    // звала обычный soft-delete, который на уже удалённой записи отдавал NOT_FOUND
    // (findOne фильтрует `deletedAt: null`) — корзина не очищалась никогда.
    // Право то же — `companies:delete`: жёстче удаления из корзины ничего нет,
    // а отдельного ключа в каталоге модуля не существует.
    @Query('force') force?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const hardDelete = force === 'true' || force === '1';
    if (hardDelete) {
      await grpcBffCall(this.company.purgeCompany({ project_id: projectId, id }, md) as never);
      return { ok: true, purged: true };
    }
    await grpcBffCall(this.company.deleteCompany({ project_id: projectId, id }, md) as never);
    return { ok: true, purged: false };
  }

  @Patch('companies/:id/owner')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'write')
  async updateCompanyOwner(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { ownerId?: string; departmentId?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // TODO-366 (FR-COMPANIES-300, BR-COMPANIES-020): новый владелец обязан быть
    // участником ЭТОГО проекта. Без проверки компанию можно было переназначить на
    // произвольный userId — запись выпадала из видимости всех (ABAC-фильтр строится
    // по ownerId ∈ scope) и де-факто становилась «ничьей». Проверка fail-closed:
    // недоступный control ⇒ смена владельца не проходит.
    const nextOwnerId = (body.ownerId ?? '').trim();
    if (nextOwnerId) {
      const m = (await grpcBffCall(
        this.project.listMembers({ project_id: projectId }, md) as never,
      )) as { list?: { id?: string }[] };
      const members = Array.isArray(m.list) ? m.list : [];
      if (!members.some((member) => member?.id === nextOwnerId)) {
        throw new BadRequestException({
          code: 'OWNER_NOT_PROJECT_MEMBER',
          message: 'Новый владелец не является участником проекта',
        });
      }
    }
    // TODO(E2-08 ABAC/RFC-5): дополнительная проверка scope в gateway не нужна —
    // домен company валидирует цель через visibility metadata (ReassignTargetValidator).
    const c = (await grpcBffCall(
      this.company.updateOwner(
        {
          project_id: projectId,
          id,
          owner_id: body.ownerId,
          department_id: body.departmentId,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapCompanyForClient(c, req);
  }

  @Post('companies/:id/restore')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'write')
  async restoreCompany(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Body() body: { strategy?: string },
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const c = (await grpcBffCall(
      this.company.restoreCompany(
        { project_id: projectId, id, strategy: body?.strategy ?? '' },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return mapCompanyForClient(c, req);
  }

  @Get('companies/:id/contacts')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  // FR-COMPANIES-375: the payload is CONTACT data — it must be filtered by the
  // caller's contacts scope, not by their companies scope.
  @RequireDonorSubjects('contacts')
  async getCompanyContacts(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    // Visibility gate on the host record first (companies scope), so the route
    // cannot be used to probe contact links of a company the caller cannot see.
    const md = this.outboundMeta.build(req, { projectId });
    await grpcBffCall(this.company.getCompany({ project_id: projectId, id }, md) as never);
    const contactsMd = this.donorMd(req, projectId, 'contacts');
    if (!contactsMd) return { list: [], total: 0, truncated: false };
    const { list, total, truncated } = await this.contactsOfCompany(contactsMd, projectId, id);
    return { list, total, truncated };
  }

  @Get('companies/:id/history')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  async getCompanyHistory(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // Visibility gate: ensure the company itself is visible before exposing its history.
    await grpcBffCall(this.company.getCompany({ project_id: projectId, id }, md) as never);
    // FR-MCOM-23: real change history from the immutable audit chain.
    const r = (await grpcBffCall(
      this.audit.listEvents(
        {
          project_id: projectId,
          page_index: 0,
          page_size: parseHistoryPageSize(limit),
          entity_type: 'company',
          entity_id: id,
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const items = (r.list ?? []).map(mapHistoryEvent);
    return { items, hasMore: toNum(r.total) > items.length };
  }

  @Get('contacts/:id/history')
  @ApiTags('Contacts')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('contacts')
  @RequirePermission('contacts', 'read')
  async getContactHistory(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // Visibility gate: ensure the contact itself is visible before exposing its history.
    await grpcBffCall(this.contact.getContact({ project_id: projectId, id }, md) as never);
    // Real change history from the immutable audit chain (mirrors company history).
    const r = (await grpcBffCall(
      this.audit.listEvents(
        {
          project_id: projectId,
          page_index: 0,
          page_size: parseHistoryPageSize(limit),
          entity_type: 'contact',
          entity_id: id,
        },
        md,
      ) as never,
    )) as { list?: Record<string, unknown>[]; total?: number };
    const items = (r.list ?? []).map(mapHistoryEvent);
    return { items, hasMore: toNum(r.total) > items.length };
  }

  @Get('companies/:id/card')
  @ApiTags('Companies')
  @UseGuards(GatewayModuleGuard)
  @RequireModule('companies')
  @RequirePermission('companies', 'read')
  // FR-COMPANIES-375: the card serves data owned by four OTHER modules. Each donor
  // subject gets its own scope + ABAC predicate (see @RequireDonorSubjects); the
  // route's `companies:read` gate never becomes a read gate for deals/contacts/
  // orders/activities.
  @RequireDonorSubjects('contacts', 'deals', 'orders', 'activities')
  async getCompanyCard(
    @Req() req: FastifyRequest & { user?: { userId?: string } },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const rawCompany = (await grpcBffCall(
      this.company.getCompany({ project_id: projectId, id }, md) as never,
    )) as Record<string, unknown>;
    const cardContactsRev = Number(rawCompany.card_contacts_rev ?? 0);
    const cacheKey = this.companyCardCacheKey(projectId, id, cardContactsRev, req);
    const cached = this.companyCardCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.payload;
    }
    const company = mapCompanyForClient(rawCompany, req);
    // Per-donor metadata: `undefined` ⇒ the caller may not read that module, so the
    // block stays empty (fail-closed) instead of inheriting the companies scope.
    const contactsMd = this.donorMd(req, projectId, 'contacts');
    const dealsMd = this.donorMd(req, projectId, 'deals');
    const ordersMd = this.donorMd(req, projectId, 'orders');
    const activitiesMd = this.donorMd(req, projectId, 'activities');
    const [contactsRes, dealsRes, ordersRes, activities, history, wonTotal] = await Promise.all([
      contactsMd
        ? this.contactsOfCompany(contactsMd, projectId, id).catch(() => ({
            list: [] as Record<string, unknown>[],
            total: 0,
            truncated: false,
          }))
        : Promise.resolve({ list: [] as Record<string, unknown>[], total: 0, truncated: false }),
      dealsMd
        ? this.cardDeals(dealsMd, projectId, { company_id: id })
        : Promise.resolve({ list: [] as Record<string, unknown>[], total: 0 }),
      ordersMd
        ? this.cardOrders(ordersMd, projectId, { company_id: id })
        : Promise.resolve({ list: [] as Record<string, unknown>[], total: 0 }),
      activitiesMd
        ? this.cardActivities(activitiesMd, projectId, 'company', id)
        : Promise.resolve([] as Record<string, unknown>[]),
      this.cardHistory(md, projectId, 'company', id),
      dealsMd ? this.cardDealsWonCount(dealsMd, projectId, { company_id: id }) : Promise.resolve(0),
    ]);
    const payload = {
      company,
      contacts: contactsRes.list,
      deals: dealsRes.list,
      orders: ordersRes.list,
      activities,
      history,
      stats: {
        dealsTotal: dealsRes.total,
        dealsWon: wonTotal,
        ordersTotal: ordersRes.total,
        contactsCount: contactsRes.total,
        contactsTruncated: contactsRes.truncated,
      },
    };
    this.companyCardCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + COMPANY_CARD_CACHE_TTL_MS,
    });
    return payload;
  }

  /** Deals of an entity → {list: DealLite[], total}. Fail-soft ⇒ empty. */
  private async cardDeals(
    md: unknown,
    projectId: string,
    filter: { contact_id?: string; company_id?: string },
  ): Promise<{ list: Record<string, unknown>[]; total: number }> {
    try {
      const r = (await grpcBffCall(
        this.pipe.listDeals(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            ...filter,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      const list = (r.list ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        amount: d.amount,
        currency: d.currency,
        stageId: d.stage_id,
        stageName: d.stage_name,
        status: d.status,
        result: d.result,
        assigneeId: d.assignee_id,
        contactId: d.contact_id || undefined,
        companyId: d.company_id || undefined,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      }));
      return { list, total: typeof r.total === 'number' ? r.total : list.length };
    } catch {
      return { list: [], total: 0 };
    }
  }

  /** Count of won deals of an entity (stats.dealsWon). Fail-soft ⇒ 0. */
  private async cardDealsWonCount(
    md: unknown,
    projectId: string,
    filter: { contact_id?: string; company_id?: string },
  ): Promise<number> {
    try {
      const r = (await grpcBffCall(
        this.pipe.listDeals(
          { project_id: projectId, page_index: 0, page_size: 1, status: 'won', ...filter },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      return typeof r.total === 'number' ? r.total : (r.list ?? []).length;
    } catch {
      return 0;
    }
  }

  /** Orders of an entity → {list: OrderLite[], total}. Fail-soft ⇒ empty. */
  private async cardOrders(
    md: unknown,
    projectId: string,
    filter: { contact_id?: string; company_id?: string },
  ): Promise<{ list: Record<string, unknown>[]; total: number }> {
    try {
      const r = (await grpcBffCall(
        this.orders.listOrders(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            ...filter,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[]; total?: number };
      const list = (r.list ?? []).map((o) => ({
        id: o.id,
        number: o.number,
        typeId: o.type_id,
        typeName: o.type_name,
        stageId: o.stage_id,
        stageName: o.stage_name,
        status: o.status,
        dealId: o.deal_id || undefined,
        contactId: o.contact_id || undefined,
        companyId: o.company_id || undefined,
        assigneeId: o.assignee_id,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      }));
      return { list, total: typeof r.total === 'number' ? r.total : list.length };
    } catch {
      return { list: [], total: 0 };
    }
  }

  /** Activities of an entity → ActivityLite[]. Fail-soft ⇒ empty. */
  private async cardActivities(
    md: unknown,
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const r = (await grpcBffCall(
        this.activity.listActivities(
          {
            project_id: projectId,
            page_index: 0,
            page_size: V1DataBffController.LINKS_PAGE_SIZE,
            link_entity_type: entityType,
            link_entity_id: entityId,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        status: a.status,
        priority: a.priority,
        dueDate: a.due_date ?? null,
        assigneeId: a.assignee_id,
        overdue: a.overdue,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      }));
    } catch {
      return [];
    }
  }

  /** Change history of an entity from the audit chain. Fail-soft ⇒ empty. */
  private async cardHistory(
    md: unknown,
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const r = (await grpcBffCall(
        this.audit.listEvents(
          {
            project_id: projectId,
            page_index: 0,
            page_size: 50,
            entity_type: entityType,
            entity_id: entityId,
          },
          md,
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      return (r.list ?? []).map(mapHistoryEvent);
    } catch {
      return [];
    }
  }
}
