/**
 * TODO-233 / FR-PRODUCTS-130/140/320 — `orderTypeDangling` must actually become
 * `true` when the order type behind the product is deleted, and fall back to
 * `false` when the type is restored, strictly inside the projectId of the event.
 *
 * The real `ProductService` runs against an in-memory `crm_products` collection
 * whose matcher understands the `$ne` fragment the method relies on for its
 * idempotency, plus a fake outbox that captures the emitted intents.
 */
import { ObjectId } from 'mongodb';
import { ProductService } from './product.service';

type Rec = Record<string, unknown>;

function matches(doc: Rec, filter: Rec): boolean {
  for (const [field, cond] of Object.entries(filter)) {
    const value = doc[field];
    if (cond !== null && typeof cond === 'object' && '$ne' in (cond as Rec)) {
      // `undefined` (legacy document without the field) counts as `false`.
      const current = field === 'orderTypeDangling' ? Boolean(value) : value;
      if (current === (cond as Rec).$ne) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function makeService(docs: Rec[]) {
  const updates: { filter: Rec; update: Rec }[] = [];
  const products = {
    find(filter: Rec) {
      return { toArray: async () => docs.filter((d) => matches(d, filter)) };
    },
    async updateMany(filter: Rec, update: Rec) {
      updates.push({ filter, update });
      const set = (update.$set ?? {}) as Rec;
      let n = 0;
      for (const d of docs) {
        if (!matches(d, filter)) continue;
        Object.assign(d, set);
        n += 1;
      }
      return { modifiedCount: n };
    },
  };
  const intents: Rec[] = [];
  const outbox = {
    withOutbox: async (work: (s: undefined) => Promise<{ result: unknown; intents: Rec[] }>) => {
      const out = await work(undefined);
      intents.push(...out.intents);
      return out.result;
    },
  };
  const svc = new ProductService({ products: () => products } as never, outbox as never);
  return { svc, intents, updates };
}

const product = (
  id: ObjectId,
  projectId: string,
  orderTypeId: string,
  dangling?: boolean,
): Rec => ({
  _id: id,
  projectId,
  name: `p-${id.toString().slice(-4)}`,
  orderTypeId,
  orderTypeName: 'Поставка',
  ...(dangling === undefined ? {} : { orderTypeDangling: dangling }),
});

describe('ProductService.applyOrderTypeDangling', () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const other = new ObjectId();
  const foreign = new ObjectId();

  const fixture = () => [
    product(a, 'p1', 'ot-1', false),
    product(b, 'p1', 'ot-1'), // legacy doc without the field
    product(other, 'p1', 'ot-2', false),
    product(foreign, 'p2', 'ot-1', false), // another project — same type id
  ];

  it('raises the flag only for the products of THIS project bound to the deleted type', async () => {
    const docs = fixture();
    const { svc, intents } = makeService(docs);

    expect(await svc.applyOrderTypeDangling('p1', 'ot-1', true)).toBe(2);

    expect(docs.find((d) => d._id === a)!.orderTypeDangling).toBe(true);
    expect(docs.find((d) => d._id === b)!.orderTypeDangling).toBe(true);
    // Other type / other project untouched — x-project-id is the hard boundary.
    expect(docs.find((d) => d._id === other)!.orderTypeDangling).toBe(false);
    expect(docs.find((d) => d._id === foreign)!.orderTypeDangling).toBe(false);
    // The reference itself survives, so "reassign type" and a restore still work.
    expect(docs.find((d) => d._id === a)!.orderTypeId).toBe('ot-1');

    expect(intents.map((i) => i.type)).toEqual([
      'crm.product.order_type_dangling',
      'crm.product.order_type_dangling',
    ]);
    expect(intents[0]).toMatchObject({
      source: 'product',
      projectId: 'p1',
      subject: `product/${a.toString()}`,
      idempotencyKey: `product.order_type_dangling:${a.toString()}:ot-1:true`,
    });
    expect(intents[0].payload).toMatchObject({ orderTypeId: 'ot-1', dangling: true });
  });

  it('is idempotent: a redelivered delete changes nothing and emits nothing', async () => {
    const docs = fixture();
    const { svc, intents } = makeService(docs);
    await svc.applyOrderTypeDangling('p1', 'ot-1', true);
    intents.length = 0;

    expect(await svc.applyOrderTypeDangling('p1', 'ot-1', true)).toBe(0);
    expect(intents).toEqual([]);
  });

  it('a restore of the type lowers the flag back and signals it', async () => {
    const docs = fixture();
    const { svc, intents } = makeService(docs);
    await svc.applyOrderTypeDangling('p1', 'ot-1', true);
    intents.length = 0;

    expect(await svc.applyOrderTypeDangling('p1', 'ot-1', false)).toBe(2);
    expect(docs.find((d) => d._id === a)!.orderTypeDangling).toBe(false);
    expect(intents).toHaveLength(2);
    expect(intents[0].payload).toMatchObject({ dangling: false });
    expect(intents[0].idempotencyKey).toBe(
      `product.order_type_dangling:${a.toString()}:ot-1:false`,
    );
  });

  it('a malformed fact (no projectId / no orderTypeId) touches nothing', async () => {
    const docs = fixture();
    const { svc, intents, updates } = makeService(docs);
    expect(await svc.applyOrderTypeDangling('', 'ot-1', true)).toBe(0);
    expect(await svc.applyOrderTypeDangling('p1', '', true)).toBe(0);
    expect(updates).toEqual([]);
    expect(intents).toEqual([]);
  });
});
