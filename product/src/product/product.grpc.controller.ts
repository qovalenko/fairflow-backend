import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import {
  RequireModule,
  RequireRoles,
  readIdempotencyKey,
  readVisibilityScope,
  readAccessPredicate,
  readUserId,
  resolveProjectId,
} from '@fairflow/shared';
import { ProductService } from './product.service';
import { UsageService } from '../usage/usage.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { prefillFromStruct } from './prefill-struct';

/**
 * Effective project id with defense-in-depth (S1 / IMPLEMENTATION-DEBT Д-5): trusted
 * x-project-id metadata wins over the body; a conflicting body projectId is rejected.
 * Metadata absent (s2s/internal) → body value (AS-IS fallback).
 */
function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

@Controller()
@RequireModule('products')
export class ProductGrpcController {
  constructor(
    private readonly product: ProductService,
    private readonly usageSvc: UsageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @GrpcMethod('ProductGrpc', 'ListProducts')
  list(
    d: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      category?: string;
      status?: string;
      sort?: string;
    },
    metadata?: Metadata,
  ) {
    return this.product.list(pid(d, metadata), d.page_index ?? 0, d.page_size ?? 25, {
      query: d.query,
      category: d.category,
      statusFilter: d.status,
      sort: d.sort,
      scope: readVisibilityScope(metadata),
      access: readAccessPredicate(metadata),
    });
  }

  @GrpcMethod('ProductGrpc', 'GetProduct')
  get(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.product.get(
      pid(d, metadata),
      d.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('ProductGrpc', 'CreateProduct')
  create(
    d: {
      project_id?: string;
      projectId?: string;
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
      prefill?: unknown;
      owner_department_id?: string;
      ownerDepartmentId?: string;
    },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    // GAP-PRODUCTS-160: `prefill` arrives as a decoded proto Struct
    // (`{ fields: { k: { stringValue } } }`), not as the plain map the service expects.
    return this.idempotency.withIdempotency(
      projectId,
      readIdempotencyKey(metadata),
      'create',
      () =>
        this.product.create(
          projectId,
          { ...d, prefill: prefillFromStruct(d.prefill) },
          readUserId(metadata),
        ),
      (row) => String((row as { id?: string }).id ?? ''),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('ProductGrpc', 'UpdateProduct')
  update(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
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
      prefill?: unknown;
    },
    metadata?: Metadata,
  ) {
    // GAP-PRODUCTS-160: same Struct decode as on create. `prefill` stays `undefined`
    // when the caller omitted it, so `update` keeps its "field not supplied" semantics.
    return this.product.update(
      pid(d, metadata),
      d.id,
      { ...d, prefill: prefillFromStruct(d.prefill) },
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('ProductGrpc', 'ArchiveProduct')
  archive(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.product.archive(
      pid(d, metadata),
      d.id,
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('ProductGrpc', 'RestoreProduct')
  restore(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.product.restore(
      pid(d, metadata),
      d.id,
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @RequireRoles('admin')
  @GrpcMethod('ProductGrpc', 'DeleteProduct')
  delete(
    d: { project_id?: string; projectId?: string; id: string; force?: boolean },
    metadata?: Metadata,
  ) {
    return this.product.delete(
      pid(d, metadata),
      d.id,
      d.force === true,
      readUserId(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ProductGrpc', 'GetProductUsage')
  usage(
    d: { project_id?: string; projectId?: string; id: string; department_id?: string },
    metadata?: Metadata,
  ) {
    return this.product.usage(
      pid(d, metadata),
      d.id,
      d.department_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('ProductGrpc', 'ListCategories')
  listCategories(d: { project_id?: string; projectId?: string }, metadata?: Metadata) {
    return this.product.listCategories(
      pid(d, metadata),
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  /**
   * Reconciliation (contract §3.10): recompute counters from the cross-domain
   * count RPCs. projectId from metadata (S7); empty id → reconcile every product
   * of the project (backfill). Returns how many products were recounted.
   */
  @GrpcMethod('ProductGrpc', 'RecountProductUsage')
  async recountUsage(
    d: { project_id?: string; projectId?: string; id?: string },
    metadata?: Metadata,
  ) {
    // skipped — продукты с недоступным источником (счётчики не затёрты нулями,
    // TODO-229): вызывающий видит, что сверка неполная, и повторяет её позже.
    const { recounted, skipped } = await this.usageSvc.recount(pid(d, metadata), d.id || undefined);
    return { recounted, skipped };
  }
}
