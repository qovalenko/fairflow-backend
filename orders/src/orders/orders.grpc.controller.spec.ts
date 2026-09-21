import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { OrdersGrpcController } from './orders.grpc.controller';
import type { OrdersService, OrdersActor } from './orders.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * Controller-level trust boundary coverage:
 *  - TODO-289: the actor's identity and roles come ONLY from the trusted
 *    `x-user-id` / `x-roles` metadata — a body-supplied `user_id`/`roles` must not
 *    reach the owner/manager gates;
 *  - TODO-112: `x-access-predicate` (the gateway-compiled ABAC predicate) is read
 *    and forwarded on read AND mutation paths — before, orders ignored it entirely.
 */
type Call = { args: unknown[] };

function makeController() {
  const calls: Record<string, Call[]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push({ args });
      return Promise.resolve(
        name === 'countOwnedRecords' ? 3 : name === 'reassignOwnedRecords' ? { reassigned: 2 } : {},
      );
    };
  const orders = {
    acceptDrift: record('acceptDrift'),
    retryFinalAction: record('retryFinalAction'),
    reassignOrders: record('reassignOrders'),
    listOrders: record('listOrders'),
    getOrder: record('getOrder'),
    getKanban: record('getKanban'),
    moveOrder: record('moveOrder'),
    cancelOrder: record('cancelOrder'),
    checkDrift: record('checkDrift'),
    resolveDocumentVariables: record('resolveDocumentVariables'),
    countOrdersByProduct: record('countOrdersByProduct'),
    listOrderTypes: record('listOrderTypes'),
    getOrderType: record('getOrderType'),
    createOrderType: record('createOrderType'),
    updateOrderType: record('updateOrderType'),
    deleteOrderType: record('deleteOrderType'),
    restoreOrderType: record('restoreOrderType'),
    createOrdersBatch: record('createOrdersBatch'),
    createOrder: record('createOrder'),
    updateOrder: record('updateOrder'),
    requestOrderDocument: record('requestOrderDocument'),
    getOrdersSummaryForDeal: record('getOrdersSummaryForDeal'),
    provisionDefaults: record('provisionDefaults'),
    countOwnedRecords: record('countOwnedRecords'),
    reassignOwnedRecords: record('reassignOwnedRecords'),
  } as unknown as OrdersService;
  const idempotency = {
    withIdempotency: async <R>(_p: string, _k: string, _s: string, work: () => Promise<R>) =>
      work(),
  } as unknown as IdempotencyService;
  return { controller: new OrdersGrpcController(orders, idempotency), calls };
}

