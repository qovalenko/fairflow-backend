import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  GW_METADATA,
  newEntityId,
  serializeVisibilityScope,
  type VisibilityScope,
} from '@fairflow/shared';
import type { SourceRead } from './order-drift';

/**
 * s2s admin visibility scope: `mode:'all'` short-circuits the donors'
 * `isRecordVisible`/`buildVisibilityFilter` to "visible" (rbac.ts). Without this
 * header the donors read `undefined` and fail-closed (Д-3) → every existing entity
 * answers NOT_FOUND and drift would be mis-flagged as "source deleted". A trusted
 * s2s caller (its x-service-api-key is validated by the donor) is authorised to
 * read any record in the project for the sole purpose of the drift snapshot.
 */
const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

interface ContactSvc {
  getContact: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{
    first_name?: string;
    last_name?: string;
    middle_name?: string;
    phone?: string;
    email?: string;
  }>;
}
interface CompanySvc {
  getCompany: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ name?: string; inn?: string; kpp?: string }>;
}
/** Read-only deal lookup — only the deal NAME is used (document variables). */
interface PipeSvc {
  getDeal: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ name?: string }>;
}
/** Read-only product lookup — sale-type link + snapshot/prefill for createOrder. */
interface ProductSvc {
  getProduct: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{
    name?: string;
    order_type_id?: string;
    order_type_dangling?: boolean;
    price?: number;
    effective_price?: number;
    currency?: string;
    unit?: string;
    category?: string;
    prefill?: unknown;
  }>;
}

/** Product context captured when binding a catalog item to a sale (FR-PRODUCTS-170/180). */
export type ProductForOrder = {
  orderTypeId: string;
  dangling: boolean;
  name: string;
  price: number;
  currency: string;
  unit: string;
  category: string;
  prefill: Record<string, string | number | boolean>;
};

function prefillFromStruct(value: unknown): Record<string, string | number | boolean> {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value) && 'fields' in (value as object)) {
    const fields =
      (
        value as {
          fields?: Record<
            string,
            { stringValue?: string; numberValue?: number; boolValue?: boolean }
          >;
        }
      ).fields ?? {};
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v.stringValue !== undefined) out[k] = v.stringValue;
      else if (v.numberValue !== undefined) out[k] = v.numberValue;
      else if (v.boolValue !== undefined) out[k] = v.boolValue;
    }
    return out;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }
  return {};
}

const READ_TIMEOUT_MS = Number(process.env.ORDERS_SOURCE_READ_TIMEOUT_MS ?? 2000);

/**
 * Reads the current contact/company requisites for the order drift-check over
 * gRPC (contact/company domains) with a service-to-service metadata envelope
 * (x-service-api-key + propagated context). Every read carries the order's
 * `projectId`, so a foreign projectId can never read another tenant's entity
 * (isolation S7).
 *
 * Fail-soft contract (see {@link SourceState}):
 *  - donor returns the entity → `{ state:'present', fields }`;
 *  - donor answers NOT_FOUND   → `{ state:'deleted', fields:{} }`;
 *  - timeout / donor down      → `{ state:'unknown', fields:{} }` (do NOT claim drift).
 * `checkDrift` never fails because a donor is unreachable; `acceptDrift` refuses
 * to re-capture when a linked source is `unknown` (cannot re-read).
 */
@Injectable()
export class OrderSourceReaderService implements OnModuleInit {
  private readonly logger = new Logger(OrderSourceReaderService.name);
  private contact!: ContactSvc;
  private company!: CompanySvc;
  private pipe!: PipeSvc;
  private product!: ProductSvc;
  private readonly apiKey =
    process.env.ORDERS_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';

  constructor(
    @Inject('CONTACT_GRPC') private readonly contactClient: ClientGrpcProxy,
    @Inject('COMPANY_GRPC') private readonly companyClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('PRODUCT_GRPC') private readonly productClient: ClientGrpcProxy,
  ) {}

  onModuleInit(): void {
    this.contact = this.contactClient.getService<ContactSvc>('ContactGrpc');
    this.company = this.companyClient.getService<CompanySvc>('CompanyGrpc');
    this.pipe = this.pipeClient.getService<PipeSvc>('PipeGrpc');
    this.product = this.productClient.getService<ProductSvc>('ProductGrpc');
  }

  /**
   * s2s metadata accepted by the donor inbound api-key guards.
   *
   * `scope` — visibility of the read:
   *  - omitted → the s2s {@link SERVICE_SCOPE} (`mode:'all'`): the drift snapshot
   *    is a system job with no end-user actor, and a donor without a scope
   *    fails-closed (Д-3);
   *  - given → the CALLER's own scope, so a read made on behalf of a user
   *    (document variables) is gated exactly like the same user's direct read of
   *    that record — the donor answers NOT_FOUND for an invisible one and the
   *    caller gets no name. Never widen a user read to `mode:'all'`.
   */
  private meta(projectId: string, scope?: VisibilityScope): Metadata {
    const m = new Metadata();
    if (this.apiKey) m.set(GW_METADATA.SERVICE_API_KEY, this.apiKey);
    m.set(GW_METADATA.REQUEST_ID, newEntityId());
    m.set(GW_METADATA.TRACE_ID, newEntityId());
    m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
    m.set(GW_METADATA.ACTOR_TYPE, 'service');
    m.set(GW_METADATA.PROJECT_ID, projectId);
    // mode:'all' scope — donors fail-closed (deny-all) without a resolved scope.
    m.set(GW_METADATA.VISIBILITY_SCOPE, scope ? serializeVisibilityScope(scope) : SERVICE_SCOPE);
    return m;
  }

