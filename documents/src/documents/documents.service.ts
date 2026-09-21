import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientGrpcProxy, RpcException } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  GW_METADATA,
  buildVisibilityFilter,
  evalGate,
  isRecordVisible,
  isDocumentContextType,
  isDocumentContextTypeOrNone,
  isDocumentUploadContextType,
  extractDocxPlaceholders,
  findUnknownDocumentVariableKeys,
  DOCUMENT_GLOBAL_VARIABLE_KEYS,
  validateRecordUploadBuffer,
  documentContextModuleId,
  type AbacNode,
  type AccessPredicate,
  type EmitIntent,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { S3Service } from '../s3/s3.service';
import { MetricsService } from '../metrics/metrics.service';
import { DocxValidator } from './docx-validator';
import { SEED_TEMPLATES } from './seed-templates';

/** Автор строк, посеянных box-провижинингом (нет живого пользователя). */
const SEED_AUTHOR = 'system';
/** Провижининг сеет шаблоны, только когда модуль `documents` включён в проекте. */
const DOCUMENTS_MODULE_ID = 'documents';

const OWNER_FIELD = 'ownerId';
/**
 * B2 — second ACL subject of a document group: the owner of the SOURCE record the
 * document was rendered from. The read gate is the UNION of the two subjects
 * (creator OR source-record owner), see `visibilityFilter`/`resolveGroupVisible`.
 */
const CONTEXT_OWNER_FIELD = 'contextOwnerId';
const ENGINE = 'docxtemplater';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Envelope `source` for every documents fact (RFC-4 §Р-1/§Р-2). */
const EVENT_SOURCE = 'documents';

/** DI token for the chat gRPC client (membership seam, SEC-C-3). */
export const CHAT_MEMBERSHIP_GRPC = 'CHAT_MEMBERSHIP_GRPC';

/** Deadline for the documents→chat membership probe. */
const CHAT_MEMBERSHIP_TIMEOUT_MS = parseInt(
  process.env.CHAT_MEMBERSHIP_TIMEOUT_MS ?? '3000',
  10,
);

/**
 * Metadata keys forwarded on the documents→chat membership call: the service key
 * + propagation subset, same contract as the deferred-scope hydrator → control
 * (the call happens strictly inside handling a gateway request whose key the
 * PEP already validated; no per-domain service key is provisioned).
 */
const CHAT_FORWARD_KEYS: readonly string[] = [
  GW_METADATA.SERVICE_API_KEY,
  GW_METADATA.GATEWAY_API_KEY_ID,
  GW_METADATA.REQUEST_ID,
  GW_METADATA.TRACEPARENT,
  GW_METADATA.TRACE_ID,
  GW_METADATA.GATEWAY_ISSUED_AT,
  GW_METADATA.ACTOR_TYPE,
  GW_METADATA.USER_ID,
  GW_METADATA.PROJECT_ID,
];

interface ChatMembershipClient {
  isConversationMember(
    req: { conversation_id: string },
    md: Metadata,
  ): Observable<{ is_member?: boolean }>;
}

/** Mongo duplicate-key (E11000) detector — plain insert or inside a TX. */
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string } | null;
  if (!e) return false;
  if (Number(e.code) === 11000) return true;
  return typeof e.message === 'string' && e.message.includes('E11000');
}

interface CreateTemplateInput {
  name?: string;
  context_type?: string;
  order_type_id?: string;
  bucket?: string;
  object_key?: string;
  file_hash?: string;
  size_bytes?: number;
  mime_type?: string;
  declared_variables?: string[];
}

interface CreateRevisionInput {
  name?: string;
  bucket?: string;
  object_key?: string;
  file_hash?: string;
  size_bytes?: number;
  mime_type?: string;
  declared_variables?: string[];
}

/**
 * B2: `owner_id`/`owner_department_id` are deliberately ABSENT from the create
 * inputs (proto fields 7/8 resp. 10/11 are `reserved`). A document's `ownerId` is
 * its CREATOR — a read-gate subject (`isGroupVisible`/`visibilityFilter`) — so it
 * is derived from the trusted `x-user-id` metadata and cannot be supplied by the
 * caller. The owner of the source record travels separately as `context_owner_id`
 * and is the SECOND gate subject (union, not replacement), so a document never
 * disappears from the record it belongs to.
 */
interface GenerateInput {
  template_id?: string;
  context_type?: string;
  record_id?: string;
  use_revision?: string;
  trigger_event_id?: string;
  context_owner_id?: string;
  context_owner_department_id?: string;
  values_json?: string;
  source_hash?: string;
  empty_required?: string[];
}

interface RegenerateInput {
  use_revision?: string;
  expected_version?: number;
  values_json?: string;
  source_hash?: string;
  empty_required?: string[];
}

interface UploadInput {
  name?: string;
  context_type?: string;
  record_id?: string;
  bucket?: string;
  object_key?: string;
  mime_type?: string;
  size_bytes?: number;
  file_hash?: string;
  /** See GenerateInput — source-record owner, the SECOND gate subject (B2). */
  context_owner_id?: string;
  context_owner_department_id?: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  private chatMembership?: ChatMembershipClient;