function meta(entries: Record<string, string>): Metadata {
  const m = new Metadata();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

/** base64(JSON) predicate, exactly as the gateway serializes it. */
function predicate(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('OrdersGrpcController actor roles (TODO-289)', () => {
  it('ignores a body-supplied `roles` when metadata carries none', async () => {
    const { controller, calls } = makeController();
    await controller.acceptDrift(
      { id: 'o1', roles: 'manager,owner' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    const actor = calls.acceptDrift[0].args[2] as OrdersActor;
    expect(actor.roles).toEqual([]);
  });

  it('takes the roles from the trusted x-roles metadata', async () => {
    const { controller, calls } = makeController();
    await controller.retry(
      { id: 'o1', roles: 'admin' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.ROLES]: 'manager' }),
    );
    const actor = calls.retryFinalAction[0].args[2] as OrdersActor;
    expect(actor.roles).toEqual(['manager']);
  });
});

describe('OrdersGrpcController actor identity (TODO-289)', () => {
  // `requireOwnerOrManager` passes when `assigneeId === actor.userId`. If the body
  // could seed `actor.userId`, a caller without `x-user-id` would name itself the
  // owner of any order and walk through AcceptDrift / RetryFinalAction.
  it('ignores a body-supplied `user_id` when metadata carries no x-user-id', async () => {
    const { controller, calls } = makeController();
    await controller.acceptDrift(
      { id: 'o1', user_id: 'victim-owner' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    const actor = calls.acceptDrift[0].args[2] as OrdersActor;
    expect(actor.userId).toBeUndefined();
  });

  it('takes the identity from the trusted x-user-id metadata, body cannot override', async () => {
    const { controller, calls } = makeController();
    await controller.retry(
      { id: 'o1', user_id: 'victim-owner' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u-real' }),
    );
    const actor = calls.retryFinalAction[0].args[2] as OrdersActor;
    expect(actor.userId).toBe('u-real');
  });

  it('reassign: the body `user_id` never becomes the actor', async () => {
    const { controller, calls } = makeController();
    await controller.reassign(
      { from_assignee_id: 'a', to_assignee_id: 'b', user_id: 'spoofed' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    const actor = calls.reassignOrders[0].args[4] as OrdersActor;
    expect(actor.userId).toBeUndefined();
  });
});

describe('OrdersGrpcController access predicate (TODO-112)', () => {
  const abac = { mongo: { productId: 'pr1' }, ir: null };

  it('forwards the compiled predicate on list/get/kanban', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.ACCESS_PREDICATE]: predicate(abac),
    });
    await controller.listOrders({}, m);
    await controller.get({ id: 'o1' }, m);
    await controller.kanban({}, m);
    expect(calls.listOrders[0].args[5]).toMatchObject({
      present: true,
      mongo: { productId: 'pr1' },
    });
    expect(calls.getOrder[0].args[3]).toMatchObject({ present: true, mongo: { productId: 'pr1' } });
    expect(calls.getKanban[0].args[3]).toMatchObject({
      present: true,
      mongo: { productId: 'pr1' },
    });
  });

  it('forwards the compiled predicate on mutations (write gate = read gate)', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.ACCESS_PREDICATE]: predicate(abac),
    });
    await controller.move({ order_id: 'o1', stage_id: 's2' }, m);
    await controller.cancel({ id: 'o1' }, m);
    await controller.acceptDrift({ id: 'o1' } as never, m);
    expect(calls.moveOrder[0].args[6]).toMatchObject({ present: true });
    expect(calls.cancelOrder[0].args[4]).toMatchObject({ present: true });
    expect((calls.acceptDrift[0].args[2] as OrdersActor).access).toMatchObject({ present: true });
  });

  it('reports a corrupted predicate as malformed (domain then fails closed)', async () => {
    const { controller, calls } = makeController();
    await controller.listOrders(
      {},
      meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.ACCESS_PREDICATE]: 'not-base64-json' }),
    );
    expect(calls.listOrders[0].args[5]).toEqual({ present: true, malformed: true });
  });

  // Review BLOCKER: the gateway compiles the predicate for the ROUTE's subject, and
  // the only caller of ResolveDocumentVariables is `documents.generate:execute`. A
  // `documents`-subject predicate AND-ed into the crm_orders filter is the wrong
  // predicate (e.g. documents' `ownerId` vs an order's `assigneeId` → zero matches →
  // a document silently generated with an empty variable map). Reference donor
  // contact.grpc.controller.ts passes visibility scope only.
  it('does NOT forward the route-subject predicate into the document-variable donor', async () => {
    const { controller, calls } = makeController();
    await controller.resolveDocumentVariables(
      { record_id: 'o1' },
      meta({
        [GW_METADATA.PROJECT_ID]: 'p1',
        [GW_METADATA.ACCESS_PREDICATE]: predicate(abac),
      }),
    );
    const args = calls.resolveDocumentVariables[0].args;
    expect(args[0]).toBe('p1');
    expect(args[1]).toBe('o1');
    expect(args).toHaveLength(3); // projectId, recordId, scope — and nothing else
  });
});

