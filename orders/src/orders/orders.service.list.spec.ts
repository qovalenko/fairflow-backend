import { ObjectId } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';

type AnyRec = Record<string, unknown>;

const SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
};

function makeService() {
  const listFilters: AnyRec[] = [];
  let capturedLimit = 0;
  let capturedSkip = 0;

  const doc: AnyRec = {
    _id: new ObjectId(),
    projectId: 'p1',
    typeId: 't1',
    stageId: 'os1',
    status: 'ACTIVE',
    number: 'ORD-00042',
    snapshot: { contact: { name: 'Alice' }, company: { name: 'ACME', inn: '123' } },
    updatedAt: Date.now(),
  };

  const ordersColl = {
    countDocuments: async (filter: AnyRec) => {
      listFilters.push(filter);
      return 1;
    },
    find: (filter: AnyRec) => {
      listFilters.push(filter);
      return {
        sort: () => ({
          skip: (skip: number) => {
            capturedSkip = skip;
            return {
              limit: (limit: number) => {
                capturedLimit = limit;
                return {
                  toArray: async () => [doc],
                };
              },
            };
          },
        }),
      };
    },
  };

  const mongo = {
    orders: () => ordersColl,
    orderTypes: () => ({
      find: () => ({
        toArray: async () => [
          { id: 't1', name: 'Sale', stages: [{ id: 'os1', name: 'New', order: 0 }] },
        ],
      }),
    }),
  } as unknown as ConstructorParameters<typeof OrdersService>[0];

  const service = new OrdersService(
    mongo,
    {} as ConstructorParameters<typeof OrdersService>[1],
    {} as ConstructorParameters<typeof OrdersService>[2],
    noopSpecValidator,
  );
  return { service, listFilters, doc, capturedLimit: () => capturedLimit, capturedSkip: () => capturedSkip };
}

describe('OrdersService.listOrders — фильтры и проекция', () => {
  it('добавляет текстовый поиск и staleDays в Mongo-фильтр', async () => {
    const { service, listFilters } = makeService();
    await service.listOrders(
      'p1',
      0,
      25,
      { query: 'alice', staleDays: 7, dealId: 'd1', typeId: 't1', statusFilter: 'ACTIVE' },
      SCOPE,
    );
    const filter = listFilters[0];
    expect(filter.dealId).toBe('d1');
    expect(filter.typeId).toBe('t1');
    expect(filter.status).toBe('ACTIVE');
    expect(filter.$or).toBeDefined();
    expect(filter.stageChangedAt).toEqual({ $lt: expect.any(Number) });
  });

  it('нормализует pageSize в диапазон 1..100', async () => {
    const svc0 = makeService();
    await svc0.service.listOrders('p1', 0, 0, {}, SCOPE);
    expect(svc0.capturedLimit()).toBe(25);

    const svcMin = makeService();
    await svcMin.service.listOrders('p1', 0, -5, {}, SCOPE);
    expect(svcMin.capturedLimit()).toBe(1);

    const svcMax = makeService();
    await svcMax.service.listOrders('p1', 2, 500, {}, SCOPE);
    expect(svcMax.capturedLimit()).toBe(100);
    expect(svcMax.capturedSkip()).toBe(200);
  });

  it('мапит final_action_state.attempts в ответ списка', async () => {
    const { service, doc } = makeService();
    doc.finalActionState = {
      status: 'FAILED',
      attempts: [{ at: 1, attemptNo: 2, responseCode: 500, errorBody: 'boom', durationMs: 9 }],
    };
    const res = await service.listOrders('p1', 0, 25, {}, SCOPE);
    expect(res.list[0].final_action_state.attempts).toEqual([
      { at: 1, attempt_no: 2, response_code: 500, error_body: 'boom', duration_ms: 9 },
    ]);
  });
});

describe('OrdersService.loadVisible — границы видимости', () => {
  it('NOT_FOUND для невалидного ObjectId', async () => {
    const { service } = makeService();
    await expect(service.getOrder('p1', 'not-an-id', SCOPE)).rejects.toMatchObject({
      message: 'Продажа не найдена',
    });
  });
});
