import { Injectable } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import {
  buildDocumentVariablesResponse,
  evalGate,
  computeHiddenByPolicy,
  type AbacNode,
  type AccessPredicate,
  type DocumentVariablesResult,
  type EmitIntent,
  type OutboxCausation,
  type VisibilityScope,
} from '@fairflow/shared';
import { buildOwnableVisibilityFilter, isOwnableRecordVisible } from '@fairflow/shared';
import { MongoService, ContactDoc } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { ReassignTargetValidator } from './reassign-target.validator';
import { CompanyRefValidator } from './company-ref.validator';
// Общий модуль нормализации: тот же код использует разовая миграция пересчёта
// ключей (contact/scripts/backfill-normalized-keys.ts) — копия правил разъехалась бы.
import { normalizeEmail, normalizePhone, DEFAULT_PHONE_COUNTRY_CODE } from './normalize';
import { ProjectModuleSettingsService } from '../control/project-module-settings.service';
import { AppError } from '@fairflow/shared';
import { companyIdsFromLinks, normalizeCompanyLinks, remapCompanyRefs } from './company-links';
import { buildContactCreatedEventPayload } from './contact-event-payload';

type ContactDocWithId = ContactDoc & { _id: ObjectId };

const OWNER_FIELD = 'ownerId';
const DEPARTMENT_FIELD = 'departmentId';
const OWNER_SCOPE_UNASSIGNED = '__unassigned__';

/** Hard upper bound on page size to cap query cost / response payload (#13). */
const MAX_PAGE_SIZE = 100;

/** Сколько теней слияния отдавать в карточке (TODO-161) — карточка, не список. */
const MERGED_SOURCES_LIMIT = 20;

/** Fields the client must never set directly (computed/state-owned by the domain). */
const STRIPPED_UPDATE_FIELDS = [
  '_id',
  'projectId',
  'createdAt',
  'ownerId', // owner change only via reassign (S7, FR-MCON-24)
  'departmentId',
  'phoneNormalized',
  'emailNormalized',
  'mergedInto',
  'mergedAt',
  'deleteReason',
  'purgeAt',
  'deletedAt',
] as const;

/** Escape user input before using it in a RegExp (S11, anti-ReDoS). */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * TODO-161: окно отката слияния (FR-CONTACTS-260) — 30 дней.
 *
 * Единственный источник правды сразу для двух мест: `purgeAt` тени слияния (её
 * физически удаляет TTL-индекс `ttl_purge_at`) и явная проверка срока в
 * `unmerge`. Держать проверку ТОЛЬКО на TTL нельзя: демон TTL в Mongo ходит раз
 * в ~60 с и на большой коллекции отстаёт, поэтому «просроченный» откат мог
 * пройти; а когда тень уже удалена — пользователь получал 404 «отменять нечего»
 * вместо внятного «срок истёк».
 */
const UNMERGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Крайний срок отката для тени слияния, epoch ms. `null` — срок неизвестен
 * (запись слита до появления `mergedAt`): такие откатываем без ограничения, а не
 * запрещаем — потерять данные хуже, чем разрешить поздний откат легаси-записи.
 * `purgeAt` — только фолбэк: его двигает TTL-политика, а окно задаёт mergedAt.
 */
function mergeRevertDeadline(
  doc: {
    mergedAt?: Date | null;
    purgeAt?: Date | null;
  },
  shadowWindowMs = UNMERGE_WINDOW_MS,
): number | null {
  if (doc.mergedAt) return new Date(doc.mergedAt).getTime() + shadowWindowMs;
  if (doc.purgeAt) return new Date(doc.purgeAt).getTime();
  return null;
}

/**
 * TODO-159: минимальная идентичность контакта. Домен принимал запись, у которой
 * пусты и имя, и фамилия, и телефон, и e-mail: она создавалась, но нормализованные
 * ключи не писались (`...(emailNormalized ? {…} : {})`), поэтому запись навсегда
 * оставалась невидимой и для дедуп-радара, и для партиал-уникальных индексов.
 * Правило жило только во фронте — то есть не жило вовсе (gateway тоже не проверял).
 *
 * Требуем: непустое имя ИЛИ фамилия И непустой телефон ИЛИ e-mail.
 */
function assertContactIdentity(next: {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
}): void {
  const hasName = !!((next.firstName ?? '').trim() || (next.lastName ?? '').trim());
  if (!hasName) {
    throw new AppError('invalid', 'Укажите имя или фамилию контакта', { field: 'lastName' });
  }
  const hasChannel = !!(normalizePhone(next.phone) || normalizeEmail(next.email));
  if (!hasChannel) {
    throw new AppError('invalid', 'Укажите телефон или e-mail контакта', { field: 'phone' });
  }
}

function maskEmail(email?: string): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return `${email[0] ?? ''}***`;
  return `${local[0] ?? ''}***@${domain}`;
}

function maskPhone(phone?: string): string {
  if (!phone) return '';
  const tail = phone.slice(-4);
  return `+***${tail}`;
}

