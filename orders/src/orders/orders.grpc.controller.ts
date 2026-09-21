import {
  RequireModule,
  RequireRoles,
  readAccessPredicate,
  readEnabledModules,
  readVisibilityScope,
  readUserId,
  readRoles,
  readIdempotencyKey,
  resolveProjectId,
  resolveDocumentVariablesScope,
} from '@fairflow/shared';
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { OrdersService, type OrdersActor } from './orders.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * Effective project id with defense-in-depth (IMPLEMENTATION-DEBT Д-5): trusted
 * x-project-id metadata wins over the body; a conflicting body projectId is
 * rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
 */
function projectId(data: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, data.project_id ?? data.projectId);
}

@Controller()
@RequireModule('orders')
export class OrdersGrpcController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Build the trusted caller context — identity, roles, scope and ABAC come from gRPC metadata only. */
  private actor(
    data: { project_id?: string; projectId?: string },
    metadata?: Metadata,
  ): OrdersActor {
    return {
      projectId: projectId(data, metadata),
      // Identity comes ONLY from the trusted gateway metadata (`x-user-id`). The
      // former body fallback (`data.user_id`) was the same privilege-escalation
      // shape as the roles one: `actor.userId` is the owner branch of
      // `requireOwnerOrManager` (`assigneeId === actor.userId`), so a caller with
      // no `x-user-id` could name itself the owner of an arbitrary order through
      // the payload and pass AcceptDrift / RetryFinalAction. The gateway never
      // puts `user_id` in the body — the fallback was dead code (TODO-289).
      userId: readUserId(metadata) || undefined,
      // Roles come ONLY from the trusted gateway metadata (`x-roles`). The former
      // body fallback let a caller grant itself manager privileges through the
      // request payload — `requireManager`/`requireOwnerOrManager` decide on this
      // very list (TODO-289). The gateway never put roles in the body, so the
      // fallback was dead code with a live privilege-escalation shape.
      roles: readRoles(metadata),
      scope: readVisibilityScope(metadata),
      // Conditional ABAC rules of the project's module policy, compiled by the
      // gateway PDP. Before TODO-112 orders read this header nowhere, so every
      // conditional rule on sales was silently a no-op.
      access: readAccessPredicate(metadata),
    };
  }

  /**
   * Cross-domain read-only count for the product delete-guard / reconciliation
   * (product.md §3.10). Service-to-service; projectId from metadata (S7) — never
   * counts another project's orders. No visibility scope: the caller is the
   * product domain reconciling its own catalog counters.
   */
  @GrpcMethod('OrdersGrpc', 'CountOrdersByProduct')
  countOrdersByProduct(
    data: { project_id?: string; projectId?: string; product_id?: string },
    metadata?: Metadata,
  ) {
    return this.orders.countOrdersByProduct(
      projectId(data, metadata),
      String(data.product_id ?? ''),
    );
  }

  // ── Order types ─────────────────────────────────────────────────────────

  @GrpcMethod('OrdersGrpc', 'ListOrderTypes')
  listTypes(
    data: { project_id?: string; projectId?: string; include_deleted?: boolean },
    metadata?: Metadata,
  ) {
    return this.orders.listOrderTypes(projectId(data, metadata), !!data.include_deleted);
  }

  @GrpcMethod('OrdersGrpc', 'GetOrderType')
  getType(
    data: { project_id?: string; projectId?: string; id: string; version?: number },
    metadata?: Metadata,
  ) {
    return this.orders.getOrderType(projectId(data, metadata), data.id, data.version);
  }

  @GrpcMethod('OrdersGrpc', 'CreateOrderType')
  createType(
    data: { project_id?: string; projectId?: string; spec: Record<string, unknown> },
    metadata?: Metadata,
  ) {
    return this.orders.createOrderType(
      projectId(data, metadata),
      data.spec ?? {},
      readUserId(metadata) || undefined,
    );
  }

  @GrpcMethod('OrdersGrpc', 'UpdateOrderType')
  updateType(
    data: { project_id?: string; projectId?: string; id: string; spec: Record<string, unknown> },
    metadata?: Metadata,
  ) {
    return this.orders.updateOrderType(
      projectId(data, metadata),
      data.id,
      data.spec ?? {},
      readUserId(metadata) || undefined,
    );
  }

  @GrpcMethod('OrdersGrpc', 'DeleteOrderType')
  deleteType(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.orders.deleteOrderType(projectId(data, metadata), data.id);
  }

  @GrpcMethod('OrdersGrpc', 'RestoreOrderType')
  restoreType(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.orders.restoreOrderType(projectId(data, metadata), data.id);
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  @GrpcMethod('OrdersGrpc', 'ListOrders')
  listOrders(
    data: {
      project_id?: string;
      projectId?: string;
      page_index?: number;
      page_size?: number;
      query?: string;
      deal_id?: string;
      type_id?: string;
      status?: string;
      stage_id?: string;
      stale_days?: number;
      contact_id?: string;
      company_id?: string;
    },
    metadata?: Metadata,
  ) {
    return this.orders.listOrders(
      projectId(data, metadata),
      data.page_index ?? 0,
      data.page_size ?? 25,
      {
        query: data.query,
        dealId: data.deal_id,
        typeId: data.type_id,
        statusFilter: data.status,
        stageId: data.stage_id,
        staleDays: data.stale_days,
        contactId: data.contact_id,
        companyId: data.company_id,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'GetOrdersKanban')
  kanban(data: { project_id?: string; projectId?: string; type_id?: string }, metadata?: Metadata) {
    return this.orders.getKanban(
      projectId(data, metadata),
      data.type_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'GetOrder')
  get(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.orders.getOrder(
      projectId(data, metadata),
      data.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'ResolveDocumentVariables')
  resolveDocumentVariables(
    data: { project_id?: string; projectId?: string; record_id?: string; recordId?: string },
    metadata?: Metadata,
  ) {
    const { projectId: pid, recordId } = resolveDocumentVariablesScope(metadata, data);
    // Visibility scope ONLY — deliberately no `x-access-predicate` here, unlike
    // every other read on this controller (matches the reference donor
    // contact.grpc.controller.ts ResolveDocumentVariables).
    // The gateway compiles the predicate strictly for the ROUTE's data-subject
    // (project-access.guard.ts → compileAccessPredicate(subject, action)), and the
    // only caller of this RPC is `POST documents/generate`, whose subject is
    // `documents`. So the predicate arriving here is compiled over DOCUMENT
    // fields; AND-ing it into the crm_orders filter is a category error — e.g. a
    // conditional rule `record.ownerId == user.id` (documents' owner attribute;
    // an order names it `assigneeId`) matches no order at all and would silently
    // generate the document with an empty variable map. Narrowing-only, so it is
    // not a leak, but it is the wrong predicate. The order read stays gated by
    // projectId + the caller's visibility scope inside `loadVisible`.
    return this.orders.resolveDocumentVariables(pid, recordId, readVisibilityScope(metadata));
  }

  @GrpcMethod('OrdersGrpc', 'RequestOrderDocument')
  requestOrderDocument(
    data: {
      project_id?: string;
      projectId?: string;
      order_id?: string;
      orderId?: string;
      template_id?: string;
      templateId?: string;
      accept_drift?: boolean;
      acceptDrift?: boolean;
    },
    metadata?: Metadata,
  ) {
    const pid = projectId(data, metadata);
    const orderId = String(data.order_id ?? data.orderId ?? '');
    const templateId = String(data.template_id ?? data.templateId ?? '');
    const acceptDrift = !!(data.accept_drift ?? data.acceptDrift);
    return this.orders.requestOrderDocument(
      pid,
      orderId,
      templateId,
      acceptDrift,
      readVisibilityScope(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'CreateOrdersBatch')
  createOrdersBatch(data: Record<string, unknown>, metadata?: Metadata) {
    const actor = this.actor(data, metadata);
    return this.orders.createOrdersBatch(data, actor);
  }

  @GrpcMethod('OrdersGrpc', 'CreateOrder')
  create(data: Record<string, unknown>, metadata?: Metadata) {
    const actor = this.actor(data, metadata);
    // P2.d: dedup retried creates on `Idempotency-Key` — replay the first response.
    // A retried create must NOT burn a new order number / write a second order.
    return this.idempotency.withIdempotency(
      actor.projectId,
      readIdempotencyKey(metadata),
      'create',
      () => this.orders.createOrder(data, actor),
    );
  }

  @GrpcMethod('OrdersGrpc', 'UpdateOrder')
  update(
    data: { project_id?: string; projectId?: string; id: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.orders.updateOrder(
      projectId(data, metadata),
      data.id,
      data,
      this.actor(data, metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'MoveOrderToStage')
  move(
    data: {
      project_id?: string;
      projectId?: string;
      order_id: string;
      stage_id: string;
      accept_drift?: boolean;
    },
    metadata?: Metadata,
  ) {
    return this.orders.moveOrder(
      projectId(data, metadata),
      data.order_id,
      data.stage_id,
      !!data.accept_drift,
      readVisibilityScope(metadata),
      // Gateway-resolved effective module set: a terminal move with a final
      // action requires the automation executor (FR-ORDERS-270); absent
      // metadata (s2s) → undefined → fail-open, matching ModuleGuard.
      readEnabledModules(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'CancelOrder')
  cancel(
    data: { project_id?: string; projectId?: string; id: string; reason?: string },
    metadata?: Metadata,
  ) {
    return this.orders.cancelOrder(
      projectId(data, metadata),
      data.id,
      data.reason,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'CheckDrift')
  drift(data: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.orders.checkDrift(
      projectId(data, metadata),
      data.id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'AcceptDrift')
  acceptDrift(
    data: { project_id?: string; projectId?: string; id: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.orders.acceptDrift(projectId(data, metadata), data.id, this.actor(data, metadata));
  }

  @RequireRoles('manager')
  @GrpcMethod('OrdersGrpc', 'RetryFinalAction')
  retry(
    data: { project_id?: string; projectId?: string; id: string } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.orders.retryFinalAction(
      projectId(data, metadata),
      data.id,
      this.actor(data, metadata),
    );
  }

  @RequireRoles('manager')
  @GrpcMethod('OrdersGrpc', 'ReassignOrders')
  reassign(
    data: {
      project_id?: string;
      projectId?: string;
      from_assignee_id: string;
      to_assignee_id: string;
      type_id?: string;
      status?: string;
      stage_id?: string;
    } & Record<string, unknown>,
    metadata?: Metadata,
  ) {
    return this.orders.reassignOrders(
      projectId(data, metadata),
      data.from_assignee_id,
      data.to_assignee_id,
      { typeId: data.type_id, status: data.status, stageId: data.stage_id },
      this.actor(data, metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'GetOrdersSummaryForDeal')
  dealSummary(
    data: { project_id?: string; projectId?: string; deal_id: string },
    metadata?: Metadata,
  ) {
    return this.orders.getOrdersSummaryForDeal(
      projectId(data, metadata),
      data.deal_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('OrdersGrpc', 'ProvisionDefaults')
  provisionDefaults(
    data: {
      project_id?: string;
      projectId?: string;
      template_id?: string;
      templateId?: string;
    },
    metadata?: Metadata,
  ) {
    return this.orders.provisionDefaults(
      projectId(data, metadata),
      data.template_id ?? data.templateId,
    );
  }

  @GrpcMethod('OrdersGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(d: { project_id?: string; user_id?: string }, metadata?: Metadata) {
    const pid = projectId(d, metadata);
    const count = await this.orders.countOwnedRecords(pid, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('OrdersGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const pid = projectId(d, metadata);
    const r = await this.orders.reassignOwnedRecords(
      pid,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }
}