  constructor(
    private readonly mongo: MongoService,
    private readonly s3: S3Service,
    private readonly outbox: MongoOutboxStore,
    private readonly docx: DocxValidator,
    // Optional so unit tests can construct the service without a live client;
    // absence is fail-closed for chat downloads (UNAVAILABLE, never "allow").
    @Optional() @Inject(CHAT_MEMBERSHIP_GRPC) private readonly chatClient?: ClientGrpcProxy,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private getChatMembershipClient(): ChatMembershipClient | undefined {
    if (!this.chatClient) return undefined;
    if (!this.chatMembership) {
      this.chatMembership = this.chatClient.getService<ChatMembershipClient>('ChatService');
    }
    return this.chatMembership;
  }

  /**
   * box-провижининг: посеять 1–2 стартовых опубликованных шаблона на новый проект
   * (BX-DOCS-5 / §2.8 G5), чтобы библиотека шаблонов не была пустой из коробки и
   * фича «Документы» самодемонстрировалась с первого входа.
   *
   * Реюзает штатный путь загрузки: генерирует валидный DOCX с `{{переменными}}`
   * (`SEED_TEMPLATES`), заливает в S3 под префиксом проекта, затем зовёт тот же
   * `createTemplate` (санитайз + авто-детект `declared_variables`, BX-DOCS-1/2) и
   * `publishTemplate`. Идемпотентно: шаблон с тем же именем/контекстом не дублируем.
   * Best-effort и не фатально (как pipe/orders-провижининг): сбой одного шаблона
   * логируется и не блокирует остальные — проект уже создан.
   */
  async provisionDefaults(
    projectId: string,
    enabledModules: string[] = [],
  ): Promise<{ created: boolean; templates_created: number }> {
    this.validateProjectId(projectId);
    // Данных без модуля не создаём (INV-ONB-4): нет `documents` в наборе — выходим.
    if (!enabledModules.includes(DOCUMENTS_MODULE_ID)) {
      return { created: false, templates_created: 0 };
    }
    let count = 0;
    for (const spec of SEED_TEMPLATES) {
      try {
        // Идемпотентность: не плодим дубли при повторном провижининге/applyTemplate.
        const existing = await this.mongo.templates().findOne({
          projectId,
          name: spec.name,
          contextType: spec.contextType,
          deletedAt: { $in: [null, undefined] },
        });
        if (existing) continue;

        const bytes = await spec.build();
        const objectKey = `${projectId}/templates/seed/${spec.slug}.docx`;
        const fileHash = createHash('sha256').update(bytes).digest('hex');
        const { bucket } = await this.s3.uploadObject(objectKey, bytes, DOCX_MIME);

        const tpl = await this.createTemplate(projectId, SEED_AUTHOR, {
          name: spec.name,
          context_type: spec.contextType,
          bucket,
          object_key: objectKey,
          file_hash: fileHash,
          size_bytes: bytes.length,
          mime_type: DOCX_MIME,
        });
        await this.publishTemplate(projectId, tpl.id, SEED_AUTHOR);
        count += 1;
      } catch (err) {
        this.logger.warn(
          `Seed template "${spec.slug}" failed for project "${projectId}": ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }
    return { created: count > 0, templates_created: count };
  }

  /**
   * Sanitize an uploaded DOCX template BEFORE it is referenced by a revision
   * (FR-MDOC-9/10, SEC §3.3). The gateway has already put the file in S3 under
   * `{projectId}/`; we fetch it and statically inspect it for VBA/XXE/DDE/zip-bomb.
   * Fail-closed: an unreadable object → `TEMPLATE_INVALID` (not silently skipped).
   * Set `DOCUMENTS_DOCX_VALIDATION=off` only for legacy/seed paths.
   */
  private async validateTemplateFile(
    projectId: string,
    bucket: string,
    objectKey: string,
  ): Promise<Buffer | null> {
    // Returns the sanitized bytes so callers can auto-extract declared variables
    // without a second S3 fetch; `null` when validation is disabled (legacy/seed).
    // Allow-list + prefix MUST run even when DOCX validation is off (legacy/seed):
    // otherwise a foreign bucket/key is persisted and later fetched (SEC-C-1).
    const allowedBucket = this.s3.bucketName;
    if (bucket !== allowedBucket) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'bucket is not allowed',
      });
    }
    // Defense-in-depth: never fetch outside the project's S3 prefix (B-2).
    if (!objectKey.startsWith(`${projectId}/`)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Шаблон вне границы проекта',
        details: { code: 'TEMPLATE_INVALID', reason: 'not_ooxml' },
      } as never);
    }
    if (process.env.DOCUMENTS_DOCX_VALIDATION === 'off') return null;
    let body: Buffer;
    try {
      body = await this.s3.getObjectBuffer(bucket, objectKey);
    } catch {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Загруженный шаблон недоступен для проверки',
        details: { code: 'TEMPLATE_INVALID', reason: 'corrupt' },
      } as never);
    }
    this.docx.validate(body);
    return body;
  }

  /**
   * Auto-detect the `{{variables}}` a template declares straight from the DOCX
   * (FR-MDOC G2) — makes the form promise «переменные определяются автоматически»
   * true and lets `empty_required` compute. `body` is the just-sanitized buffer
   * (`validateTemplateFile`); when validation is disabled (legacy/seed) we keep
   * the caller-supplied list.
   */
  private declaredVarsFrom(body: Buffer | null, fallback?: string[]): string[] {
    if (!body) return fallback ?? [];
    return extractDocxPlaceholders(body);
  }

  /** FR-DOCS-080: declared placeholders must belong to the context catalog. */
  private validateDeclaredVariables(
    contextType: string,
    keys: string[],
    enabledModules?: string[],
  ): void {
    if (!isDocumentContextType(contextType)) return;
    const unknown = findUnknownDocumentVariableKeys(contextType, keys, enabledModules);
    if (unknown.length > 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `Неизвестные переменные шаблона: ${unknown.join(', ')}`,
        details: { code: 'UNKNOWN_VARIABLES', keys: unknown },
      });
    }
  }

  /**
   * FR-DOCS-325: generation/regeneration requires the context donor module to be
   * enabled in the project. Absent `enabledModules` metadata ⇒ fail-open (s2s).
   */
  private assertContextDonorEnabled(contextType: string, enabledModules?: string[]): void {
    if (!isDocumentContextType(contextType)) return;
    if (!Array.isArray(enabledModules)) return;
    const moduleId = documentContextModuleId(contextType);
    if (moduleId && !enabledModules.includes(moduleId)) {
      this.failedPrecondition(`Контекст недоступен: модуль «${moduleId}» выключен в проекте`);
    }
  }

  /**
   * FR-DOCS-162: validate uploaded bytes from S3 (magic bytes + size), never trust
   * client-supplied mime_type/size_bytes.
   */
  private async validateUploadedObject(
    bucket: string,
    objectKey: string,
  ): Promise<{ mimeType: string; sizeBytes: number }> {
    const buffer = await this.s3.getObjectBuffer(bucket, objectKey);
    const checked = validateRecordUploadBuffer(buffer);
    if (checked.ok === false) {
      const code = checked.code;
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message:
          code === 'FILE_TOO_LARGE'
            ? 'Файл превышает допустимый размер 20 МБ'
            : 'Неподдерживаемый тип файла',
        details: { code },
      });
    }
    return { mimeType: checked.mimeType, sizeBytes: buffer.length };
  }

  /**
   * Value-level drift diff over donor-resolved variables. Global keys are
   * excluded: the generate path injects `project.name` (gateway) and time
   * globals (renderer) into the snapshot/render, while the drift check only
   * carries the donor map — comparing globals would flag every document as
   * drifted (`project.name: "X" → —`) and `today`/`now` drift by definition.
   */
  private computeValuesDiff(
    stored: Record<string, string>,
    current: Record<string, string>,
  ): {
    changed_keys: string[];
    changed_values: Array<{ key: string; old_value: string; new_value: string }>;
  } {
    const changed_keys: string[] = [];
    const changed_values: Array<{ key: string; old_value: string; new_value: string }> = [];
    const globals = new Set<string>(DOCUMENT_GLOBAL_VARIABLE_KEYS);
    const keys = new Set(
      [...Object.keys(stored), ...Object.keys(current)].filter((k) => !globals.has(k)),
    );
    for (const key of keys) {
      const oldValue = stored[key] ?? '';
      const newValue = current[key] ?? '';
      if (oldValue !== newValue) {
        changed_keys.push(key);
        changed_values.push({ key, old_value: oldValue, new_value: newValue });
      }
    }
    return { changed_keys, changed_values };
  }

  // ---- helpers ---------------------------------------------------------

  private validateProjectId(projectId: string) {
    if (!projectId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'project_id is required' });
    }
  }

  private invalid(message: string): never {
    throw new RpcException({ code: status.INVALID_ARGUMENT, message });
  }

  private notFound(message = 'Not found'): never {
    throw new RpcException({ code: status.NOT_FOUND, message });
  }

  private failedPrecondition(message: string): never {
    throw new RpcException({ code: status.FAILED_PRECONDITION, message });
  }

  private oid(id: string): ObjectId {
    if (!ObjectId.isValid(id)) this.notFound();
    return new ObjectId(id);
  }

  /**
   * B2 — ownership fields of a NEW document group, in one place for both create
   * paths (generate + upload).
   *
   * Invariants:
   *  1. `ownerId` (a read-gate subject of `resolveGroupVisible`) is the acting user.
   *     It is NOT readable from the request body, so a document can never be born
   *     owned by somebody else — which is exactly what used to 404 an author out
   *     of the document he had just generated on a record shared with him.
   *  2. Only a service-initiated call (automation: no `x-user-id`) has no acting
   *     user; it falls back to the source record's owner, so the document still
   *     has an owner instead of being visible to `mode:'all'` viewers only.
   *  3. `ownerDepartmentId` always describes `ownerId` — documents cannot resolve
   *     a user's department, so it is filled only in case (2), where the owner IS
   *     the record owner.
   *  4. `contextOwnerId` is the denormalized owner of the source record. It is a
   *     SECOND read-gate subject (union with `ownerId`, see `visibilityFilter`),
   *     never a replacement for it: whoever may see the source record keeps
   *     seeing the documents rendered from it, even when a colleague generated
   *     them. `contextOwnerDepartmentId` stays reporting-only.
   */
  private ownershipFor(
    userId: string,
    input: { context_owner_id?: string; context_owner_department_id?: string },
  ) {
    const contextOwnerId = input.context_owner_id ?? '';
    const contextOwnerDepartmentId = input.context_owner_department_id ?? '';
    const ownerId = userId || contextOwnerId;
    return {
      ownerId,
      ownerDepartmentId: ownerId && ownerId === contextOwnerId ? contextOwnerDepartmentId : '',
      contextOwnerId,
      contextOwnerDepartmentId,
    };
  }

  /** Record ids shared with the viewer, as ObjectIds (for document_groups). */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  /** Malformed ABAC predicate → match-nothing fragment (RFC-ABAC §4 fail-closed). */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /** Push the three-state ABAC predicate onto a Mongo `$and` array (RFC-ABAC §4). */
  private applyAccess(and: Record<string, unknown>[], access?: AccessPredicate): void {
    if (access?.present && 'malformed' in access && access.malformed) {
      and.push({ _id: DocumentsService.DENY_ALL_ID });
      return;
    }
    if (
      access?.present &&
      !('malformed' in access && access.malformed) &&
      'mongo' in access &&
      access.mongo &&
      Object.keys(access.mongo).length
    ) {
      and.push(access.mongo);
    }
  }

  /** Single-record ABAC gate (`evalGate` side of the contract-equivalent pair). */
  private passesAccessGate(record: Record<string, unknown>, access?: AccessPredicate): boolean {
    if (!access || !access.present) return true;
    if ('malformed' in access && access.malformed) return false;
    if (!('ir' in access) || !access.ir) return true;
    try {
      return evalGate(access.ir as AbacNode, record);
    } catch {
      return false;
    }
  }

  /** RFC-ABAC §4: malformed write predicate → fail-closed before any mutation (TODO-112). */
  private assertWriteAccess(access?: AccessPredicate): void {
    if (access?.present && 'malformed' in access && access.malformed) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'ABAC policy predicate is malformed',
      });
    }
  }

  /**
   * B2 — Mongo push-down for document visibility (never filter in memory).
   *
   * A document group is visible when the viewer may see EITHER of its two
   * subjects: the creator (`ownerId`) or the owner of the record it documents
   * (`contextOwnerId`) — or the group itself is shared with them. The union is
   * what keeps both halves of the invariant true after ownership moved to the
   * creator:
   *  - the creator reads back the document he just generated on somebody else's
   *    record (that was the original B2 defect: instant 404 on your own file);
   *  - the owner of the record keeps seeing documents of HIS record that a
   *    colleague generated (the mirror defect the union closes here).
   *
   * Fail-closed contract is delegated to `buildVisibilityFilter` and MUST NOT be
   * widened here: `null` (mode 'all') stays `null`, and the deny-all fragment of
   * an absent/unhydrated-deferred scope is returned untouched — OR-ing anything
   * into it would turn "reveal nothing" into "reveal everything with a matching
   * contextOwnerId" (scope.ownerIds is empty exactly in those states).
   */
  private visibilityFilter(scope?: VisibilityScope): Record<string, unknown> | null {
    const base = buildVisibilityFilter<ObjectId>(scope, OWNER_FIELD, this.sharedObjectIds(scope));
    // mode 'all' → no narrowing; deny-all (no scope / deferred) → never widened.
    if (base === null || !scope || scope.deferred || scope.mode === 'all') return base;
    const or: Record<string, unknown>[] = [
      { [OWNER_FIELD]: { $in: scope.ownerIds } },
      // Empty ids are dropped: legacy/context-less groups store contextOwnerId ''
      // and must not match a scope that (defensively) carries a blank id.
      { [CONTEXT_OWNER_FIELD]: { $in: scope.ownerIds.filter((id) => id !== '') } },
    ];
    const shared = this.sharedObjectIds(scope);
    if (shared.length) or.push({ _id: { $in: shared } });
    return { $or: or };
  }

  /**
   * B2 — single-record twin of `visibilityFilter` (same union, same fail-closed
   * semantics, which live inside `isRecordVisible`).
   */
  private isGroupVisible(
    group: Record<string, unknown>,
    scope?: VisibilityScope,
    chatMembershipEnforced = false,
  ): boolean {
    // SEC-C-3 / M-CHAT-8: on the download path a chat attachment is gated by
    // conversation membership (getDownloadUrl calls chat.IsConversationMember
    // right after this resolve, fail-closed), so owner-scope must not hide it
    // from legitimate members. Every OTHER path (get / listVersions / regenerate
    // / drift / delete) has no membership gate and keeps the owner gate.
    if (chatMembershipEnforced && String(group.contextType ?? '') === 'chat') return true;
    const groupId = String((group._id as ObjectId | undefined)?.toString() ?? '');
    const shared = scope?.sharedRecordIds.includes(groupId) ?? false;
    if (isRecordVisible(scope, String(group.ownerId ?? ''), shared)) return true;
    const contextOwnerId = String(group.contextOwnerId ?? '');
    return contextOwnerId !== '' && isRecordVisible(scope, contextOwnerId);
  }

  private parseValues(json?: string): Record<string, string> {
    if (!json?.trim()) return {};
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = v == null ? '' : String(v);
      }
      return out;
    } catch {
      return {};
    }
  }

  // ---- mappers ---------------------------------------------------------

  private toTemplate(d: Record<string, unknown>, revision?: Record<string, unknown> | null) {
    return {
      id: (d._id as ObjectId).toString(),
      project_id: String(d.projectId),
      name: String(d.name ?? ''),
      context_type: String(d.contextType ?? ''),
      order_type_id: String(d.orderTypeId ?? ''),
      status: String(d.status ?? 'draft'),
      current_revision: Number(d.currentRevision ?? 0),
      draft_revision: Number(d.draftRevision ?? 0),
      mime_type: String(d.mimeType ?? DOCX_MIME),
      created_by: String(d.createdBy ?? ''),
      created_at: Number(d.createdAt ?? 0),
      updated_at: Number(d.updatedAt ?? 0),
      ...(revision ? { revision: this.toRevision(revision) } : {}),
    };
  }

  private toRevision(d: Record<string, unknown>) {
    return {
      version: Number(d.version ?? 0),
      declared_variables: Array.isArray(d.declaredVariables) ? (d.declaredVariables as string[]) : [],
      file_hash: String(d.fileHash ?? ''),
      engine: String(d.engine ?? ENGINE),
      published_at: Number(d.publishedAt ?? 0),
      created_by: String(d.createdBy ?? ''),
      created_at: Number(d.createdAt ?? 0),
    };
  }

  private toGroup(d: Record<string, unknown>, currentVer?: Record<string, unknown> | null) {
    return {
      group_id: (d._id as ObjectId).toString(),
      project_id: String(d.projectId),
      context_type: String(d.contextType ?? ''),
      context_record_id: String(d.contextRecordId ?? ''),
      template_id: String(d.templateId ?? ''),
      name: String(d.name ?? ''),
      owner_id: String(d.ownerId ?? ''),
      owner_department_id: String(d.ownerDepartmentId ?? ''),
      // B2: source-record owner snapshot (reporting), separate from the ACL owner.
      context_owner_id: String(d.contextOwnerId ?? ''),
      context_owner_department_id: String(d.contextOwnerDepartmentId ?? ''),
      current_version: Number(d.currentVersion ?? 0),
      generated_via: String(d.generatedVia ?? ''),
      drift_stale: Boolean(d.driftStale ?? false),
      created_at: Number(d.createdAt ?? 0),
      updated_at: Number(d.updatedAt ?? 0),
      ...(currentVer
        ? {
            empty_required_vars: Array.isArray(currentVer.emptyRequiredVars)
              ? (currentVer.emptyRequiredVars as string[])
              : [],
            mime_type: String(currentVer.mimeType ?? ''),
          }
        : {}),
    };
  }

  /** Batch-load current-version rows for a list page (empty-vars / mime filters). */
  private async currentVersionsByGroup(
    projectId: string,
    groups: Record<string, unknown>[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const hints = groups
      .map((g) => ({
        documentGroupId: (g._id as ObjectId).toString(),
        version: Number(g.currentVersion ?? 0),
      }))
      .filter((h) => h.version > 0);
    if (!hints.length) return new Map();
    const rows = await this.mongo
      .documentVersions()
      .find({
        projectId,
        $or: hints.map((h) => ({ documentGroupId: h.documentGroupId, version: h.version })),
      })
      .toArray();
    return new Map(rows.map((r) => [String(r.documentGroupId), r as Record<string, unknown>]));
  }

  private toVersion(d: Record<string, unknown>) {
    return {
      version_id: (d._id as ObjectId).toString(),
      project_id: String(d.projectId),
      document_group_id: String(d.documentGroupId ?? ''),
      version: Number(d.version ?? 0),
      mime_type: String(d.mimeType ?? DOCX_MIME),
      size_bytes: Number(d.sizeBytes ?? 0),
      file_hash: String(d.fileHash ?? ''),
      template_id: String(d.templateId ?? ''),
      template_revision: Number(d.templateRevision ?? 0),
      empty_required_vars: Array.isArray(d.emptyRequiredVars) ? (d.emptyRequiredVars as string[]) : [],
      generated_by: String(d.generatedBy ?? ''),
      generated_via: String(d.generatedVia ?? ''),
      trigger_event_id: String(d.triggerEventId ?? ''),
      created_at: Number(d.createdAt ?? 0),
      bucket: String(d.bucket ?? ''),
      object_key: String(d.objectKey ?? ''),
    };
  }

  // =====================================================================
  // Templates (project-scoped, FR-MDOC-18)
  // =====================================================================

  async listTemplates(
    projectId: string,
    contextType?: string,
    recordId?: string,
    statusFilter?: string,
    orderTypeId?: string,
  ) {
    this.validateProjectId(projectId);
    const filter: Record<string, unknown> = { projectId, deletedAt: { $in: [null, undefined] } };
    if (contextType && isDocumentContextType(contextType)) filter.contextType = contextType;
    if (statusFilter) filter.status = statusFilter;
    // Default: archived templates never show unless explicitly requested (the
    // record-card branch below overwrites this with the stricter 'published').
    else filter.status = { $ne: 'archived' };
    // For a record card (contextType+recordId): only published (FR-MDOC-12). The
    // gateway narrows the order_type_id set via recordId→orderTypeId before/after.
    if (recordId && contextType && !statusFilter) {
      filter.status = 'published';
    }
    // BX-FLOW-4: narrow order templates to the record's sale type. The gateway
    // resolves record_id(order)→order.type_id and passes it as orderTypeId.
    // Generic order templates (blank orderTypeId) apply to every order type, so
    // keep them in the set alongside the exact-type match.
    if (contextType === 'order' && orderTypeId) {
      filter.orderTypeId = { $in: [orderTypeId, '', null, undefined] };
    }
    const rows = await this.mongo
      .templates()
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();
    return { list: rows.map((r) => this.toTemplate(r as Record<string, unknown>)) };
  }

  async getTemplate(projectId: string, id: string, version?: number) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const tpl = await this.mongo
      .templates()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } });
    if (!tpl) this.notFound('Шаблон не найден');
    const wantVersion =
      version && version > 0
        ? version
        : Number((tpl as Record<string, unknown>).currentRevision ?? 0);
    let revision: Record<string, unknown> | null = null;
    if (wantVersion > 0) {
      revision = (await this.mongo
        .templateRevisions()
        .findOne({ projectId, templateId: id, version: wantVersion })) as Record<
        string,
        unknown
      > | null;
      if (version && version > 0 && !revision) this.notFound('Редакция не найдена');
    }
    return this.toTemplate(tpl as Record<string, unknown>, revision);
  }

  /**
   * Secure download of a template revision's ORIGINAL DOCX (BX-DOCS-4 / G4).
   * Resolves the revision within the project (version>0 → that revision, else the
   * current published one, else the latest draft), validates the objectKey prefix
   * BEFORE S3, then returns a short-lived presigned URL. Never a public/permanent URL.
   */
  async getTemplateDownloadUrl(
    projectId: string,
    id: string,
    version: number | undefined,
    ttlSec?: number,
  ) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const tpl = (await this.mongo
      .templates()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } })) as Record<
      string,
      unknown
    > | null;
    if (!tpl) this.notFound('Шаблон не найден');
    const wantVersion =
      version && version > 0
        ? version
        : Number(tpl!.currentRevision ?? 0) || Number(tpl!.draftRevision ?? 0);
    if (!wantVersion) this.notFound('Редакция не найдена');
    const revision = (await this.mongo
      .templateRevisions()
      .findOne({ projectId, templateId: id, version: wantVersion })) as Record<
      string,
      unknown
    > | null;
    if (!revision) this.notFound('Редакция не найдена');
    // Defense-in-depth: objectKey must live under the project's prefix (SEC-C-1).
    const objectKey = String(revision!.objectKey ?? '');
    if (!objectKey.startsWith(`${projectId}/`)) this.notFound('Редакция не найдена');
    try {
      const signed = await this.s3.presignDownload(
        String(revision!.bucket ?? ''),
        objectKey,
        ttlSec,
      );
      return { url: signed.url, expires_at: signed.expiresAt };
    } catch {
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Хранилище временно недоступно',
      });
    }
  }

  async createTemplate(
    projectId: string,
    userId: string,
    input: CreateTemplateInput,
    enabledModules?: string[],
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    this.assertWriteAccess(access);
    const name = input.name?.trim();
    if (!name) this.invalid('name is required');
    const contextType = input.context_type;
    if (!contextType || !isDocumentContextType(contextType)) {
      this.invalid('contextType must be one of order|deal|contact|company');
    }
    this.assertContextDonorEnabled(contextType, enabledModules);
    if (input.order_type_id && contextType !== 'order') {
      this.invalid('orderTypeId допустим только для контекста order');
    }
    if (!input.object_key || !input.bucket) {
      this.invalid('template file (bucket/objectKey) is required');
    }
    // FR-MDOC-9/10: sanitize the uploaded DOCX (VBA/XXE/DDE/zip-bomb) BEFORE the
    // template/revision row is created — reject unsafe content with TEMPLATE_INVALID.
    const fileBytes = await this.validateTemplateFile(projectId, input.bucket, input.object_key);
    const declaredVariables = this.declaredVarsFrom(fileBytes, input.declared_variables);
    this.validateDeclaredVariables(contextType, declaredVariables, enabledModules);
    const now = Date.now();
    const templateId = new ObjectId();
    const tpl = {
      _id: templateId,
      projectId,
      name,
      contextType,
      orderTypeId: contextType === 'order' ? (input.order_type_id ?? '') : '',
      status: 'draft',
      currentRevision: 0,
      draftRevision: 1,
      mimeType: input.mime_type ?? DOCX_MIME,
      createdBy: userId,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.mongo.templates().insertOne(tpl);
    await this.mongo.templateRevisions().insertOne({
      _id: new ObjectId(),
      projectId,
      templateId: templateId.toString(),
      version: 1,
      bucket: input.bucket,
      objectKey: input.object_key,
      fileHash: input.file_hash ?? '',
      declaredVariables,
      engine: ENGINE,
      publishedAt: null,
      createdBy: userId,
      createdAt: now,
    });
    return this.toTemplate(tpl as unknown as Record<string, unknown>);
  }

  /** Editing a published template creates a NEW draft revision (FR-MDOC-2). */
  async createTemplateRevision(
    projectId: string,
    id: string,
    userId: string,
    input: CreateRevisionInput,
    enabledModules?: string[],
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    this.assertWriteAccess(access);
    const _id = this.oid(id);
    const tpl = (await this.mongo
      .templates()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } })) as Record<
      string,
      unknown
    > | null;
    if (!tpl) this.notFound('Шаблон не найден');
    const now = Date.now();
    const set: Record<string, unknown> = { updatedAt: now };
    if (input.name?.trim()) set.name = input.name.trim();

    // A new file → a new immutable draft revision (prior revisions untouched).
    if (input.object_key && input.bucket) {
      // FR-MDOC-9/10: same active-content sanitize as CreateTemplate (SEC §3.4).
      const fileBytes = await this.validateTemplateFile(projectId, input.bucket, input.object_key);
      const declaredVariables = this.declaredVarsFrom(fileBytes, input.declared_variables);
      this.validateDeclaredVariables(String(tpl.contextType), declaredVariables, enabledModules);
      const baseVersion = Math.max(
        Number(tpl.currentRevision ?? 0),
        Number(tpl.draftRevision ?? 0),
      );
      const newVersion = baseVersion + 1;
      await this.mongo.templateRevisions().insertOne({
        _id: new ObjectId(),
        projectId,
        templateId: id,
        version: newVersion,
        bucket: input.bucket,
        objectKey: input.object_key,
        fileHash: input.file_hash ?? '',
        declaredVariables,
        engine: ENGINE,
        publishedAt: null,
        createdBy: userId,
        createdAt: now,
      });
      set.draftRevision = newVersion;
    }
    await this.mongo.templates().updateOne({ _id, projectId }, { $set: set });
    const updated = await this.mongo.templates().findOne({ _id, projectId });
    return this.toTemplate(updated as Record<string, unknown>);
  }

  async publishTemplate(projectId: string, id: string, userId: string, version?: number) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const tpl = (await this.mongo
      .templates()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } })) as Record<
      string,
      unknown
    > | null;
    if (!tpl) this.notFound('Шаблон не найден');
    const target = version && version > 0 ? version : Number(tpl.draftRevision ?? 0);
    if (!target) {
      this.failedPrecondition('Нет черновой редакции для публикации');
    }
    const rev = (await this.mongo
      .templateRevisions()
      .findOne({ projectId, templateId: id, version: target })) as Record<
      string,
      unknown
    > | null;
    if (!rev) this.notFound('Редакция не найдена');
    const now = Date.now();
    // Publish mutations + `document.template_published` outbox row in one write
    // (RFC-4 §Р-3: no record without an event, no event without a record).
    const updated = await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await this.mongo
        .templateRevisions()
        .updateOne(
          { projectId, templateId: id, version: target },
          { $set: { publishedAt: Number(rev.publishedAt ?? 0) || now } },
          opt,
        );
      await this.mongo.templates().updateOne(
        { _id, projectId },
        {
          $set: {
            status: 'published',
            currentRevision: target,
            draftRevision: 0,
            updatedAt: now,
          },
        },
        opt,
      );
      const fresh = await this.mongo.templates().findOne({ _id, projectId }, opt);
      const intents: EmitIntent[] = [
        {
          type: 'document.template_published',
          source: EVENT_SOURCE,
          projectId,
          subject: `template/${id}`,
          idempotencyKey: `template.published:${id}:${target}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { templateId: id, version: target, by: userId },
        },
      ];
      return { result: fresh, intents };
    });
    return this.toTemplate(updated as Record<string, unknown>);
  }