describe('OrdersGrpcController RPC delegations', () => {
  it('countOrdersByProduct берёт projectId из metadata и product_id из тела', async () => {
    const { controller, calls } = makeController();
    await controller.countOrdersByProduct(
      { product_id: 'pr1' },
      meta({ [GW_METADATA.PROJECT_ID]: 'p-meta' }),
    );
    expect(calls.countOrdersByProduct[0].args).toEqual(['p-meta', 'pr1']);
  });

  it('listTypes/getType/createType/updateType/deleteType/restoreType делегируют в сервис', async () => {
    const { controller, calls } = makeController();
    const m = meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u1' });
    await controller.listTypes({ include_deleted: true }, m);
    await controller.getType({ id: 't1', version: 2 }, m);
    await controller.createType({ spec: { name: 'Sale' } }, m);
    await controller.updateType({ id: 't1', spec: { name: 'Renamed' } }, m);
    await controller.deleteType({ id: 't1' }, m);
    await controller.restoreType({ id: 't1' }, m);
    expect(calls.listOrderTypes[0].args).toEqual(['p1', true]);
    expect(calls.getOrderType[0].args).toEqual(['p1', 't1', 2]);
    expect(calls.createOrderType[0].args).toEqual(['p1', { name: 'Sale' }, 'u1']);
    expect(calls.updateOrderType[0].args).toEqual(['p1', 't1', { name: 'Renamed' }, 'u1']);
    expect(calls.deleteOrderType[0].args).toEqual(['p1', 't1']);
    expect(calls.restoreOrderType[0].args).toEqual(['p1', 't1']);
  });

  it('createOrdersBatch/create/update/requestOrderDocument/dealSummary/provisionDefaults', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.USER_ID]: 'u1',
      [GW_METADATA.IDEMPOTENCY_KEY]: 'idem-1',
    });
    await controller.createOrdersBatch({ rows: [] }, m);
    await controller.create({ name: 'O1' }, m);
    await controller.update({ id: 'o1', title: 'T' }, m);
    await controller.requestOrderDocument(
      { order_id: 'o1', template_id: 'tpl', accept_drift: true },
      m,
    );
    await controller.dealSummary({ deal_id: 'd1' }, m);
    await controller.provisionDefaults({ template_id: 'b2b' }, m);
    expect((calls.createOrdersBatch[0].args[1] as OrdersActor).projectId).toBe('p1');
    expect(calls.createOrder[0].args[0]).toEqual({ name: 'O1' });
    expect(calls.updateOrder[0].args.slice(0, 3)).toEqual([
      'p1',
      'o1',
      expect.objectContaining({ id: 'o1' }),
    ]);
    expect(calls.requestOrderDocument[0].args).toEqual(['p1', 'o1', 'tpl', true, undefined]);
    expect(calls.getOrdersSummaryForDeal[0].args[0]).toBe('p1');
    expect(calls.provisionDefaults[0].args).toEqual(['p1', 'b2b']);
  });

  it('countMemberOwnedRecords/reassignMemberOwnedRecords возвращают счётчики', async () => {
    const { controller } = makeController();
    await expect(
      controller.countMemberOwnedRecords(
        { user_id: 'u1' },
        meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
      ),
    ).resolves.toEqual({ count: 3 });
    await expect(
      controller.reassignMemberOwnedRecords(
        { from_user_id: 'a', to_user_id: 'b' },
        meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
      ),
    ).resolves.toEqual({ reassigned: 2 });
  });

  it('checkDrift делегирует scope и access predicate', async () => {
    const { controller, calls } = makeController();
    const abac = { mongo: { productId: 'pr1' }, ir: null };
    await controller.drift(
      { id: 'o1' },
      meta({
        [GW_METADATA.PROJECT_ID]: 'p1',
        [GW_METADATA.ACCESS_PREDICATE]: predicate(abac),
      }),
    );
    expect(calls.checkDrift[0].args[0]).toBe('p1');
    expect(calls.checkDrift[0].args[3]).toMatchObject({ present: true });
  });
});
