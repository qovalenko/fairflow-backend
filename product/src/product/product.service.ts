import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  buildVisibilityFilter,
  evalGate,
  type AbacNode,
  type AccessPredicate,
  type EmitIntent,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { prefillToStruct } from './prefill-struct';
import { CrossDomainCountService } from '../usage/cross-domain-count.service';
import { ProjectModuleSettingsService } from '../control/project-module-settings.service';
import { DepartmentValidatorService } from '../control/department-validator.service';

/** Source domain stamped on every emitted envelope (RFC-4, EVENT_SOURCE_DOMAINS). */
const EVENT_SOURCE = 'product';

/** Legacy fallback when project integrationSettings.defaultCurrency is unset. */
const FALLBACK_CURRENCY = 'RUB';

/** Owner field for products is the department (product.md §1 dataSubjects). */
const OWNER_FIELD = 'ownerDepartmentId';
const UNITS = ['ONE_TIME', 'MONTHLY', 'YEARLY'];
// Documented domain values (product.md); not referenced in code yet.
const _PRODUCT_STATUSES = ['active', 'archived'];

type PrefillValue = string | number | boolean;
type Prefill = Record<string, PrefillValue>;

type ProductMutationPayload = {
  name?: string;
  description?: string;
  category?: string;
  price?: number;
  unit?: string;
  currency?: string;
  order_type_id?: string;
  orderTypeId?: string;
  order_type_name?: string;
  orderTypeName?: string;
  prefill?: Prefill;
  owner_department_id?: string;
  ownerDepartmentId?: string;
};

