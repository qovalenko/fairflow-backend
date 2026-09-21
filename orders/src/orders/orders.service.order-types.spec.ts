import { ObjectId } from 'mongodb';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { EmitIntent } from '@fairflow/shared';

type AnyRec = Record<string, unknown>;

function makeService(
  opts: {
    orderTypeCount?: number;
    orderTypesList?: AnyRec[];
    orderTypeDoc?: AnyRec | null;
    duplicateName?: boolean;
    duplicateNameOnUpdate?: boolean;
    activeCounts?: Array<{ _id: string; c: number }>;
    countByProduct?: number;
    activeOrdersCount?: number;
    revision?: AnyRec | null;
  } = {},
) {
  const emitted: EmitIntent[] = [];
  let insertedTypes = 0;
  const orderTypeFindFilters: AnyRec[] = [];

  const defaultType = {
    id: 't1',
    name: 'Sale',
    currentVersion: 1,
    stages: [
      { id: 's1', name: 'New', order: 0, isTerminal: false },
      { id: 's2', name: 'Won', order: 1, isTerminal: true },
    ],
    fields: [],
  };

  const orderTypesColl = {
    countDocuments: async () => opts.orderTypeCount ?? 0,
    find: (filter?: AnyRec) => {
      if (filter) orderTypeFindFilters.push(filter);
      return {
        toArray: async () => opts.orderTypesList ?? [opts.orderTypeDoc ?? defaultType],
      };
    },
    findOne: async (q?: AnyRec) => {
      if (q && 'name' in q) {
        if (opts.duplicateName) return { id: 'dup', name: q.name };
        if (opts.duplicateNameOnUpdate && q.id && '$ne' in (q.id as AnyRec)) {
          return { id: 'other', name: q.name };
        }
        return null;
      }
      if (opts.orderTypeDoc === null) return null;
      return opts.orderTypeDoc ?? defaultType;
    },
    insertOne: async () => {
      insertedTypes += 1;
      return { insertedId: new ObjectId() };
    },
    updateOne: async () => ({ modifiedCount: 1 }),
  };

  const orderTypeRevisionsColl = {
    insertOne: async () => ({ insertedId: new ObjectId() }),
    findOne: async () => opts.revision ?? null,
  };

  const ordersColl = {
    countDocuments: async (filter?: AnyRec) => {
      if (filter && 'productId' in filter) return opts.countByProduct ?? 3;
      if (filter && 'typeId' in filter) return opts.activeOrdersCount ?? 0;
      return opts.countByProduct ?? 3;
    },
    aggregate: () => ({
      toArray: async () => opts.activeCounts ?? [{ _id: 't1', c: 5 }],
    }),
  };

  const mongo = {
    orderTypes: () => orderTypesColl,
    orderTypeRevisions: () => orderTypeRevisionsColl,
    orders: () => ordersColl,
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
    readContact: async () => ({ state: 'unknown', fields: {} }),
    readCompany: async () => ({ state: 'unknown', fields: {} }),
    readProductSaleType: async () => null,
    readProductForOrder: async () => null,
  } as unknown as ConstructorParameters<typeof OrdersService>[2];

  const service = new OrdersService(mongo, outbox, sourceReader, noopSpecValidator);
  return { service, emitted, insertedTypes: () => insertedTypes, orderTypeFindFilters };
}

const validStages = [
  { id: 's1', name: 'New', order: 0, is_terminal: false },
  { id: 's2', name: 'Done', order: 1, is_terminal: true },
];

describe('OrdersService.countOrdersByProduct', () => {
  it('возвращает 0 при пустых идентификаторах без запроса в Mongo', async () => {
    const { service } = makeService();
    await expect(service.countOrdersByProduct('', 'p1')).resolves.toEqual({ count: 0 });
    await expect(service.countOrdersByProduct('p1', '')).resolves.toEqual({ count: 0 });
  });

  it('считает активные продажи продукта в границах проекта', async () => {
    const { service } = makeService({ countByProduct: 7 });
    await expect(service.countOrdersByProduct('p1', 'prod-1')).resolves.toEqual({ count: 7 });
  });
});

