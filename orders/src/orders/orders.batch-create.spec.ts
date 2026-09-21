import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import type { SourceRead } from './order-drift';

function makeBatchService() {
  const emitted: EmitIntent[] = [];
  let seq = 0;
  const productType = {
    id: 'ot-a',
    name: 'Type A',
    currentVersion: 1,
    stages: [{ id: 'os1', name: 'New', order: 0 }],
    fields: [],
  };
  const productTypeB = {
    id: 'ot-b',
    name: 'Type B',
    currentVersion: 1,
    stages: [{ id: 'os1', name: 'New', order: 0 }],
    fields: [],
  };
  const orderTypesColl = {
    find: () => ({ toArray: async () => [productType, productTypeB] }),
    findOne: async (q?: Record<string, unknown>) => {
      if (q && 'name' in q) return null;
      const id = String(q?.id ?? '');
      return [productType, productTypeB].find((t) => t.id === id) ?? productType;
    },
    insertOne: async () => ({}),
    updateOne: async () => ({ modifiedCount: 1 }),
  };
  const ordersColl = {
    insertOne: async () => {
      seq += 1;
      return { insertedId: { toString: () => `order-${seq}` } };
    },
    findOne: async () => ({
      _id: { toString: () => `order-${seq}` },
      number: `ORD-0000${seq}`,
      typeId: productType.id,
      status: 'ACTIVE',
      stageId: 'os1',
      orderTypeVersion: 1,
      fieldsJson: '{}',
      finalActionState: { status: 'IDLE', payloadGen: 1, sendGen: 1, attempts: [] },
    }),
    find: () => ({
      sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
      toArray: async () => [],
    }),
    updateOne: async () => ({ modifiedCount: 1, matchedCount: 1 }),
  };
  const mongo = {
    orderTypes: () => orderTypesColl,
    orderTypeRevisions: () => ({
      insertOne: async () => ({}),
      findOne: async () => ({ fields: [] }),
    }),
    orders: () => ordersColl,
    nextOrderNumber: async () => seq,
  } as unknown as ConstructorParameters<typeof OrdersService>[0];
  const outbox = {
    withOutbox: async <R>(
      work: (s: undefined) => Promise<{ result: R; intents: EmitIntent[] }>,
    ): Promise<R> => {
      const { result, intents } = await work(undefined);
      emitted.push(...intents);
      return result;
    },
  } as unknown as ConstructorParameters<typeof OrdersService>[1];
  const sourceReader = {
    readContact: async (): Promise<SourceRead> => ({ state: 'unknown', fields: {} }),
    readCompany: async (): Promise<SourceRead> => ({ state: 'unknown', fields: {} }),
    readProductForOrder: async (_p: string, productId: string) =>
      productId === 'pr-b'
        ? {
            orderTypeId: 'ot-b',
            dangling: false,
            name: '',
            price: 0,
            currency: '',
            unit: '',
            category: '',
            prefill: {},
          }
        : {
            orderTypeId: 'ot-a',
            dangling: false,
            name: '',
            price: 0,
            currency: '',
            unit: '',
            category: '',
            prefill: {},
          },
  } as unknown as ConstructorParameters<typeof OrdersService>[2];
  const service = new OrdersService(mongo, outbox, sourceReader, noopSpecValidator);
  return { service, emitted };
}

describe('OrdersService.createOrdersBatch (FR-ORDERS-135)', () => {
  const actor = {
    projectId: 'p1',
    userId: 'u1',
    scope: {
      mode: 'all',
      ownerIds: [],
      sharedRecordIds: [],
    } as unknown as VisibilityScope,
  };

  it('creates one sale per product row for the same deal', async () => {
    const { service, emitted } = makeBatchService();
    const res = await service.createOrdersBatch(
      {
        deal_id: 'deal-1',
        contact_id: 'c1',
        items: [{ product_id: 'pr-a' }, { product_id: 'pr-b' }],
      },
      actor,
    );
    expect(res.created).toHaveLength(2);
    expect(res.errors).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'crm.order.created')).toHaveLength(2);
  });

  it('returns per-row errors on partial failure', async () => {
    const { service } = makeBatchService();
    const res = await service.createOrdersBatch(
      {
        deal_id: 'deal-1',
        items: [{ product_id: 'pr-a' }, { product_id: '' }],
      },
      actor,
    );
    expect(res.created).toHaveLength(1);
    expect(res.errors).toEqual([
      { index: 1, code: 'PRODUCT_REQUIRED', message: 'productId обязателен' },
    ]);
  });

  it('requires dealId', async () => {
    const { service } = makeBatchService();
    await expect(
      service.createOrdersBatch({ items: [{ product_id: 'pr-a' }] }, actor),
    ).rejects.toBeInstanceOf(RpcException);
    try {
      await service.createOrdersBatch({ items: [{ product_id: 'pr-a' }] }, actor);
    } catch (err) {
      const e = (err as RpcException).getError() as { code?: number };
      expect(e.code).toBe(status.INVALID_ARGUMENT);
    }
  });
});
