import { ObjectId } from 'mongodb';
import type { AccessPredicate, VisibilityScope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';

/**
 * TODO-112 (orders part): the gateway compiles the project's conditional ABAC
 * rules into `x-access-predicate`; the orders domain used to ignore it on every
 * path. These tests pin the three-state contract (absent / malformed / present)
 * AND that the predicate is pushed into the DB filter — never applied in memory.
 */
type AnyRec = Record<string, unknown>;

const ORDER_ID = new ObjectId();

function makeService(existing?: AnyRec) {
  const listFilters: AnyRec[] = [];
  const findOneFilters: AnyRec[] = [];
  const aggregatePipelines: AnyRec[][] = [];

  const doc: AnyRec = existing ?? {
    _id: ORDER_ID,
    projectId: 'p1',
    typeId: 't1',
    stageId: 'os1',
    assigneeId: 'u1',
    productId: 'pr1',
    status: 'ACTIVE',
    number: 'ORD-00001',
    createdAt: 1,
    updatedAt: 2,
  };

  /** Deny-all fragment recognizer: `{ _id: 000000000000000000000000 }`. */
  const isDenyAll = (f: AnyRec): boolean =>
    f._id instanceof ObjectId && f._id.toString() === '000000000000000000000000';

  const ordersColl = {
    countDocuments: async (filter: AnyRec) => {
      listFilters.push(filter);
      return 1;
    },
    find: (filter: AnyRec) => {
      listFilters.push(filter);
      const chain = {
        sort: () => chain,
        skip: () => chain,
        limit: () => chain,
        toArray: async () => [doc],
      };
      return chain;
    },
    findOne: async (filter: AnyRec) => {
      findOneFilters.push(filter);
      // Faithful enough for the deny path: a deny-all `_id` matches nothing.
      const parts = (filter.$and as AnyRec[]) ?? [filter];
      if (parts.some(isDenyAll)) return null;
      return doc;
    },
    aggregate: (pipeline: AnyRec[]) => {
      aggregatePipelines.push(pipeline);
      return { toArray: async () => [{}] };
    },
  };
  const orderTypesColl = {
    find: () => ({
      toArray: async () => [
        { id: 't1', name: 'Sale', stages: [{ id: 'os1', name: 'New', order: 0 }] },
      ],
    }),
    findOne: async () => ({
      id: 't1',
      name: 'Sale',
      stages: [{ id: 'os1', name: 'New', order: 0 }],
    }),
  };
  const mongo = {
    orders: () => ordersColl,
    orderTypes: () => orderTypesColl,
    orderTypeRevisions: () => ({ findOne: async () => null }),
  } as unknown as ConstructorParameters<typeof OrdersService>[0];
  const outbox = {} as unknown as ConstructorParameters<typeof OrdersService>[1];
  const sourceReader = {} as unknown as ConstructorParameters<typeof OrdersService>[2];

  return {
    service: new OrdersService(mongo, outbox, sourceReader, noopSpecValidator),
    listFilters,
    findOneFilters,
    aggregatePipelines,
  };
}

/**
 * A resolved `mode:'all'` scope. Visibility is a SEPARATE fail-closed gate
 * (`scope === undefined` denies by design, Д-3) — these tests isolate the ABAC
 * layer, so the visibility gate is satisfied and never masks the assertion.
 */
const SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
};

const MONGO_ACCESS: AccessPredicate = {
  present: true,
  mongo: { productId: 'pr1' },
  ir: null,
};
const MALFORMED: AccessPredicate = { present: true, malformed: true };

describe('OrdersService ABAC — list paths', () => {
  it('ANDs the compiled fragment into the DB filter (not in memory)', async () => {
    const { service, listFilters } = makeService();
    await service.listOrders('p1', 0, 25, {}, SCOPE, MONGO_ACCESS);
    expect(listFilters.length).toBeGreaterThan(0);
    for (const filter of listFilters) {
      expect(filter.$and).toEqual(expect.arrayContaining([{ productId: 'pr1' }]));
    }
  });

  it('fails closed on a malformed predicate (deny-all id in the filter)', async () => {
    const { service, listFilters } = makeService();
    await service.listOrders('p1', 0, 25, {}, SCOPE, MALFORMED);
    const and = listFilters[0].$and as AnyRec[];
    expect(
      and.some((f) => f._id instanceof ObjectId && f._id.toString() === '000000000000000000000000'),
    ).toBe(true);
    // the deny must stay project-scoped, never widen the read
    expect(and.some((f) => (f as AnyRec).projectId === 'p1')).toBe(true);
  });

  it('adds no narrowing when the header is absent', async () => {
    const { service, listFilters } = makeService();
    await service.listOrders('p1', 0, 25, {}, SCOPE, { present: false });
    const filter = listFilters[0];
    expect(filter.$and).toBeUndefined();
    expect(filter.projectId).toBe('p1');
  });

  it('pushes the fragment into the kanban $match', async () => {
    const { service, aggregatePipelines } = makeService();
    await service.getKanban('p1', 't1', SCOPE, MONGO_ACCESS);
    const match = aggregatePipelines[0][0].$match as AnyRec;
    expect(match.$and).toEqual(expect.arrayContaining([{ productId: 'pr1' }]));
  });

  it('pushes the fragment into the per-deal summary filter', async () => {
    const { service, listFilters } = makeService();
    await service.getOrdersSummaryForDeal('p1', 'd1', SCOPE, MONGO_ACCESS);
    expect(listFilters[0].$and).toEqual(expect.arrayContaining([{ productId: 'pr1' }]));
  });
});

describe('OrdersService ABAC — single-record gate (write gate = read gate)', () => {
  it('applies the mongo fragment to the get-by-id filter', async () => {
    const { service, findOneFilters } = makeService();
    await service.getOrder('p1', ORDER_ID.toString(), SCOPE, MONGO_ACCESS);
    expect(findOneFilters[0].$and).toEqual(expect.arrayContaining([{ productId: 'pr1' }]));
  });

  it('denies a malformed predicate with NOT_FOUND (no existence leak)', async () => {
    const { service } = makeService();
    await expect(
      service.getOrder('p1', ORDER_ID.toString(), SCOPE, MALFORMED),
    ).rejects.toMatchObject({ message: 'Продажа не найдена' });
  });

  it('evaluates the `ir` gate on the loaded record', async () => {
    const pass: AccessPredicate = {
      present: true,
      mongo: null,
      ir: { op: 'eq', left: { ref: 'record.productId' }, right: { lit: 'pr1' } } as never,
    };
    const deny: AccessPredicate = {
      present: true,
      mongo: null,
      ir: { op: 'eq', left: { ref: 'record.productId' }, right: { lit: 'other' } } as never,
    };
    const ok = makeService();
    await expect(
      ok.service.getOrder('p1', ORDER_ID.toString(), SCOPE, pass),
    ).resolves.toMatchObject({ id: ORDER_ID.toString() });
    const nope = makeService();
    await expect(
      nope.service.getOrder('p1', ORDER_ID.toString(), SCOPE, deny),
    ).rejects.toMatchObject({ message: 'Продажа не найдена' });
  });

  it('gates the MUTATION path through the same predicate (cancel)', async () => {
    const { service } = makeService();
    await expect(
      service.cancelOrder('p1', ORDER_ID.toString(), 'reason', SCOPE, MALFORMED),
    ).rejects.toMatchObject({ message: 'Продажа не найдена' });
  });
});