describe('OrdersService.provisionDefaults', () => {
  it('ничего не делает без projectId', async () => {
    const { service, insertedTypes } = makeService();
    await expect(service.provisionDefaults('')).resolves.toEqual({
      created: false,
      order_types: 0,
    });
    expect(insertedTypes()).toBe(0);
  });

  it('идемпотентен — не создаёт типы, если они уже есть', async () => {
    const { service, insertedTypes } = makeService({ orderTypeCount: 2 });
    await expect(service.provisionDefaults('p1')).resolves.toEqual({
      created: false,
      order_types: 0,
    });
    expect(insertedTypes()).toBe(0);
  });

  it('создаёт типы из шаблона и эмитит crm.order_type.created', async () => {
    const { service, emitted, insertedTypes } = makeService({ orderTypeCount: 0 });
    const res = await service.provisionDefaults('p1', 'b2b-sales');
    expect(res.created).toBe(true);
    expect(res.order_types).toBe(1);
    expect(insertedTypes()).toBe(1);
    expect(emitted.some((e) => e.type === 'crm.order_type.created')).toBe(true);
  });
});

describe('OrdersService.listOrderTypes', () => {
  it('подмешивает active_orders из агрегата по типам', async () => {
    const { service } = makeService({
      orderTypesList: [{ id: 't1', name: 'Sale', stages: [], fields: [] }],
      activeCounts: [{ _id: 't1', c: 4 }],
    });
    const res = await service.listOrderTypes('p1');
    expect(res.list[0].active_orders).toBe(4);
    expect(res.list[0].name).toBe('Sale');
  });

  it('includeDeleted=true не фильтрует deletedAt', async () => {
    const { service, orderTypeFindFilters } = makeService();
    await service.listOrderTypes('p1', true);
    expect(orderTypeFindFilters[0].deletedAt).toBeUndefined();
  });
});

describe('OrdersService.getOrderType', () => {
  it('бросает NOT_FOUND, если тип не найден в проекте', async () => {
    const { service } = makeService({ orderTypeDoc: null });
    await expect(service.getOrderType('p1', 'missing')).rejects.toMatchObject({
      message: 'Тип продажи не найден',
    });
  });

  it('синтезирует legacy-ревизию, если pinned revision отсутствует', async () => {
    const { service } = makeService({ revision: null });
    const detail = await service.getOrderType('p1', 't1');
    expect(detail.revision?.version).toBe(1);
    expect(detail.revision?.terminal_stage_id).toBe('s2');
  });
});