  /** True when the RPC rejection is an explicit gRPC NOT_FOUND. */
  private isNotFound(err: unknown): boolean {
    return (err as { code?: number } | null)?.code === grpcStatus.NOT_FOUND;
  }

  private displayName(r: {
    first_name?: string;
    last_name?: string;
    middle_name?: string;
  }): string {
    return [r.first_name, r.middle_name, r.last_name]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** Read current contact requisites (name/phone/email). Never throws. */
  async readContact(projectId: string, id: string, scope?: VisibilityScope): Promise<SourceRead> {
    if (!projectId || !id) return { state: 'unknown', fields: {} };
    try {
      const r = await firstValueFrom(
        this.contact
          .getContact({ project_id: projectId, id }, this.meta(projectId, scope))
          .pipe(timeout(READ_TIMEOUT_MS)),
      );
      return {
        state: 'present',
        fields: {
          name: this.displayName(r),
          phone: (r.phone ?? '').trim(),
          email: (r.email ?? '').trim(),
        },
      };
    } catch (err) {
      if (this.isNotFound(err)) return { state: 'deleted', fields: {} };
      this.logger.warn(`readContact ${id} failed: ${String(err)}`);
      return { state: 'unknown', fields: {} };
    }
  }

  /** Read current company requisites (name/inn/kpp). Never throws. */
  async readCompany(projectId: string, id: string, scope?: VisibilityScope): Promise<SourceRead> {
    if (!projectId || !id) return { state: 'unknown', fields: {} };
    try {
      const r = await firstValueFrom(
        this.company
          .getCompany({ project_id: projectId, id }, this.meta(projectId, scope))
          .pipe(timeout(READ_TIMEOUT_MS)),
      );
      return {
        state: 'present',
        fields: {
          name: (r.name ?? '').trim(),
          inn: (r.inn ?? '').trim(),
          kpp: (r.kpp ?? '').trim(),
        },
      };
    } catch (err) {
      if (this.isNotFound(err)) return { state: 'deleted', fields: {} };
      this.logger.warn(`readCompany ${id} failed: ${String(err)}`);
      return { state: 'unknown', fields: {} };
    }
  }

  /**
   * Current name of the linked deal — for the `deal.name` document variable
   * (TODO-207). Unlike contact/company the deal has no snapshot in the order, so
   * the name can only come from a live read.
   *
   * Fail-soft by design: deleted / invisible / unreachable donor all yield `''`
   * (an unnamed variable), never an exception — a neighbouring domain must not be
   * able to block document generation.
   */
  async readDealName(projectId: string, id: string, scope?: VisibilityScope): Promise<string> {
    if (!projectId || !id) return '';
    try {
      const r = await firstValueFrom(
        this.pipe
          .getDeal({ project_id: projectId, id }, this.meta(projectId, scope))
          .pipe(timeout(READ_TIMEOUT_MS)),
      );
      return (r.name ?? '').trim();
    } catch (err) {
      if (!this.isNotFound(err)) this.logger.warn(`readDealName ${id} failed: ${String(err)}`);
      return '';
    }
  }

  /**
   * Full product read for order create: sale-type link, catalog snapshot fields,
   * and scalar `prefill` (FR-PRODUCTS-170/180). `null` when the product is gone.
   */
  async readProductForOrder(
    projectId: string,
    productId: string,
    opts?: { failSoft?: boolean },
  ): Promise<ProductForOrder | null> {
    if (!projectId || !productId) return null;
    const failSoft = opts?.failSoft !== false;
    try {
      const r = await firstValueFrom(
        this.product
          .getProduct({ project_id: projectId, id: productId }, this.meta(projectId))
          .pipe(timeout(READ_TIMEOUT_MS)),
      );
      const price = Number(r.effective_price ?? r.price ?? 0);
      return {
        orderTypeId: (r.order_type_id ?? '').trim(),
        dangling: Boolean(r.order_type_dangling),
        name: String(r.name ?? '').trim(),
        price: Number.isFinite(price) ? price : 0,
        currency: String(r.currency ?? '').trim(),
        unit: String(r.unit ?? '').trim(),
        category: String(r.category ?? '').trim(),
        prefill: prefillFromStruct(r.prefill),
      };
    } catch (err) {
      if (this.isNotFound(err)) return null;
      if (failSoft) {
        this.logger.warn(`readProductForOrder ${productId} failed (fail-soft): ${String(err)}`);
        return null;
      }
      throw err;
    }
  }

  async readProductSaleType(
    projectId: string,
    productId: string,
    opts?: { failSoft?: boolean },
  ): Promise<{ orderTypeId: string; dangling: boolean } | null> {
    const product = await this.readProductForOrder(projectId, productId, opts);
    if (!product) return null;
    return { orderTypeId: product.orderTypeId, dangling: product.dangling };
  }
}