/** Escape user input before using it inside a RegExp (avoids ReDoS / injection, product.md §3.1 / S3). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ProductService {
  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    @Optional()
    @Inject(forwardRef(() => CrossDomainCountService))
    private readonly crossCounts?: CrossDomainCountService,
    @Optional()
    private readonly moduleSettings?: ProjectModuleSettingsService,
    // TODO-293: гейт ownerDepartmentId. Optional — контрактные/юнит-тесты строят
    // сервис без control-клиента; в этом случае поле принимается как раньше.
    @Optional()
    private readonly departments?: DepartmentValidatorService,
  ) {}

  /**
   * FR-PRODUCTS-050: one currency per project — always the project default.
   * An explicit payload currency is accepted only when it matches that default;
   * any mismatch is rejected (multi-currency per product is out of v1 scope).
   */
  private async resolveCurrency(projectId: string, explicit?: string): Promise<string> {
    const projectCurrency =
      (await this.moduleSettings?.defaultCurrency(projectId)) ?? FALLBACK_CURRENCY;
    const trimmed = explicit?.trim();
    if (trimmed && trimmed !== projectCurrency) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: JSON.stringify({
          code: 'CURRENCY_PROJECT_MISMATCH',
          expected: projectCurrency,
          provided: trimmed,
        }),
      });
    }
    return projectCurrency;
  }

  /** Actor classification for an envelope: a user action vs an internal/service one. */
  private actorOf(userId?: string): { userId?: string; actorType: 'user' | 'service' } {
    return userId ? { userId, actorType: 'user' } : { actorType: 'service' };
  }

  async ensureSeed(projectId: string) {
    const n = await this.mongo.products().countDocuments({ projectId });
    if (n > 0) return;
    const now = Date.now();
    const currency = await this.resolveCurrency(projectId);
    await this.mongo.products().insertOne({
      _id: new ObjectId(),
      projectId,
      name: 'Демо-продукт',
      description: '',
      category: 'Услуги',
      price: 50000,
      effectivePrice: 50000,
      currency,
      unit: 'ONE_TIME',
      orderTypeId: '',
      orderTypeName: '',
      orderTypeDangling: false,
      prefill: {},
      status: 'active',
      archivedAt: null,
      ownerDepartmentId: null,
      dealsCount: 0,
      activeDealsCount: 0,
      ordersCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private toRow(d: Record<string, unknown>) {
    return {
      id: (d._id as ObjectId).toString(),
      name: String(d.name),
      description: String(d.description ?? ''),
      category: String(d.category ?? ''),
      price: Number(d.price ?? 0),
      effective_price: Number(d.effectivePrice ?? d.price ?? 0),
      currency: String(d.currency ?? 'RUB'),
      unit: String(d.unit ?? 'ONE_TIME'),
      order_type_id: String(d.orderTypeId ?? ''),
      order_type_name: String(d.orderTypeName ?? ''),
      order_type_dangling: Boolean(d.orderTypeDangling ?? false),
      // GAP-PRODUCTS-160: prefill is a proto Struct on the wire — a plain map
      // serialises to zero bytes, so the field never reached the caller.
      prefill: prefillToStruct(d.prefill),
      status: String(d.status ?? 'active'),
      archived_at: d.archivedAt == null ? 0 : Number(d.archivedAt),
      owner_department_id: d.ownerDepartmentId == null ? '' : String(d.ownerDepartmentId),
      deals_count: Number(d.dealsCount ?? 0),
      active_deals_count: Number(d.activeDealsCount ?? 0),
      orders_count: Number(d.ordersCount ?? 0),
      created_at: Number(d.createdAt),
      updated_at: Number(d.updatedAt),
    };
  }

  private validateProjectId(projectId: string) {
    if (!projectId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'project_id is required' });
    }
  }

  private invalid(message: string, details?: Record<string, unknown>): never {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message,
      ...(details ? { details } : {}),
    });
  }

  private validateName(name?: string) {
    if (!name?.trim()) this.invalid('name is required');
  }

  /** Sanitize prefill: only scalar (string/number/bool) values are allowed (V6 / proto Struct). */
  private sanitizePrefill(prefill?: Prefill): Prefill | undefined {
    if (prefill == null) return undefined;
    const out: Prefill = {};
    for (const [k, v] of Object.entries(prefill)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
      } else if (v != null) {
        this.invalid('prefill must contain only scalar values', { field: k });
      }
    }
    return out;
  }

  /**
   * A malformed `x-access-predicate` is a broken deny-rule → the whole read must be
   * denied, never silently widened (RFC-ABAC §4 fail-closed). A deny surfaces as an
   * empty list / NOT_FOUND: DENY_ALL_ID never matches a real ObjectId, so it turns
   * any list/get filter into "matches nothing" without leaking existence.
   */
  private static readonly DENY_ALL_ID = new ObjectId('000000000000000000000000');

  /**
   * Compose the read filter: `{ projectId } AND visibility AND abac` (E2-08 / RFC-5 §1.4).
   *
   * `access` is the three-state predicate resolved on the gateway:
   *  - absent (`present:false`)     → no ABAC narrowing (projectId + visibility only);
   *  - malformed (`malformed:true`) → fail-closed: force a filter that matches nothing;
   *  - present with `.mongo`        → AND the compiled fragment into the read.
   *
   * Products are defaultVisibility="all" + ownable by department, so a user-owner
   * visibility scope normally yields no extra constraint — the ABAC fragment is the
   * dimension that narrows on category / effectivePrice / department attributes.
   */
  private scopedFilter(
    projectId: string,
    scope: VisibilityScope | undefined,
    extra: Record<string, unknown>[] = [],
    access?: AccessPredicate,
  ): Record<string, unknown> {
    if (access && access.present && access.malformed) {
      // Fail-closed: broken predicate ⇒ match nothing (still projectId-scoped).
      return { $and: [{ projectId }, { _id: ProductService.DENY_ALL_ID }] };
    }
    const and: Record<string, unknown>[] = [{ projectId }, ...extra];
    const vis = buildVisibilityFilter<ObjectId>(scope, OWNER_FIELD, []);
    if (vis) and.push(vis);
    if (
      access &&
      access.present &&
      !access.malformed &&
      access.mongo &&
      Object.keys(access.mongo).length
    ) {
      and.push(access.mongo);
    }
    return and.length === 1 ? and[0] : { $and: and };
  }

  /**
   * Single-record ABAC gate for get-by-id / mutations (`evalGate` side of the
   * contract-equivalent pair, RFC-ABAC §4). Returns `true` iff the record passes:
   *  - absent predicate → pass (no rules);
   *  - malformed        → fail-closed deny;
   *  - present with `.ir` → `evalGate(ir, record)`; a present predicate that carries
   *    only `.mongo` (no `.ir`) is treated as pass at the gate — the mongo fragment
   *    is applied on the read filter path instead (get loads through `scopedFilter`).
   */
  private passesAccessGate(record: Record<string, unknown>, access?: AccessPredicate): boolean {
    if (!access || !access.present) return true;
    if (access.malformed) return false;
    if (!access.ir) return true;
    try {
      return evalGate(access.ir as AbacNode, record);
    } catch {
      // A predicate that reaches evalGate but throws (e.g. unresolved ref) is broken
      // → deny (fail-closed), never pass.
      return false;
    }
  }

  async list(
    projectId: string,
    pageIndex: number,
    pageSize: number,
    opts: {
      query?: string;
      category?: string;
      statusFilter?: string;
      sort?: string;
      scope?: VisibilityScope;
      access?: AccessPredicate;
    } = {},
  ) {
    this.validateProjectId(projectId);
    // Clamp instead of throwing: matches activity.service (Math.min(...,100)) so
    // "load-all" pickers (pageSize:1000) get a capped page rather than a 500.
    pageSize = Math.min(Math.max(pageSize || 25, 1), 100);
    const statusFilter = opts.statusFilter || 'active';
    if (!['active', 'archived', 'all'].includes(statusFilter)) {
      this.invalid('invalid status filter', { status: statusFilter });
    }
    const extra: Record<string, unknown>[] = [];
    if (opts.query?.trim()) {
      const q = opts.query.trim().slice(0, 200);
      extra.push({ name: new RegExp(escapeRegExp(q), 'i') });
    }
    if (opts.category?.trim()) extra.push({ category: opts.category.trim() });
    if (statusFilter !== 'all') extra.push({ status: statusFilter });

    const filter = this.scopedFilter(projectId, opts.scope, extra, opts.access);
    const sortSpec: Record<string, 1 | -1> =
      opts.sort === 'name'
        ? { name: 1 }
        : opts.sort === 'updatedAt'
          ? { updatedAt: -1 }
          : { updatedAt: -1 };

    const total = await this.mongo.products().countDocuments(filter);
    const rows = await this.mongo
      .products()
      .find(filter)
      .sort(sortSpec)
      .skip(pageIndex * pageSize)
      .limit(pageSize)
      .toArray();
    return { list: rows.map((r) => this.toRow(r as Record<string, unknown>)), total };
  }

  async get(projectId: string, id: string, scope?: VisibilityScope, access?: AccessPredicate) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const d = await this.mongo
      .products()
      .findOne(this.scopedFilter(projectId, scope, [{ _id: new ObjectId(id) }], access));
    // scopedFilter already AND-ed the abac `.mongo` fragment (and denies on malformed);
    // re-check with the single-record `evalGate` gate so get is exactly the contract
    // pair of the list filter (RFC-ABAC §4). Failing the gate is NOT_FOUND, never leak.
    if (!d || !this.passesAccessGate(d as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    return this.toRow(d as Record<string, unknown>);
  }

  async create(projectId: string, payload: ProductMutationPayload, userId?: string) {
    this.validateProjectId(projectId);
    this.validateName(payload.name);
    const price = Number(payload.price ?? 0);
    if (price < 0) this.invalid('price must be ≥ 0', { price });
    const unit = payload.unit ?? 'ONE_TIME';
    if (!UNITS.includes(unit)) this.invalid('invalid unit', { unit });
    const prefill = this.sanitizePrefill(payload.prefill) ?? {};

    // S5: take ownerDepartmentId from a trusted source; null (project level) allowed.
    // TODO-293: непустое значение проверяется по составу подразделений проекта —
    // это OWNER_FIELD каталога, и выдуманный id прячет продукт у всех, чей режим
    // видимости не `all` (а update поле не переписывает, S6 — чинить пришлось бы руками).
    const ownerDepartmentId = payload.owner_department_id ?? payload.ownerDepartmentId ?? null;
    await this.departments?.assertOwnerDepartment(projectId, ownerDepartmentId);

    const now = Date.now();
    const currency = await this.resolveCurrency(projectId, payload.currency);
    const doc = {
      _id: new ObjectId(),
      projectId,
      name: payload.name!.trim(),
      description: payload.description ?? '',
      category: payload.category ?? '',
      price,
      effectivePrice: price,
      currency,
      unit,
      orderTypeId: payload.order_type_id ?? payload.orderTypeId ?? '',
      orderTypeName: payload.order_type_name ?? payload.orderTypeName ?? '',
      orderTypeDangling: false,
      prefill,
      status: 'active',
      archivedAt: null,
      ownerDepartmentId,
      dealsCount: 0,
      activeDealsCount: 0,
      ordersCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const id = doc._id.toString();
    // Insert + `crm.product.created` row in one Mongo tx — no product without an
    // event, no event without a product (invariant Д-1; RFC-4 §Р-3 — audit/search/automation).
    await this.outbox.withOutbox(async (session) => {
      await this.mongo.products().insertOne(doc, session ? { session } : {});
      const intents: EmitIntent[] = [
        {
          type: 'crm.product.created',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.created:${id}`,
          ...this.actorOf(userId),
          payload: {
            after: {
              id,
              name: doc.name,
              category: doc.category,
              orderTypeId: doc.orderTypeId,
              price: doc.price,
              currency: doc.currency,
            },
          },
        },
      ];
      return { result: undefined, intents };
    });
    return this.toRow(doc as unknown as Record<string, unknown>);
  }

  async update(
    projectId: string,
    id: string,
    payload: ProductMutationPayload,
    userId?: string,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });

    const before = await this.mongo.products().findOne({ _id: new ObjectId(id), projectId });
    // ABAC gate (E2-08): a record the actor may not see (predicate deny / malformed)
    // is masked as NOT_FOUND before any mutation runs.
    if (!before || !this.passesAccessGate(before as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });

    // S6: projectId / ownerDepartmentId are never overwritten via update.
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (payload.name !== undefined) {
      this.validateName(payload.name);
      set.name = payload.name.trim();
    }
    if (payload.description !== undefined) set.description = payload.description;
    if (payload.category !== undefined) set.category = payload.category;
    let priceChanged = false;
    if (payload.price !== undefined) {
      const price = Number(payload.price);
      if (price < 0) this.invalid('price must be ≥ 0', { price });
      set.price = price;
      set.effectivePrice = price; // V9: effectivePrice recomputed on price change.
      priceChanged = price !== Number(before.price ?? 0);
    }
    if (payload.unit !== undefined) {
      if (!UNITS.includes(payload.unit)) this.invalid('invalid unit', { unit: payload.unit });
      set.unit = payload.unit;
    }
    if (payload.currency !== undefined) {
      set.currency = await this.resolveCurrency(projectId, payload.currency);
    }
    if (payload.prefill !== undefined) set.prefill = this.sanitizePrefill(payload.prefill) ?? {};
    const newOrderTypeId = payload.order_type_id ?? payload.orderTypeId;
    let orderTypeChanged = false;
    if (newOrderTypeId !== undefined) {
      set.orderTypeId = newOrderTypeId;
      set.orderTypeName = payload.order_type_name ?? payload.orderTypeName ?? '';
      set.orderTypeDangling = false; // re-linking a type clears the dangling flag.
      orderTypeChanged = newOrderTypeId !== String(before.orderTypeId ?? '');
    } else if (payload.order_type_name ?? payload.orderTypeName) {
      set.orderTypeName = payload.order_type_name ?? payload.orderTypeName;
    }

    // changes[] diff (RFC-4 `crm.product.updated` payload) over the fields actually $set.
    const changes: { field: string; old: unknown; new: unknown }[] = [];
    for (const field of Object.keys(set)) {
      if (field === 'updatedAt') continue;
      const oldVal = (before as Record<string, unknown>)[field];
      const newVal = set[field];
      if (oldVal !== newVal) changes.push({ field, old: oldVal ?? null, new: newVal });
    }

    // Update + `crm.product.updated` (+ price_changed / order_type_changed) in one
    // Mongo tx (invariant Д-1; RFC-4 §Р-3 — audit/search/automation/statistics).
    const result = await this.outbox.withOutbox(async (session) => {
      const updated = await this.mongo
        .products()
        .findOneAndUpdate(
          { _id: new ObjectId(id), projectId },
          { $set: set },
          { returnDocument: 'after', ...(session ? { session } : {}) },
        );
      if (!updated) throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
      const actor = this.actorOf(userId);
      const updatedAt = Number(set.updatedAt);
      const intents: EmitIntent[] = [
        {
          type: 'crm.product.updated',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.updated:${id}:${updatedAt}`,
          ...actor,
          payload: { id, changes },
        },
      ];
      if (priceChanged) {
        intents.push({
          type: 'crm.product.price_changed',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.price_changed:${id}:${updatedAt}`,
          ...actor,
          payload: {
            id,
            old: Number(before.price ?? 0),
            new: Number(set.price),
            currency: String(updated.currency ?? before.currency ?? 'RUB'),
            projectId,
          },
        });
      }
      if (orderTypeChanged) {
        intents.push({
          type: 'crm.product.order_type_changed',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.order_type_changed:${id}:${updatedAt}`,
          ...actor,
          payload: {
            id,
            old: String(before.orderTypeId ?? ''),
            new: String(set.orderTypeId ?? ''),
          },
        });
      }
      return { result: updated, intents };
    });
    return this.toRow(result as Record<string, unknown>);
  }

  async archive(projectId: string, id: string, userId?: string, access?: AccessPredicate) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const doc = await this.mongo.products().findOne({ _id: new ObjectId(id), projectId });
    if (!doc || !this.passesAccessGate(doc as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    if (doc.status === 'archived')
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Продукт уже в архиве',
        details: { status: 'archived' },
      });
    const affected = this.affectedOf(doc as Record<string, unknown>);
    // Soft-delete + `crm.product.archived` row in one Mongo tx (invariant Д-1; RFC-4 §Р-3).
    await this.outbox.withOutbox(async (session) => {
      const now = Date.now();
      await this.mongo
        .products()
        .updateOne(
          { _id: new ObjectId(id), projectId },
          { $set: { status: 'archived', archivedAt: now, updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.product.archived',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.archived:${id}`,
          ...this.actorOf(userId),
          payload: { id, affected: { deals: affected.deals, orders: affected.orders } },
        },
      ];
      return { result: undefined, intents };
    });
    return { ok: true, affected };
  }

  async restore(projectId: string, id: string, userId?: string, access?: AccessPredicate) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const doc = await this.mongo.products().findOne({ _id: new ObjectId(id), projectId });
    if (!doc || !this.passesAccessGate(doc as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    if ((doc.status ?? 'active') === 'active')
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Продукт не в архиве',
        details: { status: 'active' },
      });
    // Restore + `crm.product.restored` row in one Mongo tx (invariant Д-1; RFC-4 §Р-3).
    const result = await this.outbox.withOutbox(async (session) => {
      const now = Date.now();
      const updated = await this.mongo
        .products()
        .findOneAndUpdate(
          { _id: new ObjectId(id), projectId },
          { $set: { status: 'active', archivedAt: null, updatedAt: now } },
          { returnDocument: 'after', ...(session ? { session } : {}) },
        );
      const intents: EmitIntent[] = [
        {
          type: 'crm.product.restored',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.restored:${id}`,
          ...this.actorOf(userId),
          payload: { id },
        },
      ];
      return { result: updated, intents };
    });
    return this.toRow(result as Record<string, unknown>);
  }

  /** force=false → archive (soft); force=true → hard delete when no orders reference the product. */
  async delete(
    projectId: string,
    id: string,
    force = false,
    userId?: string,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });

    if (!force) {
      // fail-safe: non-force delete behaves as archive (product.md §3.7 / FR-MPRD-5).
      const doc = await this.mongo.products().findOne({ _id: new ObjectId(id), projectId });
      if (!doc || !this.passesAccessGate(doc as Record<string, unknown>, access))
        throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
      if (doc.status === 'archived') return { ok: true, affected: this.affectedOf(doc) };
      const res = await this.archive(projectId, id, userId, access);
      return { ok: true, affected: res.affected };
    }

    const doc = await this.mongo.products().findOne({ _id: new ObjectId(id), projectId });
    if (!doc || !this.passesAccessGate(doc as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });

    // Delete-guard (V7): authoritative cross-domain counts when available; advisory
    // counters are the fallback when pipe/orders RPCs are unreachable.
    let deals = Number(doc.dealsCount ?? 0);
    let orders = Number(doc.ordersCount ?? 0);
    if (this.crossCounts) {
      const dealCounts = await this.crossCounts.countDeals(projectId, id);
      const orderCount = await this.crossCounts.countOrders(projectId, id);
      if (dealCounts != null) deals = dealCounts.deals;
      if (orderCount != null) orders = orderCount;
    }
    // Orders keep productId on the sale row — block hard delete until archived/cancelled.
    // Linked deals are cleared downstream by pipe on `crm.product.deleted` (FR-DEALS-490).
    if (orders > 0) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: 'Есть связанные продажи — архивируйте продукт',
        details: { deals, orders },
      });
    }
    // Hard delete + `crm.product.deleted` row in one Mongo tx (invariant Д-1; RFC-4 §Р-3, registered).
    await this.outbox.withOutbox(async (session) => {
      const res = await this.mongo
        .products()
        .deleteOne({ _id: new ObjectId(id), projectId }, session ? { session } : {});
      if (!res.deletedCount)
        throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
      const intents: EmitIntent[] = [
        {
          type: 'crm.product.deleted',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          idempotencyKey: `product.deleted:${id}`,
          ...this.actorOf(userId),
          payload: { id },
        },
      ];
      return { result: undefined, intents };
    });
    return { ok: true };
  }

  private affectedOf(doc: Record<string, unknown>) {
    return {
      deals: Number(doc.dealsCount ?? 0),
      orders: Number(doc.ordersCount ?? 0),
      active_deals: Number(doc.activeDealsCount ?? 0),
      // TODO(OQ-MPRD-7): by_user from productUsage projection (S4: department-scope + PII gating).
      by_user: [] as { user_id: string; deals: number; orders: number }[],
    };
  }

  /**
   * FR-PRODUCTS-230: разложить связи продукта по подразделениям и людям.
   *
   * Считаем по фактам (живые сделки/продажи с этим productId), а не по скалярным
   * счётчикам на карточке: счётчик хранит одно число, а срез — это группировка.
   * Обе группировки идут одним `$group` по своему ключу, поэтому стоимость —
   * два прохода по `{projectId, productId}` (индексируемый префикс).
   *
   * Изоляция: `projectId` берётся из доверенного источника и стоит первым в
   * `$match` — срез не может увидеть чужой проект. Продажи (orders) поля
   * `departmentId` не несут вовсе, поэтому в `by_department` они попадают только
   * там, где оно есть; счётчик `orders` в остальных строках честно 0.
   *
   * @param departmentId необязательное сужение среза до одного подразделения.
   */
  private async usageBreakdown(
    projectId: string,
    productId: string,
    departmentId?: string,
    withUsers = false,
  ): Promise<{
    byDepartment: { department_id: string; deals: number; orders: number }[];
    byUser: { user_id: string; deals: number; orders: number }[];
  }> {
    const dept = (departmentId ?? '').trim();
    const dealsMatch: Record<string, unknown> = {
      projectId,
      productId,
      deletedAt: { $in: [null, undefined] },
    };
    const ordersMatch: Record<string, unknown> = {
      projectId,
      productId,
      status: { $ne: 'CANCELLED' },
    };
    if (dept) {
      dealsMatch.departmentId = dept;
      ordersMatch.departmentId = dept;
    }

    const [dealsByDept, ordersByDept] = await Promise.all([
      this.mongo
        .deals()
        .aggregate([
          { $match: dealsMatch },
          { $group: { _id: { $ifNull: ['$departmentId', ''] }, count: { $sum: 1 } } },
        ])
        .toArray(),
      this.mongo
        .orders()
        .aggregate([
          { $match: ordersMatch },
          { $group: { _id: { $ifNull: ['$departmentId', ''] }, count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const departments = new Map<string, { deals: number; orders: number }>();
    const bump = (key: string, field: 'deals' | 'orders', n: number) => {
      const row = departments.get(key) ?? { deals: 0, orders: 0 };
      row[field] += n;
      departments.set(key, row);
    };
    for (const r of dealsByDept) bump(String(r._id ?? ''), 'deals', Number(r.count ?? 0));
    for (const r of ordersByDept) bump(String(r._id ?? ''), 'orders', Number(r.count ?? 0));
    const byDepartment = [...departments.entries()]
      .map(([department_id, v]) => ({ department_id, ...v }))
      .sort(
        (a, b) =>
          b.deals + b.orders - (a.deals + a.orders) ||
          a.department_id.localeCompare(b.department_id),
      );

    if (!withUsers) return { byDepartment, byUser: [] };

    const [dealsByUser, ordersByUser] = await Promise.all([
      this.mongo
        .deals()
        .aggregate([
          { $match: dealsMatch },
          {
            $group: {
              _id: { $ifNull: ['$assigneeId', { $ifNull: ['$ownerId', ''] }] },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      this.mongo
        .orders()
        .aggregate([
          { $match: ordersMatch },
          {
            $group: {
              _id: { $ifNull: ['$assigneeId', { $ifNull: ['$ownerId', ''] }] },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);
    const users = new Map<string, { deals: number; orders: number }>();
    const bumpUser = (key: string, field: 'deals' | 'orders', n: number) => {
      const row = users.get(key) ?? { deals: 0, orders: 0 };
      row[field] += n;
      users.set(key, row);
    };
    for (const r of dealsByUser) bumpUser(String(r._id ?? ''), 'deals', Number(r.count ?? 0));
    for (const r of ordersByUser) bumpUser(String(r._id ?? ''), 'orders', Number(r.count ?? 0));
    const byUser = [...users.entries()]
      .filter(([user_id]) => user_id !== '')
      .map(([user_id, v]) => ({ user_id, ...v }))
      .sort(
        (a, b) => b.deals + b.orders - (a.deals + a.orders) || a.user_id.localeCompare(b.user_id),
      );

    return { byDepartment, byUser };
  }

  async usage(
    projectId: string,
    id: string,
    departmentId?: string,
    scope?: VisibilityScope,
    access?: AccessPredicate,
  ) {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(id))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    const doc = await this.mongo
      .products()
      .findOne(this.scopedFilter(projectId, scope, [{ _id: new ObjectId(id) }], access));
    if (!doc || !this.passesAccessGate(doc as Record<string, unknown>, access))
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    // S4 (PII-гейт): пофамильный срез — персональные данные, поэтому его получает
    // только наблюдатель с полной видимостью (`mode: 'all'` — то, во что gateway
    // разворачивает manage/руководителя). Рядовому пользователю остаются агрегаты
    // по подразделениям. Fail-closed: нет резолвленного scope → нет пофамильного среза.
    const canSeeUsers = scope?.mode === 'all';
    const { byDepartment, byUser } = await this.usageBreakdown(
      projectId,
      id,
      departmentId,
      canSeeUsers,
    );
    return {
      deals_count: Number(doc.dealsCount ?? 0),
      active_deals_count: Number(doc.activeDealsCount ?? 0),
      orders_count: Number(doc.ordersCount ?? 0),
      by_department: byDepartment,
      by_user: byUser,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Catalog usage counters (contract §5.2): kept current by the inbound listener
  // off `crm.deal.product_*` / `crm.order.created|cancelled`, idempotent by dedup-key.
  // The same listener carries `crm.order_type.deleted|restored` into the
  // `orderTypeDangling` flag (see applyOrderTypeDangling).
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Record an envelope dedup-key as processed; returns `true` if THIS call is the
   * first to see it (so the counter mutation should run). A duplicate redelivery
   * loses the race on the unique index → `false` → counter is NOT applied twice.
   */
  private async markProcessed(
    dedupKey: string,
    routingKey: string,
    projectId: string,
  ): Promise<boolean> {
    if (!dedupKey) return true;
    try {
      await this.mongo.usageProcessed().insertOne({
        dedupKey,
        routingKey,
        projectId,
        processedAt: new Date(),
      });
      return true;
    } catch (err) {
      // Duplicate key (11000) → already processed; anything else → rethrow.
      const code = (err as { code?: number }).code;
      if (code === 11000) return false;
      throw err;
    }
  }

  /**
   * Apply a deal↔product link/unlink fact to `dealsCount` (+ `activeDealsCount`
   * for open deals), scoped to `{projectId, _id:productId}` (listener isolation,
   * §5.2). Counters never go below 0. Idempotent by `dedupKey`.
   */
  async applyDealLink(
    projectId: string,
    productId: string,
    delta: 1 | -1,
    active: boolean,
    dedupKey: string,
    routingKey: string,
  ): Promise<void> {
    if (!projectId || !productId || !ObjectId.isValid(productId)) return;
    if (!(await this.markProcessed(dedupKey, routingKey, projectId))) return;
    const inc: Record<string, number> = { dealsCount: delta };
    if (active) inc.activeDealsCount = delta;
    await this.bumpCounters(projectId, productId, inc);
  }

  /**
   * Apply an open↔closed deal lifecycle fact to `activeDealsCount` only — the deal
   * stays linked to the product, so `dealsCount` is unchanged (FR-PRODUCTS-210).
   */
  async applyDealActiveChange(
    projectId: string,
    productId: string,
    delta: 1 | -1,
    dedupKey: string,
    routingKey: string,
  ): Promise<void> {
    if (!projectId || !productId || !ObjectId.isValid(productId)) return;
    if (!(await this.markProcessed(dedupKey, routingKey, projectId))) return;
    await this.bumpCounters(projectId, productId, { activeDealsCount: delta });
  }

  /**
   * Apply an order↔product create/cancel fact to `ordersCount`, scoped to
   * `{projectId, _id:productId}`. Counters never go below 0. Idempotent by `dedupKey`.
   */
  async applyOrderLink(
    projectId: string,
    productId: string,
    delta: 1 | -1,
    dedupKey: string,
    routingKey: string,
  ): Promise<void> {
    if (!projectId || !productId || !ObjectId.isValid(productId)) return;
    if (!(await this.markProcessed(dedupKey, routingKey, projectId))) return;
    await this.bumpCounters(projectId, productId, { ordersCount: delta });
  }

  /**
   * Set/clear the "dangling order-type link" flag on every product of the project
   * that points at `orderTypeId` (FR-PRODUCTS-130/140/320, TODO-233).
   *
   * The fact arrives from an orders envelope — `crm.order_type.deleted` raises the
   * flag, `crm.order_type.restored` lowers it — and is applied strictly inside the
   * envelope's `projectId`; the caller never supplies one (listener isolation §5.2).
   *
   * The `orderTypeId` reference itself is deliberately KEPT, not nulled: the UI
   * banner offers "reassign the type", and a restore of the same type has to heal
   * the link by itself — impossible once the reference is erased. Editing a product
   * onto another type already clears the flag (`update`, `set.orderTypeDangling`).
   *
   * Idempotency is structural, not ledger-based: the filter matches only documents
   * whose flag differs from the target, so a redelivery finds nothing, rewrites
   * nothing and emits nothing. (The dedup journal used by the counters is
   * deliberately not used here — it records the key BEFORE the mutation, so a
   * broker retry after a mid-flight failure would skip the write and leave the flag
   * wrong forever. A counter can be repaired by RecountProductUsage; this flag has
   * no reconciliation RPC.) Update + `crm.product.order_type_dangling` rows commit
   * in one Mongo tx (invariant Д-1).
   *
   * @returns how many products changed state (0 = nothing to do / duplicate).
   */
  async applyOrderTypeDangling(
    projectId: string,
    orderTypeId: string,
    dangling: boolean,
  ): Promise<number> {
    if (!projectId || !orderTypeId) return 0;
    const filter = { projectId, orderTypeId, orderTypeDangling: { $ne: dangling } };
    const affected = (await this.mongo
      .products()
      .find(filter, { projection: { _id: 1, name: 1, orderTypeName: 1 } })
      .toArray()) as unknown as Record<string, unknown>[];
    if (!affected.length) return 0;

    const now = Date.now();
    await this.outbox.withOutbox(async (session) => {
      await this.mongo
        .products()
        .updateMany(
          filter,
          { $set: { orderTypeDangling: dangling, updatedAt: now } },
          session ? { session } : {},
        );
      const intents: EmitIntent[] = affected.map((doc) => {
        const id = (doc._id as ObjectId).toString();
        return {
          type: 'crm.product.order_type_dangling',
          source: EVENT_SOURCE,
          projectId,
          subject: `product/${id}`,
          // Stable per (product, type, state): a duplicate delivery that somehow
          // races past the $ne filter still carries the same key downstream.
          idempotencyKey: `product.order_type_dangling:${id}:${orderTypeId}:${dangling}`,
          actorType: 'service',
          payload: {
            id,
            name: String(doc.name ?? ''),
            orderTypeId,
            orderTypeName: String(doc.orderTypeName ?? ''),
            dangling,
          },
        };
      });
      return { result: undefined, intents };
    });
    return affected.length;
  }

  /** $inc the given counters, then clamp any that went negative back to 0 (§5.2). */
  private async bumpCounters(
    projectId: string,
    productId: string,
    inc: Record<string, number>,
  ): Promise<void> {
    const filter = { _id: new ObjectId(productId), projectId };
    await this.mongo.products().updateOne(filter, { $inc: inc, $set: { updatedAt: Date.now() } });
    // Clamp: a redelivered unlink/decrement must never drive a counter below 0.
    const fields = Object.keys(inc);
    const doc = await this.mongo.products().findOne(filter);
    if (!doc) return;
    const fix: Record<string, number> = {};
    for (const f of fields) {
      if (Number(doc[f] ?? 0) < 0) fix[f] = 0;
    }
    if (Object.keys(fix).length) await this.mongo.products().updateOne(filter, { $set: fix });
  }

  /**
   * Reconciliation (contract §3.10): recompute a product's counters from the
   * authoritative cross-domain counts and persist them. `counts` is supplied by
   * the caller (gateway/relay) which holds the pipe/orders clients. Returns the
   * number of products updated. Scope `{projectId}` is the isolation boundary.
   */
  async recountUsage(
    projectId: string,
    productId: string,
    counts: { deals?: number; activeDeals?: number; orders?: number },
  ): Promise<void> {
    this.validateProjectId(projectId);
    if (!ObjectId.isValid(productId)) return;
    // Счётчики частичные (TODO-229): в $set попадают только те, чей источник
    // ответил. Отсутствующий ключ — «не знаю», а не «ноль»: последнее известное
    // значение остаётся в документе, а не затирается нулём из-за лежащего домена.
    const set: Record<string, unknown> = {};
    if (counts.deals != null) set.dealsCount = Math.max(0, counts.deals);
    if (counts.activeDeals != null) set.activeDealsCount = Math.max(0, counts.activeDeals);
    if (counts.orders != null) set.ordersCount = Math.max(0, counts.orders);
    if (Object.keys(set).length === 0) return;
    set.updatedAt = Date.now();
    await this.mongo
      .products()
      .updateOne({ _id: new ObjectId(productId), projectId }, { $set: set });
  }

  /** Product ids of the project (for project-wide reconciliation backfill). */
  async listProductIds(projectId: string): Promise<string[]> {
    this.validateProjectId(projectId);
    const docs = await this.mongo
      .products()
      .find({ projectId }, { projection: { _id: 1 } })
      .toArray();
    return docs.map((d) => (d._id as ObjectId).toString());
  }

  async listCategories(projectId: string, scope?: VisibilityScope, access?: AccessPredicate) {
    this.validateProjectId(projectId);
    // Isolation: distinct MUST carry {projectId} or it leaks all projects' categories.
    // ABAC/visibility (E2-08): distinct over the SAME scoped filter as list — a
    // category present only on records the actor cannot see must not surface; a
    // malformed predicate denies (empty categories via DENY_ALL_ID).
    const filter = this.scopedFilter(projectId, scope, [], access);
    const raw = (await this.mongo.products().distinct('category', filter)) as unknown[];
    const categories = raw
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
    return { categories };
  }
}