describe('OrdersService.createOrderType — негативные ветки validateSpec', () => {
  it('бросает INVALID_ARGUMENT без name', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', { fields: [], stages: validStages }),
    ).rejects.toMatchObject({ message: 'name обязателен' });
  });

  it('бросает ALREADY_EXISTS при дубликате имени', async () => {
    const { service } = makeService({ duplicateName: true });
    await expect(
      service.createOrderType('p1', { name: 'Sale', fields: [], stages: validStages }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('ALREADY_EXISTS'),
    });
  });

  it('отклоняет duplicate field key', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', {
        name: 'DupField',
        fields: [
          { key: 'x', label: 'X', type: 'TEXT', required: false },
          { key: 'x', label: 'X2', type: 'TEXT', required: false },
        ],
        stages: validStages,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('отклоняет spec без stages', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', { name: 'NoStages', fields: [], stages: [] }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('отклоняет spec без единственной terminal stage', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', {
        name: 'NoTerminal',
        fields: [],
        stages: [
          { id: 's1', name: 'A', order: 0, is_terminal: false },
          { id: 's2', name: 'B', order: 1, is_terminal: false },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('отклоняет terminal stage не на последней позиции', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', {
        name: 'BadTerminal',
        fields: [],
        stages: [
          { id: 's1', name: 'Won', order: 0, is_terminal: true },
          { id: 's2', name: 'Later', order: 1, is_terminal: false },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('отклоняет requiredFieldKeys, ссылающийся на неизвестное поле', async () => {
    const { service } = makeService();
    await expect(
      service.createOrderType('p1', {
        name: 'UnknownKey',
        fields: [{ key: 'a', label: 'A', type: 'TEXT', required: false }],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          {
            id: 's2',
            name: 'Done',
            order: 1,
            is_terminal: true,
            required_field_keys: ['missing'],
          },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });
});

describe('OrdersService.updateOrderType', () => {
  const updateSpec = {
    name: 'Renamed',
    fields: [],
    stages: validStages,
  };

  it('бросает NOT_FOUND, если тип отсутствует', async () => {
    const { service } = makeService({ orderTypeDoc: null });
    await expect(service.updateOrderType('p1', 't1', updateSpec)).rejects.toMatchObject({
      message: 'Тип продажи не найден',
    });
  });

  it('бросает ALREADY_EXISTS при конфликте имени с другим типом', async () => {
    const { service } = makeService({ duplicateNameOnUpdate: true });
    await expect(service.updateOrderType('p1', 't1', updateSpec)).rejects.toMatchObject({
      message: expect.stringContaining('ALREADY_EXISTS'),
    });
  });

  it('создаёт новую ревизию и эмитит crm.order_type.updated', async () => {
    const { service, emitted } = makeService();
    await expect(service.updateOrderType('p1', 't1', updateSpec, 'u1')).resolves.toBeDefined();
    expect(emitted.some((e) => e.type === 'crm.order_type.updated')).toBe(true);
  });
});

describe('OrdersService.deleteOrderType / restoreOrderType', () => {
  it('deleteOrderType бросает NOT_FOUND для отсутствующего типа', async () => {
    const { service } = makeService({ orderTypeDoc: null });
    await expect(service.deleteOrderType('p1', 't1')).rejects.toMatchObject({
      message: 'Тип продажи не найден',
    });
  });

  it('deleteOrderType бросает FAILED_PRECONDITION при активных продажах', async () => {
    const { service } = makeService({ activeOrdersCount: 2 });
    await expect(service.deleteOrderType('p1', 't1')).rejects.toMatchObject({
      message: expect.stringContaining('ORDER_TYPE_HAS_ACTIVE_ORDERS'),
    });
  });

  it('deleteOrderType soft-delete и эмит crm.order_type.deleted', async () => {
    const { service, emitted } = makeService();
    await expect(service.deleteOrderType('p1', 't1')).resolves.toBeDefined();
    expect(emitted.some((e) => e.type === 'crm.order_type.deleted')).toBe(true);
  });

  it('restoreOrderType бросает NOT_FOUND для отсутствующего типа', async () => {
    const { service } = makeService({ orderTypeDoc: null });
    await expect(service.restoreOrderType('p1', 't1')).rejects.toMatchObject({
      message: 'Тип продажи не найден',
    });
  });

  it('restoreOrderType восстанавливает тип и эмитит crm.order_type.restored', async () => {
    const { service, emitted } = makeService();
    await expect(service.restoreOrderType('p1', 't1')).resolves.toBeDefined();
    expect(emitted.some((e) => e.type === 'crm.order_type.restored')).toBe(true);
  });
});

describe('OrdersService.createOrderType — happy path', () => {
  it('создаёт тип и эмитит crm.order_type.created', async () => {
    const { service, emitted } = makeService();
    const detail = await service.createOrderType(
      'p1',
      { name: 'NewType', fields: [], stages: validStages },
      'u1',
    );
    expect(detail.id).toBe('t1');
    expect(emitted.some((e) => e.type === 'crm.order_type.created')).toBe(true);
  });
});
