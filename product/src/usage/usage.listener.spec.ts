/**
 * TODO-233 / TODO-446 — the product usage-listener must consume the facts that
 * orders REALLY publishes:
 *
 *  - `crm.order.cancelled` (carries productId) decrements `ordersCount`; the old
 *    `crm.order.deleted` binding was a phantom key nobody emits, so the counter
 *    could only grow;
 *  - `crm.order_type.deleted` raises `orderTypeDangling`, `crm.order_type.restored`
 *    lowers it — the flag the catalog badge / "reassign type" banner render.
 *
 * The listener is driven through the real `consume` contract: the test captures
 * the routing-keys it binds and the handler it registers, then feeds envelopes.
 */
import { UsageListener } from './usage.listener';

type Rec = Record<string, unknown>;
type Handler = (payload: Rec, routingKey: string) => Promise<void>;

function makeListener() {
  let handler: Handler = async () => undefined;
  let boundKeys: string[] = [];
  let queue = '';
  const rabbit = {
    consume: jest.fn(async (q: string, keys: string[], h: Handler) => {
      queue = q;
      boundKeys = keys;
      handler = h;
    }),
  };
  const product = {
    applyDealLink: jest.fn(async () => undefined),
    applyDealActiveChange: jest.fn(async (..._args: unknown[]) => undefined),
    applyOrderLink: jest.fn(async () => undefined),
    applyOrderTypeDangling: jest.fn(async () => 1),
  };
  const listener = new UsageListener(rabbit as never, product as never);
  return {
    listener,
    product,
    keys: () => boundKeys,
    queue: () => queue,
    fire: (rk: string, env: Rec) => handler(env, rk),
  };
}

const env = (projectId: string, payload: Rec): Rec => ({
  projectId,
  messageId: `m-${Math.random()}`,
  payload,
});

describe('product UsageListener bindings', () => {
  it('binds the keys orders really emits — cancelled + order_type lifecycle, no phantom crm.order.deleted', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    expect(t.keys().sort()).toEqual(
      [
        'crm.deal.product_linked',
        'crm.deal.product_unlinked',
        'crm.deal.won',
        'crm.deal.lost',
        'crm.deal.reopened',
        'crm.order.created',
        'crm.order.cancelled',
        'crm.order_type.deleted',
        'crm.order_type.restored',
      ].sort(),
    );
    // The dead key must be gone, not merely joined by the live one (double
    // decrement once a hard delete lands).
    expect(t.keys()).not.toContain('crm.order.deleted');
    expect(t.queue()).toContain('product.usage');
  });
});

describe('product UsageListener — order counter facts (TODO-446)', () => {
  it('crm.order.cancelled decrements ordersCount for the product named in the envelope', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.order.cancelled', env('p1', { orderId: 'o1', productId: 'prod-1' }));
    expect(t.product.applyOrderLink).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      -1,
      expect.any(String),
      'crm.order.cancelled',
    );
  });

  it('crm.order.created still increments; a cancel without productId is a no-op', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.order.created', env('p1', { orderId: 'o1', productId: 'prod-1' }));
    expect(t.product.applyOrderLink).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      1,
      expect.any(String),
      'crm.order.created',
    );
    t.product.applyOrderLink.mockClear();
    await t.fire('crm.order.cancelled', env('p1', { orderId: 'o2' }));
    expect(t.product.applyOrderLink).not.toHaveBeenCalled();
  });
});

describe('product UsageListener — dangling order-type flag (TODO-233)', () => {
  it('crm.order_type.deleted raises the flag, crm.order_type.restored lowers it', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.order_type.deleted', env('p1', { orderTypeId: 'ot-1' }));
    expect(t.product.applyOrderTypeDangling).toHaveBeenCalledWith('p1', 'ot-1', true);
    await t.fire('crm.order_type.restored', env('p1', { orderTypeId: 'ot-1', restored: true }));
    expect(t.product.applyOrderTypeDangling).toHaveBeenLastCalledWith('p1', 'ot-1', false);
  });

  it('projectId comes from the envelope only — no projectId / no orderTypeId → skipped', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.order_type.deleted', { payload: { orderTypeId: 'ot-1' } });
    await t.fire('crm.order_type.deleted', env('p1', {}));
    expect(t.product.applyOrderTypeDangling).not.toHaveBeenCalled();
  });

  it('an unknown key is acked and dropped, never mapped onto a counter', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.order.updated', env('p1', { orderId: 'o1', productId: 'prod-1' }));
    expect(t.product.applyOrderLink).not.toHaveBeenCalled();
    expect(t.product.applyDealActiveChange).not.toHaveBeenCalled();
    expect(t.product.applyOrderTypeDangling).not.toHaveBeenCalled();
  });
});

describe('product UsageListener — activeDealsCount on deal lifecycle (FR-PRODUCTS-210)', () => {
  it('crm.deal.won/lost decrement activeDealsCount; crm.deal.reopened increments', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.deal.won', env('p1', { dealId: 'd1', productId: 'prod-1' }));
    expect(t.product.applyDealActiveChange).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      -1,
      expect.any(String),
      'crm.deal.won',
    );
    t.product.applyDealActiveChange.mockClear();
    await t.fire('crm.deal.lost', env('p1', { dealId: 'd2', productId: 'prod-2' }));
    expect(t.product.applyDealActiveChange).toHaveBeenCalledWith(
      'p1',
      'prod-2',
      -1,
      expect.any(String),
      'crm.deal.lost',
    );
    t.product.applyDealActiveChange.mockClear();
    await t.fire('crm.deal.reopened', env('p1', { dealId: 'd1', productId: 'prod-1' }));
    expect(t.product.applyDealActiveChange).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      1,
      expect.any(String),
      'crm.deal.reopened',
    );
  });

  it('re-lost after reopen is a fresh fact: lost dedups by messageId, not the stable business key', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    // pipe emits `idempotencyKey: deal.lost:<dealId>` — the SAME key for a deal that
    // is lost, reopened and lost again. Dedup must therefore key off the per-emit
    // messageId, otherwise the second decrement is dropped (permanent +1 drift).
    const lostEnv = (messageId: string): Rec => ({
      projectId: 'p1',
      messageId,
      idempotencyKey: 'deal.lost:d1',
      payload: { dealId: 'd1', productId: 'prod-1' },
    });
    await t.fire('crm.deal.lost', lostEnv('m-lost-1'));
    await t.fire('crm.deal.lost', lostEnv('m-lost-2'));
    const dedupKeys = t.product.applyDealActiveChange.mock.calls.map((c) => c[3]);
    expect(dedupKeys).toEqual(['m-lost-1', 'm-lost-2']);
  });

  it('won keeps the versioned business key (`<dealId>:<wonVersion>`) as its dedup', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.deal.won', {
      projectId: 'p1',
      messageId: 'm-won-1',
      idempotencyKey: 'd1:2',
      payload: { dealId: 'd1', productId: 'prod-1' },
    });
    expect(t.product.applyDealActiveChange).toHaveBeenCalledWith(
      'p1',
      'prod-1',
      -1,
      'd1:2',
      'crm.deal.won',
    );
  });

  it('won/lost/reopened without productId are no-ops', async () => {
    const t = makeListener();
    await t.listener.onModuleInit();
    await t.fire('crm.deal.won', env('p1', { dealId: 'd1' }));
    await t.fire('crm.deal.lost', env('p1', { dealId: 'd2' }));
    await t.fire('crm.deal.reopened', env('p1', { dealId: 'd3' }));
    expect(t.product.applyDealActiveChange).not.toHaveBeenCalled();
  });
});