  async archiveTemplate(projectId: string, id: string, userId: string) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const res = await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      const updated = await this.mongo
        .templates()
        .findOneAndUpdate(
          { _id, projectId, deletedAt: { $in: [null, undefined] } },
          { $set: { status: 'archived', updatedAt: Date.now() } },
          { returnDocument: 'after', ...opt },
        );
      if (!updated) this.notFound('Шаблон не найден');
      const intents: EmitIntent[] = [
        {
          type: 'document.template_archived',
          source: EVENT_SOURCE,
          projectId,
          subject: `template/${id}`,
          idempotencyKey: `template.archived:${id}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { templateId: id, by: userId },
        },
      ];
      return { result: updated, intents };
    });
    return this.toTemplate(res as Record<string, unknown>);
  }

  async listTemplateRevisions(projectId: string, id: string) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const tpl = await this.mongo
      .templates()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } });
    if (!tpl) this.notFound('Шаблон не найден');
    const rows = await this.mongo
      .templateRevisions()
      .find({ projectId, templateId: id })
      .sort({ version: -1 })
      .toArray();
    return { list: rows.map((r) => this.toRevision(r as Record<string, unknown>)) };
  }

  /** Soft-delete the template pointer; revisions are kept so existing documents
   * can still be regenerated by their fixed revision (FR-MDOC-3/3.8). */
  async deleteTemplate(projectId: string, id: string) {
    this.validateProjectId(projectId);
    const _id = this.oid(id);
    const res = await this.mongo
      .templates()
      .updateOne(
        { _id, projectId, deletedAt: { $in: [null, undefined] } },
        { $set: { deletedAt: Date.now() } },
      );
    if (!res.matchedCount) this.notFound('Шаблон не найден');
    return { ok: true };
  }

  // =====================================================================
  // Documents (owner-scoped, FR-MDOC-16)
  // =====================================================================

  private async resolveGroupVisible(
    projectId: string,
    groupId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    chatMembershipEnforced = false,
  ): Promise<Record<string, unknown>> {
    const _id = this.oid(groupId);
    const group = (await this.mongo
      .documentGroups()
      .findOne({ _id, projectId, deletedAt: { $in: [null, undefined] } })) as Record<
      string,
      unknown
    > | null;
    if (!group) this.notFound('Документ не найден');
    if (!this.isGroupVisible(group, scope, chatMembershipEnforced)) {
      // Mask existence (404, not 403) for records the viewer may not see.
      this.notFound('Документ не найден');
    }
    if (!this.passesAccessGate(group, access)) {
      this.notFound('Документ не найден');
    }
    return group;
  }

  async listDocuments(
    projectId: string,
    opts: {
      contextType?: string;
      recordId?: string;
      ownerId?: string;
      hasDrift?: boolean;
      from?: number;
      to?: number;
      pageIndex: number;
      pageSize: number;
      search?: string;
      sourceKind?: 'generated' | 'uploaded';
      fileType?: string;
      templateId?: string;
      emptyVarsOnly?: boolean;
    },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    if (opts.contextType === 'chat') return { list: [], total: 0 };
    const pageIndex = Math.max(opts.pageIndex, 0);
    const pageSize = Math.max(1, Math.min(opts.pageSize, 100));
    const groupMatch = this.buildListDocumentsGroupMatch(projectId, opts, scope, access);
    const needsVersionJoin = !!opts.fileType || opts.emptyVarsOnly === true;

    if (!needsVersionJoin) {
      const filter: Record<string, unknown> =
        groupMatch.length === 1 ? groupMatch[0] : { $and: groupMatch };
      const total = await this.mongo.documentGroups().countDocuments(filter);
      const rows = await this.mongo
        .documentGroups()
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(pageIndex * pageSize)
        .limit(pageSize)
        .toArray();
      const versionByGroup = await this.currentVersionsByGroup(
        projectId,
        rows as Record<string, unknown>[],
      );
      return {
        list: rows.map((r) => {
          const gid = (r._id as ObjectId).toString();
          return this.toGroup(r as Record<string, unknown>, versionByGroup.get(gid));
        }),
        total,
      };
    }

    const versionMatch = this.buildListDocumentsVersionMatch(opts);
    const pipeline: Record<string, unknown>[] = [
      { $match: groupMatch.length === 1 ? groupMatch[0] : { $and: groupMatch } },
      {
        $lookup: {
          from: 'document_versions',
          let: { gid: { $toString: '$_id' }, ver: '$currentVersion', pid: '$projectId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$documentGroupId', '$$gid'] },
                    { $eq: ['$version', '$$ver'] },
                    { $eq: ['$projectId', '$$pid'] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'currentVer',
        },
      },
      { $unwind: { path: '$currentVer', preserveNullAndEmptyArrays: false } },
      ...(versionMatch ? [{ $match: versionMatch }] : []),
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          rows: [{ $skip: pageIndex * pageSize }, { $limit: pageSize }],
        },
      },
    ];
    const agg = await this.mongo
      .documentGroups()
      .aggregate(pipeline)
      .toArray();
    const bucket = (agg[0] ?? {}) as {
      total?: { n?: number }[];
      rows?: Record<string, unknown>[];
    };
    const total = bucket.total?.[0]?.n ?? 0;
    const rows = bucket.rows ?? [];
    return {
      list: rows.map((r) => {
        const currentVer = r.currentVer as Record<string, unknown> | undefined;
        const { currentVer: _drop, ...group } = r;
        return this.toGroup(group, currentVer);
      }),
      total,
    };
  }

  private buildListDocumentsGroupMatch(
    projectId: string,
    opts: {
      contextType?: string;
      recordId?: string;
      ownerId?: string;
      hasDrift?: boolean;
      from?: number;
      to?: number;
      search?: string;
      sourceKind?: 'generated' | 'uploaded';
      templateId?: string;
    },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Record<string, unknown>[] {
    const and: Record<string, unknown>[] = [{ projectId, deletedAt: { $in: [null, undefined] } }];
    if (opts.contextType === 'chat') return and;
    if (opts.contextType && isDocumentContextTypeOrNone(opts.contextType)) {
      and.push({ contextType: opts.contextType });
    } else {
      and.push({ contextType: { $ne: 'chat' } });
    }
    if (opts.recordId) and.push({ contextRecordId: opts.recordId });
    if (opts.ownerId) and.push({ ownerId: opts.ownerId });
    if (opts.templateId) and.push({ templateId: opts.templateId });
    if (opts.hasDrift !== undefined) and.push({ driftStale: opts.hasDrift });
    if (opts.from) and.push({ createdAt: { $gte: opts.from } });
    if (opts.to) and.push({ createdAt: { $lte: opts.to } });
    if (opts.sourceKind === 'uploaded') and.push({ generatedVia: 'upload' });
    if (opts.sourceKind === 'generated') and.push({ generatedVia: { $ne: 'upload' } });
    const q = opts.search?.trim();
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(escaped, 'i');
      and.push({ $or: [{ name: rx }, { contextRecordId: rx }] });
    }
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    return and;
  }

  private buildListDocumentsVersionMatch(opts: {
    fileType?: string;
    emptyVarsOnly?: boolean;
  }): Record<string, unknown> | null {
    const clauses: Record<string, unknown>[] = [];
    if (opts.emptyVarsOnly) {
      clauses.push({
        $expr: {
          $gt: [{ $size: { $ifNull: ['$currentVer.emptyRequiredVars', []] } }, 0],
        },
      });
    }
    const ft = opts.fileType?.trim().toUpperCase();
    if (ft) {
      const mimeNeedle =
        ft === 'PDF'
          ? 'pdf'
          : ft === 'DOCX'
            ? 'wordprocessingml'
            : ft === 'XLSX'
              ? 'spreadsheetml'
              : ft === 'PPTX'
                ? 'presentationml'
                : '';
      const ext = `.${ft.toLowerCase()}`;
      const or: Record<string, unknown>[] = [{ name: { $regex: `${ext.replace('.', '\\.')}$`, $options: 'i' } }];
      if (mimeNeedle) {
        or.push({ 'currentVer.mimeType': { $regex: mimeNeedle, $options: 'i' } });
      }
      clauses.push({ $or: or });
    }
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private recordOperation(
    operation: 'generate' | 'regenerate' | 'upload' | 'download',
  ): void {
    this.metrics?.recordDocumentsOperation(operation);
  }

  async getDocument(
    projectId: string,
    groupId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    const group = await this.resolveGroupVisible(projectId, groupId, scope, access);
    const versions = await this.mongo
      .documentVersions()
      .find({ projectId, documentGroupId: groupId })
      .sort({ version: -1 })
      .toArray();
    // Drift is computed lazily by the gateway (it owns the donor call); the domain
    // exposes the cached `driftStale` flag — precise diff via CheckDrift.
    const drift = {
      has_drift: Boolean(group.driftStale ?? false),
      changed_keys: [] as string[],
      source_available: true,
    };
    return {
      group: this.toGroup(group),
      versions: versions.map((v) => this.toVersion(v as Record<string, unknown>)),
      drift,
    };
  }

  async listVersions(
    projectId: string,
    groupId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    await this.resolveGroupVisible(projectId, groupId, scope, access);
    const rows = await this.mongo
      .documentVersions()
      .find({ projectId, documentGroupId: groupId })
      .sort({ version: -1 })
      .toArray();
    return { list: rows.map((r) => this.toVersion(r as Record<string, unknown>)) };
  }

  /**
   * Generate the first version of a document for a context.
   *
   * documents does NOT accept caller-supplied values — the gateway resolves them
   * from the context donor via ResolveDocumentVariables and proxies the result
   * here as `values_json/source_hash/empty_required` (FR-MDOC-6, SEC §3.13).
   */
  async generateDocument(
    projectId: string,
    userId: string,
    input: GenerateInput,
    enabledModules?: string[],
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    this.assertWriteAccess(access);
    const templateId = input.template_id ?? '';
    const contextType = input.context_type ?? '';
    const recordId = input.record_id ?? '';
    if (!templateId) this.invalid('templateId обязателен');
    if (!contextType || !isDocumentContextType(contextType)) this.invalid('contextType обязателен');
    if (!recordId) this.invalid('recordId обязателен');
    this.assertContextDonorEnabled(contextType, enabledModules);

    const tpl = (await this.mongo
      .templates()
      .findOne({
        _id: this.oid(templateId),
        projectId,
        deletedAt: { $in: [null, undefined] },
      })) as Record<string, unknown> | null;
    if (!tpl) this.notFound('Шаблон не найден');
    if (String(tpl.status) !== 'published') {
      this.failedPrecondition('Генерация доступна только из опубликованного шаблона');
    }

    const triggerEventId = input.trigger_event_id?.trim();
    // Automation idempotency (FR-MDOC-13): replay returns the existing version.
    if (triggerEventId) {
      const existing = (await this.mongo.documentVersions().findOne({
        projectId,
        contextType,
        contextRecordId: recordId,
        templateId,
        triggerEventId,
      })) as Record<string, unknown> | null;
      if (existing) {
        const grp = (await this.mongo
          .documentGroups()
          .findOne({ _id: this.oid(String(existing.documentGroupId)), projectId })) as Record<
          string,
          unknown
        > | null;
        return {
          group: grp ? this.toGroup(grp) : undefined,
          version: this.toVersion(existing),
          warnings: { empty_required: [], drift_changed_keys: [], has_drift: false },
        };
      }
    }

    const templateRevision = Number(tpl.currentRevision ?? 0);
    const values = this.parseValues(input.values_json);
    const emptyRequired = input.empty_required ?? [];
    const generatedVia = triggerEventId ? 'automation' : 'manual';

    const now = Date.now();
    const groupId = new ObjectId();
    // Fetch the published revision DOCX from S3 and render it with the resolved
    // variable map (MDOC-9/10). First generation always uses the current revision.
    const zip = await this.loadRevisionZip(projectId, templateId, templateRevision);
    const fileBody = this.renderWithTemplate(zip, values);
    const fileHash = createHash('sha256').update(fileBody).digest('hex');
    const objectKey = `${projectId}/documents/${contextType}/${recordId}/${groupId.toString()}/v1-${now}.docx`;
    const uploaded = await this.s3.uploadObject(objectKey, fileBody, DOCX_MIME);

    const group = {
      _id: groupId,
      projectId,
      contextType,
      contextRecordId: recordId,
      templateId,
      // B2: creator owns the document (see ownershipFor).
      ...this.ownershipFor(userId, input),
      currentVersion: 1,
      name: String(tpl.name ?? 'Документ'),
      generatedVia,
      driftStale: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const version = {
      _id: new ObjectId(),
      projectId,
      documentGroupId: groupId.toString(),
      contextType,
      contextRecordId: recordId,
      version: 1,
      bucket: uploaded.bucket,
      objectKey,
      mimeType: DOCX_MIME,
      sizeBytes: fileBody.length,
      fileHash,
      templateId,
      templateRevision,
      valuesSnapshot: values,
      sourceHash: input.source_hash ?? '',
      emptyRequiredVars: emptyRequired,
      generatedBy: userId,
      generatedVia,
      ...(triggerEventId ? { triggerEventId } : {}),
      createdAt: now,
    };
    // group + version + `document.generated` outbox row in one write (NFR-MDOC-6,
    // RFC-4 §Р-3). On a replica set it is a real TX; on standalone dev Mongo the
    // store falls back to ordered inserts after the (already done) S3 upload.
    const gid = groupId.toString();
    try {
      await this.outbox.withOutbox(async (session) => {
        const opt = session ? { session } : {};
        await this.mongo.documentGroups().insertOne(group, opt);
        await this.mongo.documentVersions().insertOne(version, opt);
        const intents: EmitIntent[] = [
          {
            type: 'document.generated',
            source: EVENT_SOURCE,
            projectId,
            subject: `document/${gid}`,
            idempotencyKey: `${gid}:1`,
            userId: userId || undefined,
            actorType: generatedVia === 'automation' ? 'service' : 'user',
            payload: {
              groupId: gid,
              contextType,
              contextRecordId: recordId,
              templateId,
              templateRevision,
              version: 1,
              generatedVia,
              generatedBy: userId,
            },
          },
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      await this.s3.deleteObject(uploaded.bucket, objectKey).catch(() => undefined);
      if (isDuplicateKeyError(err)) {
        // Lost the idempotency race on `trigger_event_idempotency` (two
        // deliveries of the same trigger_event_id, FR-MDOC-13/FR-DOCS-140):
        // return the winner's version — same contract as the pre-insert check —
        // instead of surfacing a raw MongoServerError as gRPC UNKNOWN.
        if (triggerEventId) {
          const existing = (await this.mongo.documentVersions().findOne({
            projectId,
            contextType,
            contextRecordId: recordId,
            templateId,
            triggerEventId,
          })) as Record<string, unknown> | null;
          if (existing) {
            const grp = (await this.mongo
              .documentGroups()
              .findOne({ _id: this.oid(String(existing.documentGroupId)), projectId })) as Record<
              string,
              unknown
            > | null;
            return {
              group: grp ? this.toGroup(grp) : undefined,
              version: this.toVersion(existing),
              warnings: { empty_required: [], drift_changed_keys: [], has_drift: false },
            };
          }
        }
        throw new RpcException({
          code: status.ABORTED,
          message: 'Конфликт при сохранении версии документа, повторите запрос',
        });
      }
      throw err;
    }
    this.recordOperation('generate');
    return {
      group: this.toGroup(group as unknown as Record<string, unknown>),
      version: this.toVersion(version as unknown as Record<string, unknown>),
      warnings: {
        empty_required: emptyRequired,
        drift_changed_keys: [],
        has_drift: false,
      },
    };
  }

  async regenerateDocument(
    projectId: string,
    groupId: string,
    userId: string,
    input: RegenerateInput,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    enabledModules?: string[],
  ) {
    this.validateProjectId(projectId);
    const group = await this.resolveGroupVisible(projectId, groupId, scope, access);
    const contextType = String(group.contextType ?? '');
    this.assertContextDonorEnabled(contextType, enabledModules);
    const currentVersion = Number(group.currentVersion ?? 0);
    if (input.expected_version && input.expected_version !== currentVersion) {
      throw new RpcException({
        code: status.ABORTED,
        message: 'Документ изменён другим пользователем, перечитайте',
      });
    }
    const templateId = String(group.templateId ?? '');
    const recordId = String(group.contextRecordId ?? '');
    if (!templateId) {
      this.failedPrecondition('Перегенерация недоступна для загруженного документа');
    }
    const tpl = (await this.mongo
      .templates()
      .findOne({ _id: this.oid(templateId), projectId })) as Record<string, unknown> | null;

    // Resolve revision: source = revision of the latest version, current = template current.
    const latest = (await this.mongo
      .documentVersions()
      .findOne({ projectId, documentGroupId: groupId }, { sort: { version: -1 } })) as Record<
      string,
      unknown
    > | null;
    const templateRevision =
      input.use_revision === 'source'
        ? Number(latest?.templateRevision ?? 0)
        : Number(tpl?.currentRevision ?? latest?.templateRevision ?? 0);

    const values = this.parseValues(input.values_json);
    const emptyRequired = input.empty_required ?? [];
    const newVersion = currentVersion + 1;
    const now = Date.now();
    // Render from the resolved revision (source = original revision, current =
    // template's current) — MDOC-9/10, FR-MDOC-5.
    const zip = await this.loadRevisionZip(projectId, templateId, templateRevision);
    const fileBody = this.renderWithTemplate(zip, values);
    const fileHash = createHash('sha256').update(fileBody).digest('hex');
    const objectKey = `${projectId}/documents/${contextType || 'none'}/${recordId || groupId}/${groupId}/v${newVersion}-${now}.docx`;
    const uploaded = await this.s3.uploadObject(objectKey, fileBody, DOCX_MIME);

    const versionDoc = {
      _id: new ObjectId(),
      projectId,
      documentGroupId: groupId,
      contextType,
      contextRecordId: recordId,
      version: newVersion,
      bucket: uploaded.bucket,
      objectKey,
      mimeType: DOCX_MIME,
      sizeBytes: fileBody.length,
      fileHash,
      templateId,
      templateRevision,
      valuesSnapshot: values,
      sourceHash: input.source_hash ?? '',
      emptyRequiredVars: emptyRequired,
      generatedBy: userId,
      generatedVia: 'regenerate',
      createdAt: now,
    };
    const useRevision = input.use_revision === 'source' ? 'source' : 'current';
    // CAS + version insert + `document.regenerated` outbox row in one write
    // (RFC-4 §Р-3). A failed CAS throws ABORTED → aborts the tx, nothing written.
    try {
      await this.outbox.withOutbox(async (session) => {
        const opt = session ? { session } : {};
        // CAS on currentVersion (optimistic lock, §7.5).
        const cas = await this.mongo.documentGroups().updateOne(
          { _id: this.oid(groupId), projectId, currentVersion },
          {
            $set: {
              currentVersion: newVersion,
              generatedVia: 'regenerate',
              driftStale: false,
              updatedAt: now,
            },
          },
          opt,
        );
        if (!cas.matchedCount) {
          throw new RpcException({
            code: status.ABORTED,
            message: 'Документ изменён другим пользователем, перечитайте',
          });
        }
        await this.mongo.documentVersions().insertOne(versionDoc, opt);
        const intents: EmitIntent[] = [
          {
            type: 'document.regenerated',
            source: EVENT_SOURCE,
            projectId,
            subject: `document/${groupId}`,
            idempotencyKey: `${groupId}:${newVersion}`,
            userId: userId || undefined,
            actorType: userId ? 'user' : 'service',
            payload: {
              groupId,
              version: newVersion,
              useRevision,
              changedFromVersion: currentVersion,
              generatedBy: userId,
            },
          },
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      await this.s3.deleteObject(uploaded.bucket, objectKey).catch(() => undefined);
      throw err;
    }
    const updatedGroup = await this.mongo
      .documentGroups()
      .findOne({ _id: this.oid(groupId), projectId });
    this.recordOperation('regenerate');
    return {
      group: this.toGroup(updatedGroup as Record<string, unknown>),
      version: this.toVersion(versionDoc as unknown as Record<string, unknown>),
      warnings: { empty_required: emptyRequired, drift_changed_keys: [], has_drift: false },
    };
  }

  async uploadDocument(projectId: string, userId: string, input: UploadInput, access?: AccessPredicate) {
    this.validateProjectId(projectId);
    this.assertWriteAccess(access);
    const name = input.name?.trim();
    if (!name) this.invalid('name is required');
    const contextType = input.context_type || 'none';
    // M-CHAT-8: `chat` is a valid UPLOAD context (message attachments) alongside
    // the CRM record contexts + none — the chat BFF registers attachments through
    // this very RPC. SEC-C-3 membership is enforced on the chat-BFF upload path
    // (chat.GetConversation) and again on download; the generic gateway upload
    // route rejects `chat` before this RPC is ever reached.
    if (!isDocumentUploadContextType(contextType)) this.invalid('invalid contextType');
    const recordId = input.record_id ?? '';
    if (contextType !== 'none' && !recordId) {
      this.invalid('recordId обязателен при contextType≠none');
    }
    if (!input.object_key || !input.bucket) this.invalid('file (bucket/objectKey) is required');
    const objectKey = String(input.object_key);
    if (!objectKey.startsWith(`${projectId}/`)) {
      this.invalid('objectKey must be under the project prefix');
    }
    const allowedBucket = this.s3.bucketName;
    if (input.bucket !== allowedBucket) {
      this.invalid('bucket is not allowed');
    }

    const uploaded = await this.validateUploadedObject(input.bucket, objectKey);

    const now = Date.now();
    const groupId = new ObjectId();
    const group = {
      _id: groupId,
      projectId,
      contextType,
      contextRecordId: contextType === 'none' ? '' : recordId,
      templateId: '',
      // B2: the uploader owns the document in EVERY context, not just
      // contextType=none (FR-MDOC-17 generalized) — the ACL owner is no longer a
      // wire field, so there is nothing left to spoof.
      ...this.ownershipFor(userId, input),
      currentVersion: 1,
      name,
      generatedVia: 'upload',
      driftStale: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const versionDoc = {
      _id: new ObjectId(),
      projectId,
      documentGroupId: groupId.toString(),
      contextType,
      contextRecordId: contextType === 'none' ? '' : recordId,
      version: 1,
      bucket: input.bucket,
      objectKey: input.object_key,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      fileHash: input.file_hash ?? '',
      templateId: '',
      templateRevision: 0,
      valuesSnapshot: {},
      sourceHash: '',
      emptyRequiredVars: [],
      generatedBy: userId,
      generatedVia: 'upload',
      createdAt: now,
    };
    // group + version + `document.uploaded` outbox row in one write (RFC-4 §Р-3).
    const gid = groupId.toString();
    await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await this.mongo.documentGroups().insertOne(group, opt);
      await this.mongo.documentVersions().insertOne(versionDoc, opt);
      const intents: EmitIntent[] = [
        {
          type: 'document.uploaded',
          source: EVENT_SOURCE,
          projectId,
          subject: `document/${gid}`,
          idempotencyKey: `${gid}:1`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: {
            groupId: gid,
            contextType,
            contextRecordId: contextType === 'none' ? '' : recordId,
            uploadedBy: userId,
          },
        },
      ];
      return { result: undefined, intents };
    });
    this.recordOperation('upload');
    return {
      group: this.toGroup(group as unknown as Record<string, unknown>),
      version: this.toVersion(versionDoc as unknown as Record<string, unknown>),
    };
  }

  /**
   * Secure download (B-2). Resolves the version within the project, enforces the
   * owner-visibility of its group, validates the objectKey prefix BEFORE S3, then
   * returns a short-lived presigned URL. Never returns a public/permanent URL.
   */
  async getDownloadUrl(
    projectId: string,
    versionId: string,
    ttlSec: number | undefined,
    scope?: VisibilityScope,
    inboundMetadata?: Metadata,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    const _id = this.oid(versionId);
    const version = (await this.mongo
      .documentVersions()
      .findOne({ _id, projectId })) as Record<string, unknown> | null;
    if (!version) this.notFound('Версия документа не найдена');
    // Defense-in-depth: objectKey must live under the project's prefix.
    const objectKey = String(version.objectKey ?? '');
    if (!objectKey.startsWith(`${projectId}/`)) this.notFound('Версия документа не найдена');
    // Owner-visibility gate via the parent group (IDOR by versionId). Chat
    // attachments: membership (checked just below) replaces the owner gate on
    // THIS path only — a conversation member may download an attachment uploaded
    // by another member (SEC-C-3 / M-CHAT-8). ABAC access gate still runs.
    await this.resolveGroupVisible(
      projectId,
      String(version.documentGroupId),
      scope,
      access,
      true,
    );
    // M-CHAT-8 / SEC-C-3: a chat attachment is additionally gated by conversation
    // membership — chat is the membership source of truth. Applies on ANY route
    // reaching this RPC (chat BFF or the generic documents download), fail-closed.
    if (String(version.contextType ?? '') === 'chat') {
      await this.requireConversationMembership(
        String(version.contextRecordId ?? ''),
        inboundMetadata,
      );
    }
    try {
      const signed = await this.s3.presignDownload(String(version.bucket ?? ''), objectKey, ttlSec);
      this.recordOperation('download');
      return { url: signed.url, expires_at: signed.expiresAt };
    } catch {
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Хранилище временно недоступно',
      });
    }
  }

  /**
   * SEC-C-3 gate: require the requester (x-user-id from the trusted inbound
   * gateway metadata) to be an ACTIVE member of the chat conversation before a
   * chat attachment is presigned. Fail-closed on every edge:
   *  - no chat client configured / chat unreachable → UNAVAILABLE (never allow);
   *  - non-member, unknown conversation, or chat denies → NOT_FOUND (existence
   *    is masked, no member/non-member oracle).
   */
  private async requireConversationMembership(
    conversationId: string,
    inboundMetadata?: Metadata,
  ): Promise<void> {
    const client = this.getChatMembershipClient();
    if (!client) {
      this.logger.error(
        'chat membership check impossible: CHAT_MEMBERSHIP_GRPC client is not configured (CHAT_GRPC_URL) — denying chat attachment download (fail-closed)',
      );
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: 'Сервис чата временно недоступен',
      });
    }
    const md = new Metadata();
    for (const key of CHAT_FORWARD_KEYS) {
      const v = inboundMetadata?.get(key)?.[0];
      if (v != null) md.set(key, typeof v === 'string' ? v : v.toString());
    }
    let isMember = false;
    try {
      const res = await firstValueFrom(
        client
          .isConversationMember({ conversation_id: conversationId }, md)
          .pipe(timeout(CHAT_MEMBERSHIP_TIMEOUT_MS)),
      );
      isMember = res?.is_member === true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED || code === undefined) {
        // Transport failure (chat down / deadline / rxjs TimeoutError has no
        // gRPC code) — not an authorization decision; surface retryable.
        throw new RpcException({
          code: status.UNAVAILABLE,
          message: 'Сервис чата временно недоступен',
        });
      }
      // A real decision from chat (UNAUTHENTICATED / PERMISSION_DENIED /
      // NOT_FOUND / INVALID_ARGUMENT) → deny with masked existence.
      this.notFound('Версия документа не найдена');
    }
    if (!isMember) this.notFound('Версия документа не найдена');
  }

  /**
   * Drift status. documents is not the source of truth — the gateway supplies the
   * current source_hash/changedKeys (it owns the donor call). Here we compare it to
   * the last version's stored sourceHash. First generation (single version) → no drift.
   */
  async checkDrift(
    projectId: string,
    groupId: string,
    current: {
      sourceHash?: string;
      changedKeys?: string[];
      sourceAvailable?: boolean;
      currentValuesJson?: string;
    },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    await this.resolveGroupVisible(projectId, groupId, scope, access);
    if (current.sourceAvailable === false) {
      return {
        has_drift: false,
        changed_keys: [],
        changed_values: [],
        source_available: false,
      };
    }
    const versionsCount = await this.mongo
      .documentVersions()
      .countDocuments({ projectId, documentGroupId: groupId });
    const latest = (await this.mongo
      .documentVersions()
      .findOne({ projectId, documentGroupId: groupId }, { sort: { version: -1 } })) as Record<
      string,
      unknown
    > | null;
    // First generation has nothing to compare against (FR-MDOC-8).
    if (!latest || versionsCount === 0) {
      return {
        has_drift: false,
        changed_keys: [],
        changed_values: [],
        source_available: true,
      };
    }
    const storedHash = String(latest.sourceHash ?? '');
    // Legacy versions predating valuesSnapshot must not diff against `{}` —
    // that would flag every donor key as changed (false drift). No snapshot →
    // hash comparison only (plus the caller's legacy precomputed keys).
    const storedSnapshot = latest.valuesSnapshot as Record<string, string> | undefined;
    let changed_keys = current.changedKeys ?? [];
    let changed_values: Array<{ key: string; old_value: string; new_value: string }> = [];
    if (current.currentValuesJson && storedSnapshot && typeof storedSnapshot === 'object') {
      const diff = this.computeValuesDiff(
        storedSnapshot,
        this.parseValues(current.currentValuesJson),
      );
      changed_keys = diff.changed_keys;
      changed_values = diff.changed_values;
    }
    const hasDrift =
      (current.sourceHash != null && storedHash !== '' && current.sourceHash !== storedHash) ||
      changed_keys.length > 0;
    return { has_drift: hasDrift, changed_keys, changed_values, source_available: true };
  }

  async checkDriftBatch(
    projectId: string,
    groupIds: string[],
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    if (!Array.isArray(groupIds) || groupIds.length === 0 || groupIds.length > 100) {
      this.invalid('group_ids must be 1..100 items');
    }
    const oids = groupIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    const and: Record<string, unknown>[] = [
      { _id: { $in: oids }, projectId, deletedAt: { $in: [null, undefined] } },
    ];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };
    const groups = await this.mongo.documentGroups().find(filter).toArray();
    // visibility-filtered groups only; drift uses the cached staleness flag.
    return {
      items: groups.map((g) => ({
        group_id: (g._id as ObjectId).toString(),
        drift: {
          has_drift: Boolean((g as Record<string, unknown>).driftStale ?? false),
          changed_keys: [] as string[],
          source_available: true,
        },
      })),
    };
  }

  /** Soft-delete the group (Admin+ at gateway). S3 objects are kept (immutability). */
  async deleteDocument(
    projectId: string,
    groupId: string,
    userId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    await this.resolveGroupVisible(projectId, groupId, scope, access);
    // soft-delete + `document.deleted` outbox row (audit, RFC-4 §Р-3).
    await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await this.mongo
        .documentGroups()
        .updateOne({ _id: this.oid(groupId), projectId }, { $set: { deletedAt: Date.now() } }, opt);
      const intents: EmitIntent[] = [
        {
          type: 'document.deleted',
          source: EVENT_SOURCE,
          projectId,
          subject: `document/${groupId}`,
          idempotencyKey: `document.deleted:${groupId}`,
          userId: userId || undefined,
          actorType: userId ? 'user' : 'service',
          payload: { groupId, deletedBy: userId },
        },
      ];
      return { result: undefined, intents };
    });
    return { ok: true };
  }

  // ---- drift fan-out (FR-MDOC-30) --------------------------------------

  /**
   * Re-point contact-bound document groups/versions after `crm.contact.merged`.
   * Idempotent: a redelivery updates 0 rows when already reassigned.
   */
  async reassignContactDocuments(
    projectId: string,
    sourceContactIds: string[],
    targetContactId: string,
  ): Promise<{ groups: number; versions: number }> {
    this.validateProjectId(projectId);
    const sources = sourceContactIds.map((id) => id.trim()).filter(Boolean);
    const target = targetContactId.trim();
    if (!sources.length || !target) return { groups: 0, versions: 0 };

    const groupFilter = {
      projectId,
      contextType: 'contact',
      contextRecordId: { $in: sources },
      deletedAt: { $in: [null, undefined] },
    };
    const groupRes = await this.mongo.documentGroups().updateMany(groupFilter, {
      $set: { contextRecordId: target, updatedAt: Date.now() },
    });
    const versionRes = await this.mongo.documentVersions().updateMany(
      { projectId, contextType: 'contact', contextRecordId: { $in: sources } },
      { $set: { contextRecordId: target } },
    );
    // Keep contextOwnerId in sync when it still pointed at a merged-away contact.
    await this.mongo.documentGroups().updateMany(
      {
        projectId,
        contextType: 'contact',
        contextOwnerId: { $in: sources },
        deletedAt: { $in: [null, undefined] },
      },
      { $set: { contextOwnerId: target, updatedAt: Date.now() } },
    );
    return {
      groups: groupRes.modifiedCount ?? 0,
      versions: versionRes.modifiedCount ?? 0,
    };
  }

  /**
   * React to a source-record change (`crm.<entity>.updated`): every released
   * document group bound to that `(projectId, contextRecordId)` is flagged
   * `driftStale=true` and a `document.drift_detected` fact is emitted per group
   * (RFC-4 §5.2, FR-MDOC-30). Idempotent: a group already stale only re-emits
   * with the same `idempotencyKey` (`groupId:sourceHash`) so transport dedup
   * collapses redeliveries. Bypasses owner-visibility — this is a system
   * reaction to a trusted internal bus fact, not a user read.
   *
   * Returns the number of groups flagged (0 when no documents reference the
   * record — the common case, kept cheap by the
   * `{projectId,contextType,contextRecordId}` index).
   */
  async markDriftForRecord(
    projectId: string,
    contextType: string,
    recordId: string,
  ): Promise<number> {
    if (!projectId || !recordId || !isDocumentContextType(contextType)) return 0;
    const groups = (await this.mongo
      .documentGroups()
      .find({
        projectId,
        contextType,
        contextRecordId: recordId,
        deletedAt: { $in: [null, undefined] },
      })
      .toArray()) as Record<string, unknown>[];
    if (groups.length === 0) return 0;

    for (const g of groups) {
      const groupId = (g._id as ObjectId).toString();
      // sourceHash from the latest version makes the dedup key stable for a given
      // source state — a repeated update with the same hash is a no-op for dedup.
      const latest = (await this.mongo
        .documentVersions()
        .findOne({ projectId, documentGroupId: groupId }, { sort: { version: -1 } })) as Record<
        string,
        unknown
      > | null;
      const sourceHash = String(latest?.sourceHash ?? '') || String(Date.now());
      await this.outbox.withOutbox(async (session) => {
        const opt = session ? { session } : {};
        await this.mongo
          .documentGroups()
          .updateOne(
            { _id: g._id as ObjectId, projectId },
            { $set: { driftStale: true, updatedAt: Date.now() } },
            opt,
          );
        const intents: EmitIntent[] = [
          {
            type: 'document.drift_detected',
            source: EVENT_SOURCE,
            projectId,
            subject: `document/${groupId}`,
            idempotencyKey: `${groupId}:${sourceHash}`,
            actorType: 'service',
            payload: {
              groupId,
              contextType,
              contextRecordId: recordId,
              changedKeys: [] as string[],
            },
          },
        ];
        return { result: undefined, intents };
      });
    }
    return groups.length;
  }

  // ---- rendering -------------------------------------------------------

  /**
   * Locate the published DOCX template revision file in S3 for a render.
   *
   * `useRevision`:
   *   - `current` (default, FR-MDOC-5): the template's `currentRevision`;
   *   - `source`: the revision recorded on the version being regenerated
   *     (a historical document keeps rendering from its original revision).
   *
   * The revision row carries `{bucket, objectKey}`. The objectKey MUST live under
   * the project's S3 prefix (B-2, defense-in-depth) — a mismatch is treated as
   * "template unavailable" rather than fetched cross-project.
   */
  private async loadRevisionZip(
    projectId: string,
    templateId: string,
    revisionVersion: number,
  ): Promise<PizZip> {
    if (!(revisionVersion > 0)) {
      this.failedPrecondition('Нет опубликованной редакции шаблона для генерации');
    }
    const revision = (await this.mongo.templateRevisions().findOne({
      projectId,
      templateId,
      version: revisionVersion,
    })) as Record<string, unknown> | null;
    if (!revision) this.notFound('Редакция шаблона не найдена');
    const bucket = String(revision.bucket ?? '');
    const objectKey = String(revision.objectKey ?? '');
    if (!objectKey || !objectKey.startsWith(`${projectId}/`)) {
      // Never fetch outside the project's prefix — treat as unavailable, not 500.
      this.renderFailed('Файл шаблона недоступен', [
        { tag: '', message: 'template file outside project boundary' },
      ]);
    }
    let body: Buffer;
    try {
      body = await this.s3.getObjectBuffer(bucket, objectKey);
    } catch {
      this.renderFailed('Файл шаблона недоступен', [
        { tag: '', message: 'template file could not be read from storage' },
      ]);
    }
    try {
      return new PizZip(body);
    } catch {
      this.renderFailed('Файл шаблона повреждён', [
        { tag: '', message: 'template is not a valid OOXML/zip archive' },
      ]);
    }
  }

  /**
   * Service-injected variables merged on top of the donor-resolved values so
   * placeholders like `{{today}}` always resolve even if the donor omitted them.
   * Donor values win over defaults (the donor is the source of truth for the
   * contact/company/deal/order variable groups); only unset keys get a default.
   */
  private withServiceVariables(values: Record<string, string>): Record<string, string> {
    const now = new Date();
    const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD, timezone-stable
    // Time globals advertised by the catalog (document-variables-catalog GLOBAL_VARS)
    // are all injected here so none is ever silently empty (BX-DOCS-3/G3). The
    // remaining global `project.name` needs project metadata the documents domain
    // does not hold, so the gateway injects it into `values` before rendering.
    const defaults: Record<string, string> = {
      today: iso,
      'today.iso': iso,
      'today.year': iso.slice(0, 4),
      now: now.toISOString(),
    };
    const merged: Record<string, string> = { ...defaults };
    for (const [k, v] of Object.entries(values)) merged[k] = v;
    return merged;
  }

  /** Domain render error (never a bare 500) — carries per-tag details. */
  private renderFailed(
    message: string,
    details: { tag: string; message: string }[],
  ): never {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message,
      details: { code: 'TEMPLATE_RENDER_FAILED', errors: details },
    } as never);
  }

  /**
   * Render the DOCX by running docxtemplater over the published revision file
   * (fetched from S3) with the donor-resolved variable map (FR-MDOC-6, MDOC-9/10).
   *
   * Placeholders are flat, dotted tags (`{{contact.name}}`, `{{company.inn}}`,
   * `{{deal.amount}}`, `{{order.field.<key>}}`, `{{today}}`). The donor delivers a
   * FLAT `values` map keyed exactly by those dotted names, so a custom parser
   * resolves the WHOLE tag against the map (docxtemplater's default dot-splitting
   * would look for nested objects that don't exist). Unknown tags resolve to an
   * empty string via `nullGetter` — a missing variable must NOT crash the render
   * (drift/empty-required are non-blocking warnings, FR-MDOC-7).
   *
   * Security: no macro execution — docxtemplater only substitutes text nodes; the
   * upload sanitizer already stripped VBA/DDE/XXE (FR-MDOC-9/10). Template syntax
   * errors are collected and surfaced as a domain `TEMPLATE_RENDER_FAILED`.
   */
  private renderWithTemplate(zip: PizZip, values: Record<string, string>): Buffer {
    const data = this.withServiceVariables(values);
    let doc: Docxtemplater;
    try {
      doc = new Docxtemplater(zip, {
        // Placeholders in templates use the `{{tag}}` mustache syntax (spec §3).
        delimiters: { start: '{{', end: '}}' },
        paragraphLoop: true,
        linebreaks: true,
        // Resolve the full dotted tag against the flat donor map.
        parser: (tag: string) => ({
          get: (scope: unknown) => {
            if (Object.prototype.hasOwnProperty.call(data, tag)) return data[tag];
            // Fall back to scope access (loop items) so section loops still work.
            if (scope && typeof scope === 'object' && tag in (scope as Record<string, unknown>)) {
              return (scope as Record<string, unknown>)[tag];
            }
            return undefined;
          },
        }),
        // Missing variable → empty string (never throw, FR-MDOC-7).
        nullGetter: () => '',
      });
    } catch (err) {
      this.renderFailed('Ошибка компиляции шаблона', this.docxErrors(err));
    }
    try {
      doc.render();
    } catch (err) {
      // docxtemplater raises a multi-error aggregate for template problems —
      // surface the tag-level details as a domain error, not a bare 500.
      this.renderFailed('Ошибка рендера шаблона', this.docxErrors(err));
    }
    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  }

  /** Flatten a docxtemplater (multi-)error into `{tag, message}` details. */
  private docxErrors(err: unknown): { tag: string; message: string }[] {
    const e = err as { properties?: { errors?: unknown[]; id?: string }; message?: string };
    const inner = e?.properties?.errors;
    if (Array.isArray(inner) && inner.length) {
      return inner.map((it) => {
        const p = (it as { properties?: { xtag?: string; explanation?: string; id?: string } })
          .properties;
        return {
          tag: String(p?.xtag ?? ''),
          message: String(p?.explanation ?? p?.id ?? (it as { message?: string })?.message ?? 'ошибка шаблона'),
        };
      });
    }
    return [{ tag: '', message: String(e?.message ?? 'ошибка шаблона') }];
  }

  /**
   * BX-OFFB-2: reassign every live document group owned by a departing member to
   * the new responsible. Emits one `document.owner_reassigned` per group so
   * visibility/denorm stay in sync — never a blunt `updateMany` without events.
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
    const coll = this.mongo.documentGroups();
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
        const gid = d._id.toString();
        return {
          type: 'document.owner_reassigned',
          source: EVENT_SOURCE,
          projectId,
          subject: `document/${gid}`,
          idempotencyKey: `document.reassigned:${gid}:${offboardTs}`,
          actorType: 'service',
          payload: {
            groupId: gid,
            changes: [{ field: 'ownerId', oldValue: from, newValue: to, changedAt }],
          },
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
    return this.mongo.documentGroups().countDocuments({
      projectId,
      ownerId: uid,
      deletedAt: null,
    });
  }
}