function displayName(doc: Pick<ContactDoc, 'firstName' | 'lastName'>): string {
  return [doc.firstName, doc.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Required document variables the contact context always ships (documents §3.9
 * manifest). A blank one lands in `warnings.emptyRequired` on generate.
 */
export const CONTACT_REQUIRED_VARIABLES = ['contact.name'];

/**
 * Map a contact record (toResponse shape) to the flat document-variable map
 * (documents contract §4). Pure/no-IO so it is unit-testable in isolation. Keys
 * follow the `contact.*` manifest namespace consumed by DOCX templates.
 */
export function buildContactDocumentVariables(
  row: Record<string, unknown>,
): DocumentVariablesResult {
  const firstName = String(row.firstName ?? '');
  const lastName = String(row.lastName ?? '');
  const middleName = String(row.middleName ?? '');
  const fullName = [lastName, firstName, middleName].filter(Boolean).join(' ').trim();
  return buildDocumentVariablesResponse(
    {
      'contact.name': [firstName, lastName].filter(Boolean).join(' ').trim(),
      'contact.fullName': fullName,
      'contact.firstName': firstName,
      'contact.lastName': lastName,
      'contact.middleName': middleName,
      'contact.phone': String(row.phone ?? ''),
      'contact.email': String(row.email ?? ''),
      'contact.position': String(row.position ?? ''),
    },
    CONTACT_REQUIRED_VARIABLES,
  );
}

/** Серверные фильтры и сортировка списка контактов (proto ListContactsRequest). */
export interface ContactListOptions {
  source?: string;
  ownerId?: string;
  ownerScope?: string;
  inactiveDays?: number;
  filterTags?: string[];
  sortBy?: string;
  sortDir?: string;
  /** FR-MCOM-18 / API-GET-companies-contacts: reverse M2M lookup by company id. */
  companyId?: string;
}

/** Опции создания (proto CreateContactRequest). */
export interface ContactCreateOptions {
  trashCollisionResolution?: string;
  forceCreate?: boolean;
}

/**
 * Whitelist сортировки: поле приходит от клиента и уходит в `.sort()`, поэтому
 * произвольное имя пустило бы запрос мимо индексов (или по служебным полям вроде
 * emailNormalized). Неизвестное значение молча падает в дефолт — не 400: список
 * не должен ломаться из-за устаревшей ссылки с сохранённым параметром.
 *
 * Набор обязан совпадать с whitelist'ом gateway (`CONTACT_SORTABLE_FIELDS` в
 * `gateway/src/bff/v1-data-bff.controller.ts`): пропущенные там middleName /
 * position / source доезжали сюда и молча падали в дефолт `updatedAt desc` —
 * в таблице зажигалась стрелка сортировки, а порядок строк не менялся. Оба
 * списка — по колонкам ContactDoc; при добавлении сортируемой колонки правятся
 * вместе (паритет закреплён тестом contact-domain-rules.spec.ts).
 */
export const SORTABLE_FIELDS = new Set([
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

export function buildContactSort(sortBy?: string, sortDir?: string): Record<string, 1 | -1> {
  const field = sortBy && SORTABLE_FIELDS.has(sortBy) ? sortBy : 'updatedAt';
  const dir: 1 | -1 = sortDir === 'asc' ? 1 : -1;
  // Вторичный ключ — _id: без него страницы «плывут» на равных значениях.
  return field === 'updatedAt' ? { updatedAt: dir, _id: dir } : { [field]: dir, _id: dir };
}

/** Одна строка-пара очереди дублей, как её отдаёт агрегат (TODO-376). */
interface DuplicateQueueRow {
  _id: { key: string; on: string };
  first: unknown;
  other: unknown;
}
/** Результат `$facet`: страница пар + общее число пар, посчитанное в БД. */
interface DuplicateQueueFacet {
  rows: DuplicateQueueRow[];
  total: { n: number }[];
}

/**
 * TODO-376: конвейер очереди дублей.
 *
 * Что чинится:
 *  - пары строятся ОТНОСИТЕЛЬНО ПЕРВОГО элемента группы (1↔2, 1↔3, …), а не
 *    поштучной нарезкой `i, i+1` с шагом 2: в группе из трёх одинаковых контактов
 *    третий не попадал в очередь вообще, в группе из пяти терялся пятый;
 *  - `$skip`/`$limit` живут В КОНВЕЙЕРЕ, а не в `Array.prototype.slice` над всеми
 *    группами проекта; `total` считает `$count` в той же выборке (`$facet`).
 *
 * Экспортируется, чтобы конвейер можно было проверить тестом без живой Mongo.
 */
export function buildDuplicateQueuePipeline(
  match: Record<string, unknown>,
  pageIndex: number,
  pageSize: number,
): Record<string, unknown>[] {
  return [
    {
      $match: {
        ...match,
        $or: [{ emailNormalized: { $gt: '' } }, { phoneNormalized: { $gt: '' } }],
      },
    },
    {
      $project: {
        keys: {
          $filter: {
            input: [
              { key: '$emailNormalized', on: 'email' },
              { key: '$phoneNormalized', on: 'phone' },
            ],
            as: 'k',
            cond: { $gt: ['$$k.key', null] },
          },
        },
      },
    },
    { $unwind: '$keys' },
    { $group: { _id: { key: '$keys.key', on: '$keys.on' }, ids: { $push: '$_id' } } },
    { $match: { 'ids.1': { $exists: true } } },
    {
      $project: {
        first: { $arrayElemAt: ['$ids', 0] },
        others: { $slice: ['$ids', 1, { $subtract: [{ $size: '$ids' }, 1] }] },
      },
    },
    { $unwind: '$others' },
    { $project: { first: 1, other: '$others' } },
    // Детерминированный порядок — иначе страницы «плывут» между запросами.
    { $sort: { '_id.key': 1, '_id.on': 1, other: 1 } },
    {
      $facet: {
        rows: [{ $skip: pageIndex * pageSize }, { $limit: pageSize }],
        total: [{ $count: 'n' }],
      },
    },
  ];
}

/**
 * Actor/lineage context carried from the gRPC controller into emits (RFC-4 §Р-1).
 * `metadata` — входящая метадата gateway; нужна там, где домену приходится
 * переспросить control (TODO-160): своего сервисного ключа у домена нет,
 * пробрасывается ключ вызывающего запроса.
 */
type Ctx = { userId?: string; causation?: OutboxCausation; metadata?: Metadata };

/** A single field change for `crm.contact.updated` payload (contract §3.3, RFC-4). */
interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy?: string;
  changedAt: number;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    // TODO-160. Значение по умолчанию — только чтобы не переписывать конструкторы
    // в юнит-тестах, которые reassign не трогают: без control-клиента валидатор
    // отказывает (fail-closed), а не пропускает.
    private readonly reassignTargets: ReassignTargetValidator = new ReassignTargetValidator(),
    private readonly companyRefs: CompanyRefValidator = new CompanyRefValidator(),
    private readonly moduleSettings: ProjectModuleSettingsService = {
      getIntegrationSettings: async () => ({}),
    } as unknown as ProjectModuleSettingsService,
  ) {}

  private async phoneCountryCode(projectId: string): Promise<string> {
    const settings = await this.moduleSettings.getIntegrationSettings(projectId, 'contacts');
    const raw = typeof settings.defaultCountry === 'string' ? settings.defaultCountry.trim() : '';
    const digits = raw.replace(/\D/g, '');
    return digits || DEFAULT_PHONE_COUNTRY_CODE;
  }

  private async normalizePhoneForProject(
    projectId: string,
    phone?: string | null,
  ): Promise<string | undefined> {
    return normalizePhone(phone, await this.phoneCountryCode(projectId));
  }

  private async trashTtlMs(projectId: string): Promise<number> {
    const settings = await this.moduleSettings.getIntegrationSettings(projectId, 'contacts');
    const days = Number(settings.trashTtlDays);
    if (Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
    return 7 * 24 * 60 * 60 * 1000;
  }

  private async shadowWindowMs(projectId: string): Promise<number> {
    const settings = await this.moduleSettings.getIntegrationSettings(projectId, 'contacts');
    const days = Number(settings.shadowTtlDays);
    if (Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
    return UNMERGE_WINDOW_MS;
  }

  private async driftDetectionEnabled(projectId: string): Promise<boolean> {
    const settings = await this.moduleSettings.getIntegrationSettings(projectId, 'contacts');
    if (settings.driftDetectionEnabled === false) return false;
    return true;
  }

  /** Record ids shared with the viewer (resolved upstream), as ObjectIds. */
  private sharedObjectIds(scope?: VisibilityScope): ObjectId[] {
    if (!scope) return [];
    return scope.sharedRecordIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  }

  /** FR-CONTACTS-285: owner XOR department visibility. */
  private visibilityFilter(scope?: VisibilityScope): Record<string, unknown> | null {
    return buildOwnableVisibilityFilter<ObjectId>(
      scope,
      OWNER_FIELD,
      DEPARTMENT_FIELD,
      this.sharedObjectIds(scope),
    );
  }

  /**
   * A malformed `x-access-predicate` is a broken deny-rule → the whole read must be
   * denied, never silently widened (RFC-ABAC §4 fail-closed). DENY_ALL_ID never
   * matches a real ObjectId, so ANDing it turns any read filter into "matches
   * nothing" (empty list / NOT_FOUND) without leaking existence.
   */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Push the three-state ABAC predicate onto a list/read `$and` array (product
   * reference, RFC-5 §1.4 / RFC-ABAC §4). The array already carries `{ projectId }`
   * so a deny stays project-scoped:
   *  - absent (`present:false`)     → no ABAC narrowing;
   *  - malformed (`malformed:true`) → fail-closed: force match-nothing;
   *  - present with `.mongo`        → AND the compiled fragment in.
   */
  private applyAccess(and: Record<string, unknown>[], access?: AccessPredicate): void {
    if (access?.present && access.malformed) {
      and.push({ _id: ContactsService.DENY_ALL_ID });
      return;
    }
    if (access?.present && !access.malformed && access.mongo && Object.keys(access.mongo).length) {
      and.push(access.mongo);
    }
  }

  /**
   * Single-record ABAC gate for get-by-id (`evalGate` side of the contract-equivalent
   * pair, RFC-ABAC §4). Returns `true` iff the record passes: absent → pass (no rules);
   * malformed → fail-closed deny; present with `.ir` → `evalGate(ir, record)`; a
   * present predicate that carries only `.mongo` (no `.ir`) passes here — the mongo
   * fragment is applied on the read-filter path instead.
   */
  /**
   * TODO-073: фильтр для прямого чтения документа (не через `findOne`) с
   * ABAC-предикатом, ВДАВЛЕННЫМ В БД (инвариант «предикат в запрос, не в память»).
   * Мутации раньше читали свою запись голым `{_id, projectId}` — гейт записи был
   * слабее гейта чтения: невидимую по ABAC запись нельзя было прочитать, но можно
   * было изменить/удалить/слить.
   */
  private accessFilter(
    base: Record<string, unknown>,
    access?: AccessPredicate,
  ): Record<string, unknown> {
    const and: Record<string, unknown>[] = [base];
    this.applyAccess(and, access);
    return and.length === 1 ? and[0] : { $and: and };
  }

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

  private toResponse(doc: ContactDocWithId) {
    const { _id, deletedAt, purgeAt, lastActivityAt, ...rest } = doc;
    return {
      id: _id.toString(),
      ...rest,
      createdAt: (rest.createdAt as Date).getTime(),
      updatedAt: (rest.updatedAt as Date).getTime(),
      lastActivityAt: lastActivityAt ? lastActivityAt.getTime() : null,
      // epoch millis для trash-экрана (null у живых записей).
      deletedAt: deletedAt ? deletedAt.getTime() : null,
      purgeAt: purgeAt ? purgeAt.getTime() : null,
    };
  }

  async create(
    projectId: string,
    data: Partial<ContactDoc>,
    ctx?: Ctx,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    opts?: ContactCreateOptions,
  ) {
    // TODO-159: контакт без идентичности (нет ни имени/фамилии, ни телефона/e-mail)
    // не создаётся — иначе он невидим ни для дедупа, ни для уникальных индексов.
    assertContactIdentity(data);
    const companyLinks = normalizeCompanyLinks(data.companyLinks, data.companyIds);
    const companyIds = companyIdsFromLinks(companyLinks);
    await this.companyRefs.assertCompaniesExist(projectId, companyIds, ctx?.metadata);

    const resolution = (opts?.trashCollisionResolution ?? '').trim().toLowerCase();
    const trashHit = await this.findTrashByIdentity(
      projectId,
      data.email,
      data.phone,
      scope,
      access,
    );
    if (trashHit && !opts?.forceCreate && resolution !== 'create_new') {
      if (resolution === 'restore') {
        return this.restore(projectId, trashHit.id, undefined, scope, ctx, access);
      }
      const matchedOn =
        normalizeEmail(data.email) && normalizeEmail(trashHit.email) === normalizeEmail(data.email)
          ? 'email'
          : 'phone';
      throw new AppError(
        'conflict',
        'Контакт с таким email или телефоном в корзине. Восстановить?',
        {
          code: 'TRASH_COLLISION',
          trashedId: trashHit.id,
          matchedOn,
          options: ['restore', 'create_new'],
        },
      );
    }

    const coll = await this.mongo.contacts();
    const now = new Date();
    const emailNormalized = normalizeEmail(data.email);
    const phoneNormalized = await this.normalizePhoneForProject(projectId, data.phone);
    const doc: Omit<ContactDoc, '_id'> = {
      projectId,
      firstName: data.firstName ?? '',
      lastName: data.lastName ?? '',
      phone: data.phone ?? '',
      email: data.email ?? '',
      middleName: data.middleName,
      position: data.position,
      companyIds,
      companyLinks,
      source: data.source,
      ownerId: data.ownerId,
      departmentId: data.departmentId,
      tags: data.tags,
      notes: data.notes,
      // Only set normalized keys when present (keeps partial-unique TO-BE feasible).
      ...(emailNormalized ? { emailNormalized } : {}),
      ...(phoneNormalized ? { phoneNormalized } : {}),
      mergedInto: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // E3-01 transactional outbox: business write + `crm.contact.created` row in
    // one Mongo session — no contact without an event, no event without a contact.
    let inserted: import('mongodb').WithId<ContactDoc> | null;
    try {
      inserted = await this.outbox.withOutbox(async (session) => {
        const res = await coll.insertOne(doc as ContactDoc, session ? { session } : {});
        const created = await coll.findOne(
          { _id: res.insertedId } as unknown as import('mongodb').Filter<ContactDoc>,
          session ? { session } : {},
        );
        const contactId = res.insertedId.toString();
        const intents: EmitIntent[] = [
          {
            type: 'crm.contact.created',
            source: 'contact',
            projectId,
            subject: `contact/${contactId}`,
            idempotencyKey: `contact.created:${contactId}`,
            userId: ctx?.userId,
            actorType: ctx?.userId ? 'user' : 'service',
            causation: ctx?.causation,
            payload: buildContactCreatedEventPayload({
              contactId,
              firstName: doc.firstName,
              lastName: doc.lastName,
              email: doc.email,
              phone: doc.phone,
              companyIds: doc.companyIds,
              ownerId: doc.ownerId,
              departmentId: doc.departmentId ?? null,
            }),
          },
          ...this.companyLinkIntents(projectId, contactId, [], doc.companyIds ?? [], ctx),
        ];
        return { result: created, intents };
      });
    } catch (err) {
      // Partial-unique index now hard-enforces per-project email/phone dedup;
      // translate the DB duplicate-key error into a clean domain error instead
      // of leaking a raw Mongo 11000 (closes the check-then-insert race).
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('invalid', 'Контакт с таким e-mail или телефоном уже существует');
      }
      throw err;
    }
    return inserted ? this.toResponse(inserted as ContactDocWithId) : null;
  }

  async findOne(projectId: string, id: string, scope?: VisibilityScope, access?: AccessPredicate) {
    if (!ObjectId.isValid(id)) throw new AppError('notFound', 'Контакт не найден');
    const coll = await this.mongo.contacts();
    const and: Record<string, unknown>[] = [
      { _id: new ObjectId(id) as unknown as ContactDoc['_id'], projectId, deletedAt: null },
    ];
    // AND the abac `.mongo` fragment (and deny on malformed) into the read filter.
    this.applyAccess(and, access);
    const doc = await coll.findOne((and.length === 1 ? and[0] : { $and: and }) as never);
    if (!doc) throw new AppError('notFound', 'Контакт не найден');
    // Hide records the viewer may not see (same 404 as a missing record).
    if (
      !isOwnableRecordVisible(
        scope,
        doc.ownerId,
        doc.departmentId,
        scope?.sharedRecordIds.includes(id) ?? false,
      )
    ) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    // Re-check with the single-record evalGate gate so get is exactly the contract
    // pair of the list filter (RFC-ABAC §4). Failing the gate is NOT_FOUND, never leak.
    if (!this.passesAccessGate(doc as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    // TODO-161: карточка отдаёт тени слияний, поглощённые ЭТИМ контактом, —
    // единственная точка входа в откат. Без них UnmergeContact недостижим: тень
    // не видна ни в списке, ни в корзине (TODO-175), а её id пользователь не
    // знает. Считаем только на карточке (findOne), не в списках.
    return {
      ...this.toResponse(doc as ContactDocWithId),
      mergedSources: await this.listMergedSources(projectId, id, scope, access),
    };
  }

  /**
   * TODO-161: тени слияний, поглощённые контактом `targetId` и ещё откатываемые.
   *
   * Видимость и ABAC вдавлены в фильтр тем же способом, что и на списке: тень
   * несёт данные исходного контакта, поэтому показывать её тому, кто не увидел
   * бы сам контакт, нельзя. Просроченные (окно вышло, TTL ещё не добрался) не
   * отдаём — кнопка отката по ним всё равно вернёт 409.
   */
  private async listMergedSources(
    projectId: string,
    targetId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<
    {
      id: string;
      firstName: string;
      lastName: string;
      middleName: string;
      email: string;
      phone: string;
      mergedAt: number;
      unmergeUntil: number;
    }[]
  > {
    const coll = await this.mongo.contacts();
    const and: Record<string, unknown>[] = [
      {
        projectId,
        mergedInto: new ObjectId(targetId),
        mergedAt: { $gt: new Date(Date.now() - UNMERGE_WINDOW_MS) },
      },
    ];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const rows = (await coll
      .find({ $and: and } as unknown as never)
      .sort({ mergedAt: -1 })
      .limit(MERGED_SOURCES_LIMIT)
      .toArray()) as unknown as ContactDocWithId[];
    return rows.map((r) => ({
      id: r._id.toString(),
      firstName: r.firstName ?? '',
      lastName: r.lastName ?? '',
      middleName: r.middleName ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      mergedAt: r.mergedAt ? new Date(r.mergedAt).getTime() : 0,
      unmergeUntil: mergeRevertDeadline(r) ?? 0,
    }));
  }

  async list(
    projectId: string,
    pageIndex = 0,
    pageSize = 25,
    query?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
    includeDeleted = false,
    opts?: ContactListOptions,
  ) {
    // Defence in depth: clamp even if a caller bypasses the controller (#13).
    pageSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    const coll = await this.mongo.contacts();
    // trash-режим (includeDeleted) отдаёт только удалённые; обычный list — только живые.
    // TODO-175: merge проставляет проигравшей записи deletedAt + deleteReason='merge',
    // поэтому merge-tombstone гарантированно попадал в корзину, а «Восстановить» по
    // нему всегда падал 404 (restore отказывает при mergedInto != null). Тень слияния
    // — не удалённая пользователем запись: убираем её из корзины (отмена слияния
    // делается отдельным действием UnmergeContact).
    const and: Record<string, unknown>[] = [
      includeDeleted
        ? { projectId, deletedAt: { $ne: null }, mergedInto: null }
        : { projectId, deletedAt: null },
    ];
    const q = query?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      and.push({
        $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }],
      });
    }
    // Серверные фильтры списка (proto ListContactsRequest.source/owner_id): пустая
    // строка = «фильтр не задан». Фильтр по владельцу не расширяет видимость —
    // он сужает уже суженную visibility/ABAC выборку.
    const source = opts?.source?.trim();
    const ownerScope = opts?.ownerScope?.trim();
    const ownerId = opts?.ownerId?.trim();
    if (source) and.push({ source });
    if (ownerScope === OWNER_SCOPE_UNASSIGNED) {
      and.push({
        $and: [
          {
            $or: [
              { [OWNER_FIELD]: null },
              { [OWNER_FIELD]: '' },
              { [OWNER_FIELD]: { $exists: false } },
            ],
          },
          {
            $or: [
              { [DEPARTMENT_FIELD]: null },
              { [DEPARTMENT_FIELD]: '' },
              { [DEPARTMENT_FIELD]: { $exists: false } },
            ],
          },
        ],
      });
    } else if (ownerId) {
      and.push({ [OWNER_FIELD]: ownerId });
    }
    const inactiveDays = opts?.inactiveDays;
    if (inactiveDays != null && inactiveDays > 0) {
      const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
      and.push({
        $or: [
          { lastActivityAt: { $lt: cutoff } },
          { lastActivityAt: null },
          { lastActivityAt: { $exists: false } },
        ],
      });
    }
    if (opts?.filterTags?.length) and.push({ tags: { $all: opts.filterTags } });
    const companyId = opts?.companyId?.trim();
    if (companyId) and.push({ companyIds: companyId });
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter: Record<string, unknown> = and.length === 1 ? and[0] : { $and: and };
    const total = await coll.countDocuments(filter);
    let hiddenByPolicy = 0;
    const restricts =
      scope?.mode !== 'all' ||
      (access?.present &&
        (access.malformed || (access.mongo && Object.keys(access.mongo).length > 0)));
    if (restricts) {
      const baseParts: Record<string, unknown>[] = [
        includeDeleted
          ? { projectId, deletedAt: { $ne: null }, mergedInto: null }
          : { projectId, deletedAt: null },
      ];
      if (q) {
        const rx = new RegExp(escapeRegex(q), 'i');
        baseParts.push({
          $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }],
        });
      }
      if (source) baseParts.push({ source });
      if (ownerScope === OWNER_SCOPE_UNASSIGNED) {
        baseParts.push({
          $and: [
            {
              $or: [
                { [OWNER_FIELD]: null },
                { [OWNER_FIELD]: '' },
                { [OWNER_FIELD]: { $exists: false } },
              ],
            },
            {
              $or: [
                { [DEPARTMENT_FIELD]: null },
                { [DEPARTMENT_FIELD]: '' },
                { [DEPARTMENT_FIELD]: { $exists: false } },
              ],
            },
          ],
        });
      } else if (ownerId) baseParts.push({ [OWNER_FIELD]: ownerId });
      if (opts?.filterTags?.length) baseParts.push({ tags: { $all: opts.filterTags } });
      if (companyId) baseParts.push({ companyIds: companyId });
      const projectFilter = baseParts.length === 1 ? baseParts[0] : { $and: baseParts };
      const projectTotal = await coll.countDocuments(projectFilter);
      hiddenByPolicy = computeHiddenByPolicy(total, projectTotal);
    }
    const list = await coll
      .find(filter)
      .skip(pageIndex * pageSize)
      .limit(pageSize)
      .sort(buildContactSort(opts?.sortBy, opts?.sortDir))
      .toArray();
    return {
      list: list.map((d) => this.toResponse(d as ContactDocWithId)),
      total,
      hiddenByPolicy,
    };
  }

  /**
   * Список корзины (только удалённые). Trash — не альтернативный read-path:
   * та же visibility/ABAC, что и обычный list, поэтому делегируем в list с
   * includeDeleted=true (S4: пользователь видит в корзине только видимые записи).
   */
  async listTrash(
    projectId: string,
    pageIndex = 0,
    pageSize = 25,
    query?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    return this.list(projectId, pageIndex, pageSize, query, scope, access, true);
  }

  async update(
    projectId: string,
    id: string,
    data: Partial<ContactDoc>,
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    // TODO-073: гейт записи = гейт чтения (findOne применяет и visibility, и ABAC).
    await this.findOne(projectId, id, scope, access);
    const coll = await this.mongo.contacts();
    const oid = new ObjectId(id) as unknown as ContactDoc['_id'];
    // before-image for field-level diff (contract §3.3 changes[]).
    const before = (await coll.findOne({ _id: oid, projectId })) as ContactDocWithId | null;
    // TODO-159: патч не должен обнулять идентичность записи — считаем итоговое
    // состояние (before + patch) и проверяем его тем же правилом, что и create.
    assertContactIdentity({
      firstName: data.firstName !== undefined ? data.firstName : before?.firstName,
      lastName: data.lastName !== undefined ? data.lastName : before?.lastName,
      phone: data.phone !== undefined ? data.phone : before?.phone,
      email: data.email !== undefined ? data.email : before?.email,
    });
    const update: Partial<ContactDoc> = { updatedAt: new Date(), ...data };
    if (data.companyIds !== undefined || data.companyLinks !== undefined) {
      const links = normalizeCompanyLinks(
        data.companyLinks ?? before?.companyLinks,
        data.companyIds ?? before?.companyIds,
      );
      const companyIds = companyIdsFromLinks(links);
      await this.companyRefs.assertCompaniesExist(projectId, companyIds, ctx?.metadata);
      update.companyIds = companyIds;
      update.companyLinks = links;
    }
    for (const f of STRIPPED_UPDATE_FIELDS) {
      delete (update as Record<string, unknown>)[f];
    }
    // Recompute normalized dedup keys when phone/email change (V3). Clearing a
    // value must $unset the key (not $set undefined, which the driver drops) so
    // the row leaves the partial-unique-on-$exists index.
    const clearNormalized: Record<string, ''> = {};
    if (data.email !== undefined) {
      const n = normalizeEmail(data.email);
      if (n) update.emailNormalized = n;
      else {
        delete (update as Record<string, unknown>).emailNormalized;
        clearNormalized.emailNormalized = '';
      }
    }
    if (data.phone !== undefined) {
      const n = await this.normalizePhoneForProject(projectId, data.phone);
      if (n) update.phoneNormalized = n;
      else {
        delete (update as Record<string, unknown>).phoneNormalized;
        clearNormalized.phoneNormalized = '';
      }
    }
    // Field-level changes over user-facing fields only (skip computed/normalized/audit).
    const changedAt = Date.now();
    const changes: FieldChange[] = [];
    for (const key of Object.keys(update)) {
      if (key === 'updatedAt' || key === 'emailNormalized' || key === 'phoneNormalized') continue;
      const oldValue = before ? (before as unknown as Record<string, unknown>)[key] : undefined;
      const newValue = (update as Record<string, unknown>)[key];
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      changes.push({ field: key, oldValue, newValue, changedBy: ctx?.userId, changedAt });
    }
    // E3-01 transactional outbox: persist business update + `crm.contact.updated`
    // in one Mongo session (invariant Д-1). No event when nothing actually changed.
    await this.outbox.withOutbox(async (session) => {
      await coll.updateOne(
        { _id: oid, projectId },
        Object.keys(clearNormalized).length
          ? { $set: update, $unset: clearNormalized }
          : { $set: update },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = changes.length
        ? [
            {
              type: 'crm.contact.updated',
              source: 'contact',
              projectId,
              subject: `contact/${id}`,
              idempotencyKey: `contact.updated:${id}:${changedAt}`,
              userId: ctx?.userId,
              actorType: ctx?.userId ? 'user' : 'service',
              causation: ctx?.causation,
              payload: { contactId: id, changes },
            },
            ...this.companyLinkIntents(
              projectId,
              id,
              before?.companyIds ?? [],
              data.companyIds !== undefined ? (data.companyIds ?? []) : (before?.companyIds ?? []),
              ctx,
              changedAt,
            ).filter(() => data.companyIds !== undefined),
          ]
        : [];
      return { result: undefined, intents };
    });
    return this.findOne(projectId, id, scope, access);
  }

  async remove(
    projectId: string,
    id: string,
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    // TODO-073: удаление — запись, гейт тот же, что на чтении.
    await this.findOne(projectId, id, scope, access);
    const coll = await this.mongo.contacts();
    const oid = new ObjectId(id) as unknown as ContactDoc['_id'];
    const before = (await coll.findOne({ _id: oid, projectId })) as ContactDocWithId | null;
    const now = new Date();
    const purgeAt = new Date(now.getTime() + (await this.trashTtlMs(projectId)));
    // E3-01 transactional outbox: soft-delete + `crm.contact.deleted` in one session.
    await this.outbox.withOutbox(async (session) => {
      await coll.updateOne(
        { _id: oid, projectId },
        {
          $set: { deletedAt: now, updatedAt: now, deleteReason: 'user', purgeAt },
          // Drop the normalized dedup keys so the partial-unique index (which is
          // partial on `$exists`, not on deletedAt) releases this identity and a
          // fresh contact with the same email/phone can be created.
          $unset: { emailNormalized: '', phoneNormalized: '' },
        },
        session ? { session } : {},
      );
      const intents: EmitIntent[] = [
        {
          type: 'crm.contact.deleted',
          source: 'contact',
          projectId,
          subject: `contact/${id}`,
          idempotencyKey: `contact.deleted:${id}`,
          userId: ctx?.userId,
          actorType: ctx?.userId ? 'user' : 'service',
          causation: ctx?.causation,
          payload: { contactId: id, companyIds: before?.companyIds ?? [] },
        },
      ];
      return { result: undefined, intents };
    });
    return { id, deletedAt: now };
  }

  /**
   * Restore from trash. S4: must gate on visibility of the (trashed) record —
   * a blind updateOne would let a user revive any contact in the project.
   *
   * Восстановление пересчитывает нормализованные email/phone-ключи, зачищенные при
   * soft-delete. Если по этим ключам уже есть ЖИВОЙ дубль — это коллизия уникального
   * индекса: без `strategy` возвращаем `locked` со списком кандидатов и опциями
   * ('merge' | 'clear_keys'), чтобы фронт показал диалог разрешения.
   */
  async restore(
    projectId: string,
    id: string,
    strategy?: string,
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(id)) throw new AppError('notFound', 'Контакт не найден');
    const coll = await this.mongo.contacts();
    const oid = new ObjectId(id) as unknown as ContactDoc['_id'];
    // TODO-073: ABAC вдавлен в сам запрос, плюс единичный gate по .ir ниже.
    const doc = await coll.findOne(this.accessFilter({ _id: oid, projectId }, access) as never);
    if (!doc || doc.deletedAt == null || doc.mergedInto != null) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    if (
      !isOwnableRecordVisible(
        scope,
        doc.ownerId,
        doc.departmentId,
        scope?.sharedRecordIds.includes(id) ?? false,
      )
    ) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    if (!this.passesAccessGate(doc as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    // Recompute the normalized dedup keys that were $unset on soft-delete so the
    // restored row re-enters the partial-unique index. A same-identity live contact
    // would trip the unique index → resolve via strategy instead of blind E11000.
    const emailNormalized = normalizeEmail(doc.email);
    const phoneNormalized = normalizePhone(doc.phone);

    // Живой дубль по email/phone (project-wide — уникальный индекс не зависит от
    // visibility). Ключи, по которым есть конфликт, определяем отдельно, чтобы
    // clear_keys зачищал только конфликтные ключи, сохраняя дедуп по остальным.
    const or: Record<string, unknown>[] = [];
    if (emailNormalized) or.push({ emailNormalized });
    if (phoneNormalized) or.push({ phoneNormalized });
    let conflicts: ContactDocWithId[] = [];
    if (or.length) {
      conflicts = (await coll
        .find({ projectId, deletedAt: null, mergedInto: null, _id: { $ne: oid }, $or: or })
        .limit(20)
        .toArray()) as ContactDocWithId[];
    }
    const emailCollides =
      !!emailNormalized && conflicts.some((c) => c.emailNormalized === emailNormalized);
    const phoneCollides =
      !!phoneNormalized && conflicts.some((c) => c.phoneNormalized === phoneNormalized);

    if (conflicts.length) {
      if (!strategy) {
        throw new AppError('locked', 'Есть активный дубль по email/телефону — выберите действие', {
          candidates: conflicts.map((c) => ({
            id: c._id.toString(),
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            phone: c.phone,
          })),
          options: ['merge', 'clear_keys'],
        });
      }
      if (strategy === 'merge') {
        // Смержить восстанавливаемого В живой конфликт существующим merge-механизмом
        // (source=восстанавливаемый становится tombstone, target=живой дубль остаётся).
        const target = conflicts[0]._id.toString();
        await this.merge(projectId, id, target, [], scope, ctx, access);
        return this.findOne(projectId, target, scope, access);
      }
      if (strategy !== 'clear_keys') {
        throw new AppError('invalid', 'Неизвестная стратегия', { field: 'strategy' });
      }
      // clear_keys: занулить только конфликтные нормализованные ключи (email/phone
      // display-значения не трогаем) — запись оживает рядом с активным дублем.
    }

    const clearEmailKey = strategy === 'clear_keys' && emailCollides;
    const clearPhoneKey = strategy === 'clear_keys' && phoneCollides;
    const restoreSet: Record<string, unknown> = { deletedAt: null, updatedAt: new Date() };
    const restoreUnset: Record<string, ''> = { deleteReason: '', purgeAt: '' };
    if (emailNormalized && !clearEmailKey) restoreSet.emailNormalized = emailNormalized;
    else restoreUnset.emailNormalized = '';
    if (phoneNormalized && !clearPhoneKey) restoreSet.phoneNormalized = phoneNormalized;
    else restoreUnset.phoneNormalized = '';
    // E3-01 transactional outbox: restore + `crm.contact.restored` in one session.
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: oid, projectId },
          { $set: restoreSet, $unset: restoreUnset },
          session ? { session } : {},
        );
        return { result: undefined, intents: this.restoredIntents(projectId, id, ctx) };
      });
    } catch (err) {
      // Гонка: живой дубль вклинился между проверкой и записью → та же коллизия.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('locked', 'Есть активный дубль по email/телефону — выберите действие', {
          options: ['merge', 'clear_keys'],
        });
      }
      throw err;
    }
    return this.findOne(projectId, id, scope, access);
  }

  /**
   * FR-COMPANIES-220: side-effect events for company↔contact M2M changes so the
   * company domain can bump `cardContactsRev` without scraping contact diffs.
   */
  private companyLinkIntents(
    projectId: string,
    contactId: string,
    beforeIds: string[],
    afterIds: string[],
    ctx?: Ctx,
    ts?: number,
  ): EmitIntent[] {
    const before = new Set(beforeIds.filter(Boolean));
    const after = new Set(afterIds.filter(Boolean));
    const linked = [...after].filter((id) => !before.has(id));
    const unlinked = [...before].filter((id) => !after.has(id));
    if (!linked.length && !unlinked.length) return [];
    const stamp = ts ?? Date.now();
    const intents: EmitIntent[] = [];
    for (const companyId of linked) {
      intents.push({
        type: 'crm.company.contact_linked',
        source: 'contact',
        projectId,
        subject: `company/${companyId}`,
        idempotencyKey: `company.contact_linked:${contactId}:${companyId}:${stamp}`,
        userId: ctx?.userId,
        actorType: ctx?.userId ? 'user' : 'service',
        causation: ctx?.causation,
        payload: { contactId, companyId },
      });
    }
    for (const companyId of unlinked) {
      intents.push({
        type: 'crm.company.contact_unlinked',
        source: 'contact',
        projectId,
        subject: `company/${companyId}`,
        idempotencyKey: `company.contact_unlinked:${contactId}:${companyId}:${stamp}`,
        userId: ctx?.userId,
        actorType: ctx?.userId ? 'user' : 'service',
        causation: ctx?.causation,
        payload: { contactId, companyId },
      });
    }
    return intents;
  }

  /** Shared builder for `crm.contact.restored {contactId}` (restore + unmerge). */
  private restoredIntents(projectId: string, id: string, ctx?: Ctx): EmitIntent[] {
    return [
      {
        type: 'crm.contact.restored',
        source: 'contact',
        projectId,
        subject: `contact/${id}`,
        idempotencyKey: `contact.restored:${id}`,
        userId: ctx?.userId,
        actorType: ctx?.userId ? 'user' : 'service',
        causation: ctx?.causation,
        payload: { contactId: id },
      },
    ];
  }

  // --- TO-BE methods -------------------------------------------------------

  /**
   * Dedup radar (FR-MCON-5): live contacts matching email/phone.
   * Out-of-visibility matches are reported only as a boolean flag (P4).
   */
  async findDuplicates(
    projectId: string,
    args: { email?: string; phone?: string; excludeId?: string },
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    const emailNormalized = normalizeEmail(args.email);
    const phoneNormalized = normalizePhone(args.phone);
    if (!emailNormalized && !phoneNormalized) {
      throw new AppError('invalid', 'Нужен e-mail или телефон', { field: 'email' });
    }
    const coll = await this.mongo.contacts();
    const or: Record<string, unknown>[] = [];
    if (emailNormalized) or.push({ emailNormalized });
    if (phoneNormalized) or.push({ phoneNormalized });
    // FR-MDEAL-4: `remove()` $unsets emailNormalized/phoneNormalized so a new live
    // contact can reuse the identity. Trash still keeps raw email/phone — match
    // those (same idea as company findDuplicates matching inn/name after identityHash
    // is dropped) and flag `deleted` so qualify can offer «Восстановить».
    const trashOr: Record<string, unknown>[] = [];
    if (args.email?.trim()) {
      trashOr.push({ email: new RegExp(`^${escapeRegex(args.email.trim())}$`, 'i') });
    }
    if (emailNormalized) {
      trashOr.push({ email: new RegExp(`^${escapeRegex(emailNormalized)}$`, 'i') });
    }
    if (phoneNormalized) {
      const digits = phoneNormalized.replace(/\D/g, '');
      if (digits.length >= 10) {
        trashOr.push({ phone: new RegExp(digits.slice(-10).split('').join('\\D*')) });
      }
    }
    if (trashOr.length) {
      or.push({ deletedAt: { $ne: null }, $or: trashOr });
    }
    // Merge tombstones are excluded — they are not restorable from here (TODO-175).
    const baseFilter: Record<string, unknown> = {
      projectId,
      mergedInto: null,
      $or: or,
    };
    if (args.excludeId && ObjectId.isValid(args.excludeId)) {
      baseFilter._id = { $ne: new ObjectId(args.excludeId) };
    }
    // AND the abac fragment (deny on malformed) into the dedup query.
    const and: Record<string, unknown>[] = [baseFilter];
    this.applyAccess(and, access);
    const filter: Record<string, unknown> = and.length === 1 ? and[0] : { $and: and };
    const rows = (await coll
      .find(filter)
      .sort({ deletedAt: 1 })
      .limit(50)
      .toArray()) as ContactDocWithId[];
    const candidates: {
      contactId: string;
      displayName: string;
      matchedOn: string;
      maskedValue: string;
      deleted: boolean;
    }[] = [];
    let possibleExternalDuplicate = false;
    for (const d of rows) {
      const id = d._id.toString();
      const visible =
        isOwnableRecordVisible(
          scope,
          d.ownerId,
          d.departmentId,
          scope?.sharedRecordIds.includes(id) ?? false,
        ) && this.passesAccessGate(d as unknown as Record<string, unknown>, access);
      const emailHit =
        !!emailNormalized &&
        (d.emailNormalized === emailNormalized || normalizeEmail(d.email) === emailNormalized);
      const matchedOn = emailHit ? 'email' : 'phone';
      if (!visible) {
        possibleExternalDuplicate = true;
        continue;
      }
      candidates.push({
        contactId: id,
        displayName: displayName(d),
        matchedOn,
        maskedValue: matchedOn === 'email' ? maskEmail(d.email) : maskPhone(d.phone),
        deleted: d.deletedAt != null,
      });
    }
    return { candidates, possibleExternalDuplicate };
  }

  /**
   * Duplicate queue (FR-MCON-15): pairs of contacts sharing a normalized key,
   * restricted to records visible to the subject.
   */
  async listDuplicateQueue(
    projectId: string,
    pageIndex = 0,
    pageSize = 25,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    // TODO-376: страница считается в БД. Раньше `.toArray()` тянул ВСЕ группы
    // проекта, документы поднимались по одному (N+1), а `pairs.slice(...)` резал
    // уже материализованный массив.
    pageSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    pageIndex = Math.max(pageIndex, 0);
    const coll = await this.mongo.contacts();
    const baseAnd: Record<string, unknown>[] = [{ projectId, deletedAt: null, mergedInto: null }];
    const vis = this.visibilityFilter(scope);
    if (vis) baseAnd.push(vis);
    this.applyAccess(baseAnd, access);
    const match = baseAnd.length === 1 ? baseAnd[0] : { $and: baseAnd };

    const [facet] = await coll
      .aggregate<DuplicateQueueFacet>(buildDuplicateQueuePipeline(match, pageIndex, pageSize))
      .toArray();
    const rows = facet?.rows ?? [];
    const total = facet?.total?.[0]?.n ?? 0;

    // Один запрос на страницу вместо findOne на каждый идентификатор.
    const idStrings = Array.from(
      new Set(rows.flatMap((r) => [String(r.first), String(r.other)])),
    ).filter((id) => ObjectId.isValid(id));
    const docs = idStrings.length
      ? ((await coll
          .find({
            projectId,
            _id: { $in: idStrings.map((id) => new ObjectId(id)) },
          } as never)
          .toArray()) as ContactDocWithId[])
      : [];
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));

    const pairs: {
      left: { contactId: string; displayName: string; matchedOn: string; maskedValue: string };
      right: { contactId: string; displayName: string; matchedOn: string; maskedValue: string };
      matchedOn: string;
    }[] = [];
    for (const r of rows) {
      const l = byId.get(String(r.first));
      const rt = byId.get(String(r.other));
      if (!l || !rt) continue;
      const on = r._id.on;
      const cand = (d: ContactDocWithId) => ({
        contactId: d._id.toString(),
        displayName: displayName(d),
        matchedOn: on,
        maskedValue: on === 'email' ? maskEmail(d.email) : maskPhone(d.phone),
      });
      pairs.push({ left: cand(l), right: cand(rt), matchedOn: on });
    }
    return { pairs, total };
  }

  /**
   * Merge source into target (FR-MCON-12). Both records must be visible.
   * source becomes a merge-tombstone (mergedInto=target), target updated per survivorFields.
   */
  async merge(
    projectId: string,
    sourceId: string,
    targetId: string,
    survivorFields: { field: string; from: string }[] = [],
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(sourceId) || !ObjectId.isValid(targetId)) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    if (sourceId === targetId) {
      throw new AppError('invalid', 'Нельзя слить запись саму с собой', {
        sourceId,
        targetId,
      });
    }
    const coll = await this.mongo.contacts();
    const sOid = new ObjectId(sourceId) as unknown as ContactDoc['_id'];
    const tOid = new ObjectId(targetId) as unknown as ContactDoc['_id'];
    // TODO-073: обе записи читаются с ABAC-предикатом в фильтре.
    const source = (await coll.findOne(
      this.accessFilter({ _id: sOid, projectId }, access) as never,
    )) as ContactDocWithId | null;
    const target = (await coll.findOne(
      this.accessFilter({ _id: tOid, projectId }, access) as never,
    )) as ContactDocWithId | null;
    if (!source || !target) throw new AppError('notFound', 'Контакт не найден');
    // Visibility: both must be visible (V9). 404-mask for hidden records.
    const srcVisible = isOwnableRecordVisible(
      scope,
      source.ownerId,
      source.departmentId,
      scope?.sharedRecordIds.includes(sourceId) ?? false,
    );
    const tgtVisible = isOwnableRecordVisible(
      scope,
      target.ownerId,
      target.departmentId,
      scope?.sharedRecordIds.includes(targetId) ?? false,
    );
    if (!srcVisible || !tgtVisible) throw new AppError('notFound', 'Контакт не найден');
    // TODO-073: единичный ABAC-gate (`.ir`) — контрактная пара к mongo-фрагменту.
    if (
      !this.passesAccessGate(source as unknown as Record<string, unknown>, access) ||
      !this.passesAccessGate(target as unknown as Record<string, unknown>, access)
    ) {
      throw new AppError('notFound', 'Контакт не найден');
    }
    // Already merged or merging into a tombstone — invalid (V7).
    if (source.mergedInto != null || target.mergedInto != null) {
      // Idempotent: already merged into the same target → no-op return target.
      if (source.mergedInto != null && source.mergedInto.toString() === targetId) {
        return this.toResponse(target);
      }
      throw new AppError('invalid', 'Нельзя слить уже слитую запись', {
        sourceId,
        targetId,
      });
    }

    // Apply survivor fields (pick allowed scalar fields from source).
    const ALLOWED = new Set([
      'firstName',
      'lastName',
      'middleName',
      'phone',
      'email',
      'position',
      'source',
      'notes',
    ]);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const sf of survivorFields) {
      if (sf.from === 'source' && ALLOWED.has(sf.field)) {
        set[sf.field] = (source as unknown as Record<string, unknown>)[sf.field];
      }
    }
    // Union companyIds (M2M survives merge).
    const mergedCompanyIds = Array.from(
      new Set([...(target.companyIds ?? []), ...(source.companyIds ?? [])]),
    );
    set.companyIds = mergedCompanyIds;
    // Recompute normalized keys if email/phone were taken from source.
    // TODO-167: пустое нормализованное значение нельзя писать как $set undefined —
    // драйвер сериализует его в null, ключ остаётся в документе и продолжает
    // занимать место в партиал-уникальном индексе (он партиальный по $exists).
    // Пустое значение = $unset, как в update (см. clearNormalized).
    const clearNormalized: Record<string, ''> = {};
    if (set.email !== undefined) {
      const n = normalizeEmail(set.email as string);
      if (n) set.emailNormalized = n;
      else clearNormalized.emailNormalized = '';
    }
    if (set.phone !== undefined) {
      const n = await this.normalizePhoneForProject(projectId, set.phone as string);
      if (n) set.phoneNormalized = n;
      else clearNormalized.phoneNormalized = '';
    }
    const now = new Date();
    const shadowMs = await this.shadowWindowMs(projectId);
    const purgeAt = new Date(now.getTime() + shadowMs);
    // E3-01 transactional outbox: target update + source tombstone +
    // `crm.contact.merged` all in one session (invariant Д-1).
    // affectedEntities{deals,orders,...} not computable from this domain —
    // consumers self-heal via mergedInto redirect (contract §3.10 feasibility note).
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: tOid, projectId },
          Object.keys(clearNormalized).length
            ? { $set: set, $unset: clearNormalized }
            : { $set: set },
          session ? { session } : {},
        );
        await coll.updateOne(
          { _id: sOid, projectId },
          {
            $set: {
              mergedInto: new ObjectId(targetId),
              mergedAt: now,
              deletedAt: now,
              deleteReason: 'merge',
              purgeAt,
              updatedAt: now,
            },
            // Release the loser's normalized keys from the partial-unique index so
            // its identity (possibly now owned by the target) is no longer held.
            $unset: { emailNormalized: '', phoneNormalized: '' },
          },
          session ? { session } : {},
        );
        const intents: EmitIntent[] = [
          {
            type: 'crm.contact.merged',
            source: 'contact',
            projectId,
            subject: `contact/${targetId}`,
            idempotencyKey: `contact.merged:${sourceId}:${targetId}`,
            userId: ctx?.userId,
            actorType: ctx?.userId ? 'user' : 'service',
            causation: ctx?.causation,
            payload: {
              sourceContactIds: [sourceId],
              targetContactId: targetId,
              companyIds: mergedCompanyIds,
              mergedBy: ctx?.userId,
              affectedEntities: { deals: [], orders: [], activities: [], documents: [] },
            },
          },
        ];
        return { result: undefined, intents };
      });
    } catch (err) {
      // TODO-167: survivorFields могут перенести email/phone источника на цель и
      // столкнуться с партиал-уникальным индексом. В create/unmerge 11000 уже
      // транслируется в доменную ошибку, а merge отдавал сырую ошибку Mongo.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('invalid', 'Контакт с таким e-mail или телефоном уже существует', {
          sourceId,
          targetId,
        });
      }
      throw err;
    }
    return this.findOne(projectId, targetId, scope, access);
  }

  /**
   * Unmerge (FR-MCON-13): revert a merge while shadow tombstone still exists.
   */
  async unmerge(
    projectId: string,
    sourceId: string,
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    if (!ObjectId.isValid(sourceId)) throw new AppError('notFound', 'Контакт не найден');
    const coll = await this.mongo.contacts();
    const sOid = new ObjectId(sourceId) as unknown as ContactDoc['_id'];
    // TODO-073: ABAC вдавлен в фильтр чтения тени слияния.
    const source = (await coll.findOne(
      this.accessFilter({ _id: sOid, projectId }, access) as never,
    )) as ContactDocWithId | null;
    if (!source || source.mergedInto == null) {
      throw new AppError('notFound', 'Отменять нечего: слияния нет');
    }
    if (
      !isOwnableRecordVisible(
        scope,
        source.ownerId,
        source.departmentId,
        scope?.sharedRecordIds.includes(sourceId) ?? false,
      )
    ) {
      throw new AppError('notFound', 'Отменять нечего: слияния нет');
    }
    if (!this.passesAccessGate(source as unknown as Record<string, unknown>, access)) {
      throw new AppError('notFound', 'Отменять нечего: слияния нет');
    }
    // TODO-161: окно отката проверяется ЯВНО, а не только физическим удалением
    // тени по TTL. Иначе «30 дней» — обещание без исполнителя: TTL-демон Mongo
    // отстаёт от purgeAt, и просроченный откат проходил бы молча.
    const shadowMs = await this.shadowWindowMs(projectId);
    const unmergeDeadline = mergeRevertDeadline(source, shadowMs);
    if (unmergeDeadline !== null && Date.now() > unmergeDeadline) {
      throw new AppError('conflict', 'Отменить слияние можно в течение 30 дней — срок истёк', {
        reason: 'unmerge_expired',
        contactId: sourceId,
        mergedAt: source.mergedAt ? new Date(source.mergedAt).getTime() : null,
        expiredAt: unmergeDeadline,
      });
    }
    // Re-establish the source's normalized dedup keys (dropped on the merge
    // tombstone) so it re-enters the partial-unique index on revert.
    const unmergeEmailNorm = normalizeEmail(source.email);
    const unmergePhoneNorm = normalizePhone(source.phone);
    const unmergeSet: Record<string, unknown> = { deletedAt: null, updatedAt: new Date() };
    const unmergeUnset: Record<string, ''> = {
      mergedInto: '',
      mergedAt: '',
      deleteReason: '',
      purgeAt: '',
    };
    if (unmergeEmailNorm) unmergeSet.emailNormalized = unmergeEmailNorm;
    else unmergeUnset.emailNormalized = '';
    if (unmergePhoneNorm) unmergeSet.phoneNormalized = unmergePhoneNorm;
    else unmergeUnset.phoneNormalized = '';
    // E3-01 transactional outbox: revert tombstone + `crm.contact.restored` in one session.
    try {
      await this.outbox.withOutbox(async (session) => {
        await coll.updateOne(
          { _id: sOid, projectId },
          { $set: unmergeSet, $unset: unmergeUnset },
          session ? { session } : {},
        );
        return { result: undefined, intents: this.restoredIntents(projectId, sourceId, ctx) };
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('invalid', 'Контакт с таким e-mail или телефоном уже существует');
      }
      throw err;
    }
    return this.findOne(projectId, sourceId, scope, access);
  }

  /**
   * Bulk reassign owner/department (FR-MCON-24). Only visible records are touched.
   */
  async reassign(
    projectId: string,
    contactIds: string[],
    target: { newOwnerId?: string; newDepartmentId?: string },
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ) {
    if (!contactIds?.length)
      throw new AppError('invalid', 'Не переданы контакты для переназначения');
    const hasOwner = !!target.newOwnerId;
    const hasDept = !!target.newDepartmentId;
    if (hasOwner === hasDept) {
      throw new AppError('invalid', 'Укажите ровно одно: нового владельца или подразделение');
    }
    // TODO-160: цель проверяется ОДИН раз на батч, до записи. ownerId — ключ
    // видимости, поэтому переназначение на не-участника проекта прячет записи.
    if (hasOwner) {
      await this.reassignTargets.assertOwnerAssignable(
        projectId,
        target.newOwnerId as string,
        ctx?.metadata,
        'newOwnerId',
        scope,
      );
    } else {
      await this.reassignTargets.assertDepartmentAssignable(
        projectId,
        target.newDepartmentId as string,
        ctx?.metadata,
      );
    }
    const oids = contactIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (!oids.length) return { reassigned: 0 };
    const coll = await this.mongo.contacts();
    const and: Record<string, unknown>[] = [{ projectId, deletedAt: null, _id: { $in: oids } }];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    // TODO-073: тот же ABAC-предикат, что и на чтении, вдавлен в фильтр — иначе
    // массовая мутация трогала бы записи, которые пользователь не может прочитать.
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };
    const changedAt = Date.now();
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ''> = {};
    const field = hasOwner ? 'ownerId' : 'departmentId';
    const pairedField = hasOwner ? 'departmentId' : 'ownerId';
    const newValue = hasOwner ? target.newOwnerId : target.newDepartmentId;
    set[field] = newValue;
    unset[pairedField] = '';
    // Affected records BEFORE update — needed for per-record changes[] with oldValue.
    const affected = (await coll
      .find(filter)
      .project({ _id: 1, [field]: 1 })
      .toArray()) as { _id: ObjectId; ownerId?: string; departmentId?: string }[];
    if (!affected.length) return { reassigned: 0 };
    // E3-01 transactional outbox: bulk reassign + one `crm.contact.updated` per
    // affected record (changes: ownerId/departmentId) in a single session.
    let reassigned = 0;
    await this.outbox.withOutbox(async (session) => {
      const res = await coll.updateMany(
        filter,
        { $set: set, $unset: unset },
        session ? { session } : {},
      );
      reassigned = res.modifiedCount;
      const intents: EmitIntent[] = affected.map((d) => {
        const id = d._id.toString();
        const oldValue = (d as Record<string, unknown>)[field];
        return {
          type: 'crm.contact.updated',
          source: 'contact',
          projectId,
          subject: `contact/${id}`,
          idempotencyKey: `contact.updated:${id}:${changedAt}`,
          userId: ctx?.userId,
          actorType: ctx?.userId ? 'user' : 'service',
          causation: ctx?.causation,
          payload: {
            contactId: id,
            changes: [{ field, oldValue, newValue, changedBy: ctx?.userId, changedAt }],
          },
        };
      });
      return { result: undefined, intents };
    });
    return { reassigned };
  }

  /**
   * BX-OFFB-2: reassign EVERY live contact owned by a departing member to the new
   * responsible — the service-triggered offboard cascade (no visibility scope; the
   * caller is control via the bus). Emits one `crm.contact.updated` per record
   * (changes: ownerId) so search/denorm stay in sync — never a blunt `updateMany`
   * without events. Natural idempotency: a redelivery finds nothing still owned by
   * `fromUserId` (already moved) → 0 reassigned, 0 events. `offboardTs` keeps the
   * per-record event idempotency keys stable across an at-least-once redelivery.
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
    const coll = await this.mongo.contacts();
    const filter = { projectId, ownerId: from, deletedAt: null };
    const changedAt = Date.now();
    let reassigned = 0;
    await this.outbox.withOutbox(async (session) => {
      // TOCTOU fix (MINOR-13): read the affected ids inside the SAME session/
      // transaction as the update, so a concurrent ownerId change between the
      // read and the write can't desync the emitted per-record events from the
      // rows actually moved (phantom or missed `crm.contact.updated`).
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
        return {
          type: 'crm.contact.updated',
          source: 'contact',
          projectId,
          subject: `contact/${id}`,
          idempotencyKey: `contact.reassigned:${id}:${offboardTs}`,
          actorType: 'service',
          payload: {
            contactId: id,
            changes: [{ field: 'ownerId', oldValue: from, newValue: to, changedAt }],
          },
        };
      });
      return { result: undefined, intents };
    });
    return { reassigned };
  }

  /** FR-PROJ-215: count live contacts owned by a project member (service-triggered). */
  async countOwnedRecords(projectId: string, userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!projectId || !uid) return 0;
    const coll = await this.mongo.contacts();
    return coll.countDocuments({ projectId, ownerId: uid, deletedAt: null });
  }

  /** Live contacts in project (for import quota, FR-CONTACTS-380). */
  async countLiveContacts(projectId: string): Promise<number> {
    const coll = await this.mongo.contacts();
    return coll.countDocuments({ projectId, deletedAt: null });
  }

  /**
   * FR-MCON-17: пометить связи с удалённой компанией как осиротевшие.
   * Возвращает число обновлённых контактов.
   */
  async markCompanyLinkOrphaned(projectId: string, companyId: string): Promise<number> {
    if (!(await this.driftDetectionEnabled(projectId))) return 0;
    const coll = await this.mongo.contacts();
    const rows = (await coll
      .find({ projectId, companyIds: companyId, deletedAt: null })
      .project({ _id: 1, companyIds: 1, orphanedCompanyIds: 1 })
      .toArray()) as ContactDocWithId[];
    if (!rows.length) return 0;
    let updated = 0;
    for (const row of rows) {
      const current = row.companyIds ?? [];
      if (!current.includes(companyId)) continue;
      const nextCompanyIds = current.filter((id) => id !== companyId);
      const orphaned = [...new Set([...(row.orphanedCompanyIds ?? []), companyId])];
      const res = await coll.updateOne(
        { _id: row._id, projectId },
        {
          $set: {
            companyIds: nextCompanyIds,
            orphanedCompanyIds: orphaned,
            updatedAt: new Date(),
          },
        },
      );
      if (res.modifiedCount) updated += 1;
    }
    return updated;
  }

  /**
   * FR-COMPANIES-140: when companies merge, contacts still linked to the loser
   * must be repointed at the surviving master (M2M `companyIds` / `companyLinks`).
   * Emits one `crm.contact.updated` per moved row. Natural idempotency: a redelivery
   * finds nothing still on the loser id.
   */
  async rewriteCompanyOnMerge(
    projectId: string,
    loserId: string,
    masterId: string,
    mergeIdempotencyKey: string,
  ): Promise<{ rewritten: number }> {
    const loser = (loserId ?? '').trim();
    const master = (masterId ?? '').trim();
    if (!projectId || !loser || !master || loser === master) return { rewritten: 0 };

    const coll = await this.mongo.contacts();
    const filter = {
      projectId,
      deletedAt: null,
      $or: [{ companyIds: loser }, { 'companyLinks.companyId': loser }],
    };
    const changedAt = Date.now();
    let rewritten = 0;
    await this.outbox.withOutbox(async (session) => {
      const affected = (await coll
        .find(filter, session ? { session } : {})
        .project({ _id: 1, companyIds: 1, companyLinks: 1, orphanedCompanyIds: 1 })
        .toArray()) as ContactDocWithId[];
      if (!affected.length) return { result: undefined, intents: [] };
      const intents: EmitIntent[] = [];
      for (const row of affected) {
        const id = row._id.toString();
        const remapped = remapCompanyRefs(
          loser,
          master,
          row.companyIds,
          row.companyLinks,
          row.orphanedCompanyIds,
        );
        if (!remapped.changed) continue;
        await coll.updateOne(
          { _id: row._id, projectId },
          {
            $set: {
              companyIds: remapped.companyIds,
              companyLinks: remapped.companyLinks,
              orphanedCompanyIds: remapped.orphanedCompanyIds,
              updatedAt: new Date(),
            },
          },
          session ? { session } : {},
        );
        rewritten++;
        intents.push({
          type: 'crm.contact.updated',
          source: 'contact',
          projectId,
          subject: `contact/${id}`,
          idempotencyKey: `contact.company_merged:${id}:${mergeIdempotencyKey}`,
          actorType: 'service',
          payload: {
            contactId: id,
            changes: [
              {
                field: 'companyIds',
                oldValue: row.companyIds ?? [],
                newValue: remapped.companyIds,
                changedAt,
              },
            ],
          },
        });
      }
      return { result: undefined, intents };
    });
    return { rewritten };
  }

  /** Ищет удалённый контакт с тем же email/phone (нормализованные ключи при soft-delete сняты). */
  private async findTrashByIdentity(
    projectId: string,
    email?: string,
    phone?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<{ id: string; email: string; phone: string } | null> {
    const emailNorm = normalizeEmail(email);
    const phoneNorm = normalizePhone(phone);
    if (!emailNorm && !phoneNorm) return null;
    const coll = await this.mongo.contacts();
    const or: Record<string, unknown>[] = [];
    if (emailNorm) or.push({ email: { $regex: new RegExp(`^${escapeRegex(emailNorm)}$`, 'i') } });
    if (phoneNorm) {
      // Soft-delete снимает phoneNormalized. Хвост из 10 цифр ловит и `8…`, и `+7…`;
      // точное совпадение — normalizePhone ниже. Не `{ $exists, $ne:'' }`:
      // иначе при большой корзине нужная запись не попадала в limit.
      const digits = phoneNorm.replace(/\D/g, '');
      const tail = digits.slice(-10);
      if (tail.length >= 7) or.push({ phone: { $regex: escapeRegex(tail) } });
    }
    const and: Record<string, unknown>[] = [
      { projectId, deletedAt: { $ne: null }, mergedInto: null },
      { $or: or },
    ];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };
    const rows = (await coll.find(filter).limit(200).toArray()) as ContactDocWithId[];
    for (const row of rows) {
      const id = row._id.toString();
      const emailMatch = emailNorm && normalizeEmail(row.email) === emailNorm;
      const phoneMatch = phoneNorm && normalizePhone(row.phone) === phoneNorm;
      if (!emailMatch && !phoneMatch) continue;
      if (
        !isOwnableRecordVisible(
          scope,
          row.ownerId,
          row.departmentId,
          scope?.sharedRecordIds.includes(id) ?? false,
        ) ||
        !this.passesAccessGate(row as unknown as Record<string, unknown>, access)
      ) {
        continue;
      }
      return { id, email: row.email ?? '', phone: row.phone ?? '' };
    }
    return null;
  }

  // TODO-074: getContactFields удалён (вместе с RPC GetContactFields). Читал
  // произвольные поля контакта по projectId, минуя visibility и ABAC, при нулевом
  // числе потребителей. Drift-сравнение доступно через resolveDocumentVariables,
  // который идёт через findOne и полный gate видимости.

  /**
   * Document variable provider (documents contract §4). Reads the contact scoped
   * to `projectId` AND the caller's visibility (`findOne` masks a cross-project or
   * invisible record as NOT_FOUND — a document must not be a read-around of an
   * inaccessible contact, SEC §4). Returns the flat `contact.*` variable map.
   */
  async resolveDocumentVariables(
    projectId: string,
    recordId: string,
    scope?: VisibilityScope,
  ): Promise<DocumentVariablesResult> {
    const row = await this.findOne(projectId, recordId, scope);
    return buildContactDocumentVariables(row as Record<string, unknown>);
  }

  /**
   * FR-CONTACTS-467: переназначить все живые контакты с `fromOwnerId` на `toOwnerId`.
   */
  async reassignFromOwner(
    projectId: string,
    fromOwnerId: string,
    toOwnerId: string,
    scope?: VisibilityScope,
    ctx?: Ctx,
    access?: AccessPredicate,
  ): Promise<{ reassigned: number }> {
    const from = fromOwnerId?.trim();
    const to = toOwnerId?.trim();
    if (!from || !to) throw new AppError('invalid', 'Укажите исходного и нового ответственного');
    if (from === to) return { reassigned: 0 };
    await this.reassignTargets.assertOwnerAssignable(
      projectId,
      to,
      ctx?.metadata,
      'toOwnerId',
      scope,
    );
    const coll = await this.mongo.contacts();
    const ownerMatch =
      from === OWNER_SCOPE_UNASSIGNED
        ? {
            $and: [
              {
                $or: [
                  { [OWNER_FIELD]: null },
                  { [OWNER_FIELD]: '' },
                  { [OWNER_FIELD]: { $exists: false } },
                ],
              },
              {
                $or: [
                  { [DEPARTMENT_FIELD]: null },
                  { [DEPARTMENT_FIELD]: '' },
                  { [DEPARTMENT_FIELD]: { $exists: false } },
                ],
              },
            ],
          }
        : { [OWNER_FIELD]: from };
    const and: Record<string, unknown>[] = [{ projectId, deletedAt: null }, ownerMatch];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };
    const affected = (await coll.find(filter).project({ _id: 1 }).toArray()) as { _id: ObjectId }[];
    if (!affected.length) return { reassigned: 0 };
    const ids = affected.map((d) => d._id.toString());
    return this.reassign(projectId, ids, { newOwnerId: to }, scope, ctx, access);
  }

  /**
   * FR-CONTACTS-440: агрегаты качества базы (visibility-aware).
   */
  async getQualityMetrics(
    projectId: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ): Promise<{
    totalContacts: number;
    filledBothPct: number;
    duplicateCandidatePairs: number;
    openDriftLinks: number;
  }> {
    const coll = await this.mongo.contacts();
    const and: Record<string, unknown>[] = [{ projectId, deletedAt: null }];
    const vis = this.visibilityFilter(scope);
    if (vis) and.push(vis);
    this.applyAccess(and, access);
    const filter = and.length === 1 ? and[0] : { $and: and };

    const [totalContacts, filledBoth, dupQueue] = await Promise.all([
      coll.countDocuments(filter),
      coll.countDocuments({
        ...filter,
        phone: { $nin: ['', null] as unknown as string[] },
        email: { $nin: ['', null] as unknown as string[] },
      }),
      this.listDuplicateQueue(projectId, 0, 1, scope, access),
    ]);

    const filledBothPct =
      totalContacts > 0 ? Math.round((filledBoth / totalContacts) * 1000) / 10 : 0;

    // Открытый drift на связях: контакты с осиротевшими companyLinks (пока pipe
    // не поставляет агрегат cross-domain).
    const openDriftLinks = await coll.countDocuments({
      ...filter,
      orphanedCompanyIds: { $exists: true, $ne: [] },
    });

    return {
      totalContacts,
      filledBothPct,
      duplicateCandidatePairs: dupQueue.total,
      openDriftLinks,
    };
  }

  /** FR-CONTACTS-468: обновить денормализованное поле последней активности. */
  async touchLastActivity(projectId: string, contactId: string, atMs: number): Promise<void> {
    if (!projectId || !contactId || !ObjectId.isValid(contactId) || !atMs) return;
    const coll = await this.mongo.contacts();
    const at = new Date(atMs);
    await coll.updateOne(
      {
        projectId,
        _id: new ObjectId(contactId),
        deletedAt: null,
        $or: [
          { lastActivityAt: { $exists: false } },
          { lastActivityAt: null },
          { lastActivityAt: { $lt: at } },
        ],
      },
      { $set: { lastActivityAt: at, updatedAt: new Date() } },
    );
  }
}
