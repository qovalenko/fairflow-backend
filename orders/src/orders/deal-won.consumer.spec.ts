import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { DealWonConsumer } from './deal-won.consumer';

/**
 * Unit matrix for the deal-won auto-sale consumer (BX-FLOW-2): a sale is created
 * only when the sale-type is known; every other branch ACKs and skips; infra
 * faults re-throw.
 */
type ProductRow = { order_type_id?: string; order_type_dangling?: boolean };

function makeConsumer(opts: {
  product?: ProductRow | 'not_found' | 'down';
  type?: Record<string, unknown> | null;
  createOrder?: () => Promise<{ id: string; number: string }>;
}) {
  const createCalls: { data: Record<string, unknown> }[] = [];
  const sourceReader = {
    readProductSaleType: async (_p: string, _id: string, readOpts?: { failSoft?: boolean }) => {
      if (opts.product === 'not_found') return null;
      if (opts.product === 'down') {
        if (readOpts?.failSoft === false) throw new Error('donor down');
        return null;
      }
      const row = (opts.product ?? {}) as ProductRow;
      return {
        orderTypeId: (row.order_type_id ?? '').trim(),
        dangling: Boolean(row.order_type_dangling),
      };
    },
  };
  const mongo = {
    orderTypes: () => ({ findOne: async () => opts.type ?? null }),
  } as never;
  const idempotency = {
    withIdempotency: (
      _p: string,
      _k: string | undefined,
      _op: string,
      exec: () => Promise<unknown>,
    ) => exec(),
  } as never;
  const orders = {
    createOrder: async (data: Record<string, unknown>) => {
      createCalls.push({ data });
      return (opts.createOrder ?? (async () => ({ id: 'o1', number: 'ORD-00001' })))();
    },
  } as never;
  const c = new DealWonConsumer(
    mongo,
    { consume: jest.fn() } as never,
    idempotency,
    orders,
    sourceReader as never,
  );
  return { c, createCalls };
}

const wonEnv = (payload: Record<string, unknown>, projectId = 'p1', idem = 'd1:1') =>
  ({ projectId, idempotencyKey: idem, payload }) as Record<string, unknown>;

describe('orders DealWonConsumer', () => {
  it('creates a sale of the product sale-type, prefilled from the payload', async () => {
    const { c, createCalls } = makeConsumer({
      product: { order_type_id: 'ot1', order_type_dangling: false },
      type: { id: 'ot1' },
    });
    const out = await c.handle(
      wonEnv({
        dealId: 'd1',
        productId: 'pr1',
        contactId: 'c1',
        companyId: 'co1',
        assigneeId: 'u9',
        wonVersion: 1,
      }),
    );
    expect(out).toBe('created');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].data).toMatchObject({
      order_type_id: 'ot1',
      deal_id: 'd1',
      product_id: 'pr1',
      contact_id: 'c1',
      company_id: 'co1',
      assignee_id: 'u9',
    });
  });

  it('skips (no create) when the deal has no product', async () => {
    const { c, createCalls } = makeConsumer({ type: { id: 'ot1' } });
    expect(await c.handle(wonEnv({ dealId: 'd1', wonVersion: 1 }))).toBe('skipped');
    expect(createCalls).toHaveLength(0);
  });

  it('skips when the product sale-type is dangling', async () => {
    const { c, createCalls } = makeConsumer({
      product: { order_type_id: 'ot1', order_type_dangling: true },
      type: { id: 'ot1' },
    });
    expect(await c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 }))).toBe(
      'skipped',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('skips when the sale-type is missing/deleted', async () => {
    const { c } = makeConsumer({ product: { order_type_id: 'ot1' }, type: null });
    expect(await c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 }))).toBe(
      'skipped',
    );
  });

  it('skips when the sale-type opted out (autoCreateOnWon=false)', async () => {
    const { c, createCalls } = makeConsumer({
      product: { order_type_id: 'ot1' },
      type: { id: 'ot1', autoCreateOnWon: false },
    });
    expect(await c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 }))).toBe(
      'skipped',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('poison message (no projectId/dealId) → dead_letter', async () => {
    const { c } = makeConsumer({});
    expect(await c.handle(wonEnv({ productId: 'pr1' }, ''))).toBe('dead_letter');
  });

  it('skips when the product was deleted before delivery (NOT_FOUND)', async () => {
    const { c } = makeConsumer({ product: 'not_found', type: { id: 'ot1' } });
    expect(await c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 }))).toBe(
      'skipped',
    );
  });

  it('re-throws when the product donor is down (transient → retry ladder)', async () => {
    const { c } = makeConsumer({ product: 'down', type: { id: 'ot1' } });
    await expect(
      c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 })),
    ).rejects.toThrow('donor down');
  });

  it('skips on a business rejection from createOrder (required fields) — no retry-loop', async () => {
    const { c } = makeConsumer({
      product: { order_type_id: 'ot1' },
      type: { id: 'ot1' },
      createOrder: () =>
        Promise.reject(new RpcException({ code: status.INVALID_ARGUMENT, message: 'fields' })),
    });
    expect(await c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 }))).toBe(
      'skipped',
    );
  });

  it('re-throws an infra fault from createOrder (transient → retry ladder)', async () => {
    const { c } = makeConsumer({
      product: { order_type_id: 'ot1' },
      type: { id: 'ot1' },
      createOrder: () => Promise.reject(new Error('mongo down')),
    });
    await expect(
      c.handle(wonEnv({ dealId: 'd1', productId: 'pr1', wonVersion: 1 })),
    ).rejects.toThrow('mongo down');
  });
});
