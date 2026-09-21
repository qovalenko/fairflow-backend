import { ObjectId } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import type { SourceRead } from './order-drift';
import type { ProductForOrder } from './order-source-reader.service';

/**
 * Focused unit coverage for the two wave-3 changes:
 *  - restoreOrderType emits the distinct `crm.order_type.restored` key
 *    (be-ordertype-restored-key), and
 *  - createOrder captures a real contact/company snapshot at create time,
 *    fail-soft to an empty snapshot when the source-reader is unavailable
 *    (be-createorder-snapshot, §3.9.3).
 *
 * Mongo / outbox / source-reader are stubbed — no real infra.
 */

type AnyRec = Record<string, unknown>;

function makeService(opts: {
  orderType?: AnyRec | null;
  /** All live types returned by orderTypes.find().toArray() — defaults to [orderType]. */
  orderTypesList?: AnyRec[];
  revision?: AnyRec | null;
  contactRead?: SourceRead | Error;
  companyRead?: SourceRead | Error;
  productSaleType?: { orderTypeId: string; dangling: boolean } | null;
  productForOrder?: ProductForOrder | null;
  /** Pre-existing order doc returned by orders.findOne (cancel/update paths). */
  existingOrder?: AnyRec;
  /** Docs returned by orders.find().toArray() list-style reads (deal summary). */
  orderDocs?: AnyRec[];
  /** matchedCount reported by orders.updateOne (conditional-transition tests). */
  orderUpdateMatched?: number;
  /** Rows returned by orders.find(...) (watchdog stale-SENDING scan). */
  staleSending?: AnyRec[];
}): {
  service: OrdersService;
  emitted: EmitIntent[];
  insertedDoc: () => AnyRec | undefined;
  insertedType: () => AnyRec | undefined;
  insertedRevision: () => AnyRec | undefined;
  orderUpdates: Array<{ q: AnyRec; u: AnyRec }>;
} {
  const emitted: EmitIntent[] = [];
  const orderUpdates: Array<{ q: AnyRec; u: AnyRec }> = [];
  let insertedDoc: AnyRec | undefined;
  let insertedType: AnyRec | undefined;
  let insertedRevision: AnyRec | undefined;

  const type =
    opts.orderType === undefined
      ? {
          id: 't1',
          name: 'Sale',
          currentVersion: 1,
          stages: [{ id: 'os1', name: 'New', order: 0 }],
          fields: [],
        }
      : opts.orderType;
  const typesList = opts.orderTypesList ?? (type ? [type] : []);

  const orderTypesColl = {
    find: () => ({ toArray: async () => typesList }),
    findOne: async (q?: AnyRec) => {
      // createOrderType duplicate-name probe uses a `name` filter — return null
      // so the create proceeds; the final getOrderType() reads the inserted doc.
      if (q && 'name' in q) return null;
      if (q && 'id' in q && type && String(q.id) !== String(type.id)) return null;
      return insertedType ?? type;
    },
    insertOne: async (doc: AnyRec) => {
      insertedType = doc;
      return { insertedId: doc._id };
    },
    updateOne: async () => ({ modifiedCount: 1 }),
  };
  const orderTypeRevisionsColl = {
    insertOne: async (doc: AnyRec) => {
      insertedRevision = doc;
      return { insertedId: doc._id };
    },
    findOne: async () => opts.revision ?? insertedRevision ?? { fields: [] },
  };
  const ordersColl = {
    insertOne: async (doc: AnyRec) => {
      insertedDoc = doc;
      return { insertedId: { toString: () => 'order-1' } };
    },
    findOne: async () => insertedDoc ?? opts.existingOrder ?? null,
    // Watchdog stale-SENDING scan and deal summary: find(...).toArray() (with
    // optional sort/limit). `orderDocs` feeds list-style reads, `staleSending`
    // keeps the watchdog tests untouched.
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        toArray: async () => opts.orderDocs ?? opts.staleSending ?? [],
      };
      return chain;
    },
    // Semantic conditional update against the (single) existing doc: the saga
    // transitions rely on `{ status, finalActionState.idempotencyKey }` filters,
    // so the mock honours them and applies `$set` — a stale key/status matches
    // nothing, exactly like Mongo. `orderUpdateMatched` still force-overrides.
    updateOne: async (q: AnyRec, u: AnyRec) => {
      orderUpdates.push({ q, u });
      let matched = opts.orderUpdateMatched ?? 1;
      // A sweep touches MANY docs, so resolve the target by `_id` across every
      // doc the test set up (single-doc tests keep the old behaviour: the pool
      // then holds exactly the one doc the filter addresses).
      const pool = [insertedDoc, opts.existingOrder, ...(opts.staleSending ?? [])].filter(
        Boolean,
      ) as AnyRec[];
      const byId =
        q._id === undefined ? undefined : pool.find((d) => String(d._id) === String(q._id));
      const doc = byId ?? insertedDoc ?? opts.existingOrder;
      if (opts.orderUpdateMatched === undefined && doc) {
        if (q.status !== undefined && String(doc.status) !== q.status) matched = 0;
        const wantKey = q['finalActionState.idempotencyKey'];
        if (matched) {
          const fas = (doc.finalActionState as AnyRec | undefined) ?? {};
          if (wantKey !== undefined && String(fas.idempotencyKey ?? '') !== wantKey) matched = 0;
          // Mongo-faithful `$or` over the idempotencyKey (legacy-doc expiry
          // filter): matches ONLY a missing or empty key — a doc with a real
          // in-flight key must NOT be flipped by the legacy branch.
          if (q.$or !== undefined) {
            const missingOrEmpty = !('idempotencyKey' in fas) || fas.idempotencyKey === '';
            if (!missingOrEmpty) matched = 0;
          }
        }
        if (matched && u.$set) {
          for (const [k, v] of Object.entries(u.$set as AnyRec)) {
            if (k.startsWith('finalActionState.')) {
              const fas = (doc.finalActionState as AnyRec | undefined) ?? {};
              fas[k.slice('finalActionState.'.length)] = v;
              doc.finalActionState = fas;
            } else {
              doc[k] = v;
            }
          }
        }
      }
      return { modifiedCount: matched, matchedCount: matched };
    },
  };

  const mongo = {
    orderTypes: () => orderTypesColl,
    orderTypeRevisions: () => orderTypeRevisionsColl,
    orders: () => ordersColl,
    nextOrderNumber: async () => 1,
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
    readContact: async (): Promise<SourceRead> => {
      if (opts.contactRead instanceof Error) throw opts.contactRead;
      return opts.contactRead ?? { state: 'unknown', fields: {} };
    },
    readCompany: async (): Promise<SourceRead> => {
      if (opts.companyRead instanceof Error) throw opts.companyRead;
      return opts.companyRead ?? { state: 'unknown', fields: {} };
    },
    readProductSaleType: async () => opts.productSaleType ?? null,
    readProductForOrder: async () =>
      opts.productForOrder ??
      (opts.productSaleType
        ? ({
            orderTypeId: opts.productSaleType.orderTypeId,
            dangling: opts.productSaleType.dangling,
            name: '',
            price: 0,
            currency: '',
            unit: '',
            category: '',
            prefill: {},
          } satisfies ProductForOrder)
        : null),
  } as unknown as ConstructorParameters<typeof OrdersService>[2];

  const service = new OrdersService(mongo, outbox, sourceReader, noopSpecValidator);
  return {
    service,
    emitted,
    insertedDoc: () => insertedDoc,
    insertedType: () => insertedType,
    insertedRevision: () => insertedRevision,
    orderUpdates,
  };
}

describe('OrdersService.restoreOrderType', () => {
  it('emits crm.order_type.restored (not .updated)', async () => {
    const { service, emitted } = makeService({});
    await service.restoreOrderType('p1', 't1');
    const restore = emitted.find((e) => e.idempotencyKey === 'order_type.restored:t1');
    expect(restore).toBeDefined();
    expect(restore?.type).toBe('crm.order_type.restored');
    expect(emitted.some((e) => e.type === 'crm.order_type.updated')).toBe(false);
    expect(restore?.payload).toMatchObject({ orderTypeId: 't1', restored: true });
  });
});

describe('OrdersService.createOrderType spec key normalization (T-027)', () => {
  // The orders gRPC loader runs with keepCase:true, so the gateway BFF delivers
  // stage/field keys in snake_case. parseSpec must accept those (as well as the
  // camelCase form produced by provisioning / legacy revisions) or every create
  // fails validateSpec with `no_terminal_stage`.
  const snakeStages = [
    { id: 's1', name: 'New', order: 0, required_field_keys: [], is_terminal: false },
    { id: 's2', name: 'Won', order: 1, required_field_keys: ['amount'], is_terminal: true },
  ];
  const camelStages = [
    { id: 's1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
    { id: 's2', name: 'Won', order: 1, requiredFieldKeys: ['amount'], isTerminal: true },
  ];
  const snakeFields = [
    {
      key: 'amount',
      label: 'Amount',
      type: 'NUMBER',
      required: true,
      default_value: '0',
      validation_json: '{"min":1}',
    },
  ];

  it('creates a type when stages arrive in snake_case (gateway/keepCase)', async () => {
    const { service, insertedType, insertedRevision } = makeService({ orderType: null });
    const detail = await service.createOrderType('p1', {
      name: 't027-snake',
      fields: snakeFields,
      stages: snakeStages,
    });
    // No throw = validateSpec saw the terminal stage. Persisted spec is camelCase.
    const rev = insertedRevision() as AnyRec;
    expect((rev.stages as AnyRec[])[1]).toMatchObject({
      id: 's2',
      isTerminal: true,
      requiredFieldKeys: ['amount'],
    });
    expect(rev.terminalStageId).toBe('s2');
    expect((rev.fields as AnyRec[])[0]).toMatchObject({
      key: 'amount',
      defaultValue: '0',
      validation: { min: 1 },
    });
    // getOrderType response round-trips back to snake_case for the wire.
    expect((detail as AnyRec).revision).toBeDefined();
    expect(insertedType()?.name).toBe('t027-snake');
  });

  it('still creates a type when stages arrive in camelCase (provisioning/legacy)', async () => {
    const { service, insertedRevision } = makeService({ orderType: null });
    await service.createOrderType('p1', {
      name: 't027-camel',
      fields: [{ key: 'amount', label: 'Amount', type: 'NUMBER', required: true }],
      stages: camelStages,
    });
    const rev = insertedRevision() as AnyRec;
    expect((rev.stages as AnyRec[])[1]).toMatchObject({ id: 's2', isTerminal: true });
    expect(rev.terminalStageId).toBe('s2');
  });

  it('rejects a spec with no terminal stage regardless of casing', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 't027-noterm',
        fields: [],
        stages: [{ id: 's1', name: 'New', order: 0, is_terminal: false }],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('FR-ORDERS-035: rejects webhook finalActionSpec without connection ref', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 'bad-webhook',
        fields: [],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          { id: 's2', name: 'Done', order: 1, is_terminal: true },
        ],
        final_action_spec_json: JSON.stringify({ type: 'webhook', config: {} }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('FR-ORDERS-035: rejects webhook finalActionSpec with raw URL', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 'raw-url',
        fields: [],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          { id: 's2', name: 'Done', order: 1, is_terminal: true },
        ],
        final_action_spec_json: JSON.stringify({
          type: 'webhook',
          config: { connection_id: 'conn-1', url: 'http://evil' },
        }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('FR-ORDERS-035: rejects email finalActionSpec without recipient', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 'bad-email',
        fields: [],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          { id: 's2', name: 'Done', order: 1, is_terminal: true },
        ],
        final_action_spec_json: JSON.stringify({ type: 'email', config: { subject: 'Hi' } }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('FR-ORDERS-035: rejects task finalActionSpec without title', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 'bad-task',
        fields: [],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          { id: 's2', name: 'Done', order: 1, is_terminal: true },
        ],
        final_action_spec_json: JSON.stringify({ type: 'task', config: { description: 'x' } }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });

  it('FR-ORDERS-100: rejects documentTemplates without template id', async () => {
    const { service } = makeService({ orderType: null });
    await expect(
      service.createOrderType('p1', {
        name: 'bad-templates',
        fields: [],
        stages: [
          { id: 's1', name: 'New', order: 0, is_terminal: false },
          { id: 's2', name: 'Done', order: 1, is_terminal: true },
        ],
        document_templates_json: JSON.stringify([{ name: 'orphan' }]),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('спецификаци') });
  });
});

describe('OrdersService.createOrder snapshot', () => {
  const actor = { projectId: 'p1', userId: 'u1' };

  it('captures present contact/company fields + hashes', async () => {
    const { service, insertedDoc } = makeService({
      contactRead: { state: 'present', fields: { name: 'Ann', phone: '+7', email: 'a@x' } },
      companyRead: { state: 'present', fields: { name: 'Acme', inn: '77', kpp: '01' } },
    });
    await service.createOrder({ contact_id: 'c1', company_id: 'co1' }, actor);
    const snap = insertedDoc()?.snapshot as AnyRec;
    expect(snap.contact).toEqual({ name: 'Ann', phone: '+7', email: 'a@x' });
    expect(snap.company).toEqual({ name: 'Acme', inn: '77', kpp: '01' });
    expect(snap.contactSourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.companySourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves fields empty (and hash empty) for deleted/unknown sources', async () => {
    const { service, insertedDoc } = makeService({
      contactRead: { state: 'deleted', fields: {} },
      companyRead: { state: 'unknown', fields: {} },
    });
    await service.createOrder({ contact_id: 'c1', company_id: 'co1' }, actor);
    const snap = insertedDoc()?.snapshot as AnyRec;
    expect(snap.contact).toEqual({});
    expect(snap.company).toEqual({});
    expect(snap.contactSourceHash).toBe('');
    expect(snap.companySourceHash).toBe('');
  });

  it('does not fail the create when the source-reader throws (fail-soft)', async () => {
    const { service, insertedDoc } = makeService({
      contactRead: new Error('gRPC down'),
      companyRead: new Error('gRPC down'),
    });
    await expect(
      service.createOrder({ contact_id: 'c1', company_id: 'co1' }, actor),
    ).resolves.toBeDefined();
    const snap = insertedDoc()?.snapshot as AnyRec;
    expect(snap.contact).toEqual({});
    expect(snap.company).toEqual({});
    expect(snap.contactSourceHash).toBe('');
    expect(snap.companySourceHash).toBe('');
  });

  it('TODO-051: emits crm.order.created with a flat top-level number for search', async () => {
    const { service, emitted, insertedDoc } = makeService({});
    await service.createOrder({ contact_id: 'c1' }, actor);
    const created = emitted.find((e) => e.type === 'crm.order.created');
    expect(created).toBeDefined();
    const payload = created?.payload as AnyRec;
    expect(payload.number).toBe(insertedDoc()?.number);
    expect((payload.after as AnyRec).number).toBe(insertedDoc()?.number);
  });

  it('FR-ORDERS-110: resolves sale-type from product when order_type_id omitted', async () => {
    const productType = {
      id: 'ot-product',
      name: 'From product',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [],
    };
    const defaultType = {
      id: 't1',
      name: 'Default',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [],
    };
    const { service, insertedDoc } = makeService({
      orderType: defaultType,
      orderTypesList: [defaultType, productType],
      productSaleType: { orderTypeId: 'ot-product', dangling: false },
    });
    await service.createOrder({ product_id: 'pr1', contact_id: 'c1' }, actor);
    expect(insertedDoc()?.typeId).toBe('ot-product');
  });

  it('FR-PRODUCTS-150: rejects createOrder when product sale-type link is dangling', async () => {
    const defaultType = {
      id: 't1',
      name: 'Default',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [],
    };
    const { service } = makeService({
      orderType: defaultType,
      orderTypesList: [defaultType],
      productSaleType: { orderTypeId: 'ot-broken', dangling: true },
    });

    await expect(
      service.createOrder({ product_id: 'pr1', contact_id: 'c1' }, actor),
    ).rejects.toBeInstanceOf(RpcException);

    try {
      await service.createOrder({ product_id: 'pr1', contact_id: 'c1' }, actor);
    } catch (err) {
      const e = (err as RpcException).getError() as { code?: number; message?: string };
      expect(e.code).toBe(status.ABORTED);
      expect(e.message).toBe('PRODUCT_ORDER_TYPE_DANGLING');
    }
  });

  it('FR-PRODUCTS-150: rejects createOrder when product has no sale-type configured', async () => {
    const defaultType = {
      id: 't1',
      name: 'Default',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [],
    };
    const { service } = makeService({
      orderType: defaultType,
      orderTypesList: [defaultType],
      productSaleType: { orderTypeId: '', dangling: false },
    });

    await expect(
      service.createOrder({ product_id: 'pr1', contact_id: 'c1' }, actor),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('FR-PRODUCTS-180: denormalizes product snapshot fields on create', async () => {
    const productType = {
      id: 'ot-product',
      name: 'From product',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [],
    };
    const { service, insertedDoc } = makeService({
      orderType: productType,
      orderTypesList: [productType],
      productForOrder: {
        orderTypeId: 'ot-product',
        dangling: false,
        name: 'Премиум-РКО',
        price: 50000,
        currency: 'RUB',
        unit: 'MONTHLY',
        category: 'РКО',
        prefill: {},
      },
    });
    await service.createOrder({ product_id: 'pr1', contact_id: 'c1' }, actor);
    expect(insertedDoc()).toMatchObject({
      productId: 'pr1',
      productName: 'Премиум-РКО',
      productPrice: 50000,
      productCurrency: 'RUB',
      productUnit: 'MONTHLY',
      productCategory: 'РКО',
    });
  });

  it('FR-PRODUCTS-170: merges product prefill into fields_json (body wins)', async () => {
    const productType = {
      id: 'ot-product',
      name: 'From product',
      currentVersion: 1,
      stages: [{ id: 'os1', name: 'New', order: 0 }],
      fields: [{ key: 'inn', label: 'ИНН', type: 'text', required: false }],
    };
    const { service, insertedDoc } = makeService({
      orderType: productType,
      orderTypesList: [productType],
      revision: { fields: productType.fields },
      productForOrder: {
        orderTypeId: 'ot-product',
        dangling: false,
        name: 'Тариф',
        price: 1000,
        currency: 'RUB',
        unit: 'ONE_TIME',
        category: 'Услуги',
        prefill: { inn: '7701', qty: 2 },
      },
    });
    await service.createOrder(
      {
        product_id: 'pr1',
        fields_json: JSON.stringify({ inn: '9999' }),
      },
      actor,
    );
    expect(JSON.parse(String(insertedDoc()?.fieldsJson))).toEqual({
      inn: '9999',
      qty: '2',
    });
  });
});

describe('OrdersService.createOrder / updateOrder notes (FR-ORDERS-200)', () => {
  const actor = {
    projectId: 'p1',
    userId: 'u1',
    scope: {
      mode: 'all',
      ownerIds: [],
      sharedRecordIds: [],
    } as unknown as import('@fairflow/shared').VisibilityScope,
  };
  const orderId = '507f1f77bcf86cd799439011';

  it('stores notes separately from fields_json on create', async () => {
    const { service, insertedDoc } = makeService({});
    await service.createOrder({ notes: 'Перезвонить в среду' }, actor);
    expect(insertedDoc()?.notes).toBe('Перезвонить в среду');
    expect(insertedDoc()?.fieldsJson).toBe('{}');
  });

  it('does not treat notes as a fields_json fallback', async () => {
    const { service, insertedDoc } = makeService({});
    await service.createOrder({ notes: '{"inn":"7701"}' }, actor);
    expect(insertedDoc()?.fieldsJson).toBe('{}');
    expect(insertedDoc()?.notes).toBe('{"inn":"7701"}');
  });

  it('persists notes on update without touching custom fields', async () => {
    const existing = {
      _id: new ObjectId(orderId),
      projectId: 'p1',
      typeId: 't1',
      orderTypeVersion: 1,
      stageId: 'os1',
      assigneeId: 'u1',
      fieldsJson: '{"inn":"7701"}',
      notes: 'старая',
      status: 'ACTIVE',
      number: 'ORD-00001',
      createdAt: 1,
      updatedAt: 1,
    };
    const { service, orderUpdates } = makeService({ existingOrder: existing });
    await service.updateOrder('p1', orderId, { notes: 'новая заметка' }, actor);
    expect(orderUpdates[0]?.u.$set).toMatchObject({ notes: 'новая заметка' });
    expect(orderUpdates[0]?.u.$set).not.toHaveProperty('fieldsJson');
  });
});

describe('OrdersService.getOrdersSummaryForDeal (FR-ORDERS-440)', () => {
  const scopeAll = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

  it('carries display names the deal-card widget renders (stage/type/product/deal)', async () => {
    const { service } = makeService({
      orderType: {
        id: 't1',
        name: 'Продажа авто',
        currentVersion: 1,
        stages: [{ id: 'os1', name: 'Оформление', order: 0 }],
        fields: [],
      },
      orderDocs: [
        {
          _id: new ObjectId(),
          number: 'ORD-00007',
          status: 'ACTIVE',
          typeId: 't1',
          stageId: 'os1',
          assigneeName: 'Иванов',
          productName: 'Авто',
          dealName: 'Сделка №7',
        },
      ],
    });
    const r = await service.getOrdersSummaryForDeal('p1', 'd1', scopeAll);
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({
      number: 'ORD-00007',
      stage_name: 'Оформление',
      type_name: 'Продажа авто',
      product_name: 'Авто',
      deal_name: 'Сделка №7',
    });
  });
});

describe('OrdersService.cancelOrder (final-action worker live — FR-MORD-29)', () => {
  // The final-action worker (automation crm.order.final_action_requested
  // consumer) now always resolves SENDING → DONE | SEND_ERROR, so the TODO-048
  // interim escape hatch is gone: an in-flight delivery must NOT be cancelled.
  const scopeAll = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

  const makeOrder = (status: string): AnyRec => ({
    _id: new ObjectId(),
    projectId: 'p1',
    typeId: 't1',
    stageId: 'os1',
    number: '1',
    status,
    createdAt: 1,
    updatedAt: 1,
  });

  it('rejects cancelling a SENDING order (in-flight delivery, saga will resolve it)', async () => {
    const doc = makeOrder('SENDING');
    const { service, emitted } = makeService({ existingOrder: doc });
    await expect(
      service.cancelOrder('p1', (doc._id as ObjectId).toString(), 'stuck', scopeAll),
    ).rejects.toThrow(/ORDER_NOT_CANCELLABLE/);
    expect(emitted).toHaveLength(0);
  });

  it('still cancels a SEND_ERROR order (the saga answered, retry is optional)', async () => {
    const doc = makeOrder('SEND_ERROR');
    const { service, emitted } = makeService({ existingOrder: doc });
    await expect(
      service.cancelOrder('p1', (doc._id as ObjectId).toString(), 'give up', scopeAll),
    ).resolves.toBeDefined();
    expect(emitted.some((e) => e.type === 'crm.order.cancelled')).toBe(true);
  });

  it('carries productId in the crm.order.cancelled payload (counter fact, TODO-446)', async () => {
    // countOrdersByProduct counts `status != CANCELLED`, so a cancel is a
    // decrement of product.ordersCount — the consumer needs the product in the
    // envelope to apply it (and to converge with RecountProductUsage).
    const doc = makeOrder('ACTIVE');
    doc.productId = 'prod-1';
    const { service, emitted } = makeService({ existingOrder: doc });
    await service.cancelOrder('p1', (doc._id as ObjectId).toString(), 'nope', scopeAll);
    const ev = emitted.find((e) => e.type === 'crm.order.cancelled') as unknown as AnyRec;
    expect(ev).toBeDefined();
    expect((ev.payload as AnyRec).productId).toBe('prod-1');
  });

  it('omits productId when the cancelled order is not bound to a product', async () => {
    const doc = makeOrder('ACTIVE');
    const { service, emitted } = makeService({ existingOrder: doc });
    await service.cancelOrder('p1', (doc._id as ObjectId).toString(), undefined, scopeAll);
    const ev = emitted.find((e) => e.type === 'crm.order.cancelled') as unknown as AnyRec;
    expect((ev.payload as AnyRec).productId).toBeUndefined();
  });

  it('still rejects cancelling a terminal DONE order', async () => {
    const doc = makeOrder('DONE');
    const { service } = makeService({ existingOrder: doc });
    await expect(
      service.cancelOrder('p1', (doc._id as ObjectId).toString(), undefined, scopeAll),
    ).rejects.toThrow(/ORDER_NOT_CANCELLABLE/);
  });
});

describe('OrdersService.moveOrder terminal transition — final-action executor gate (FR-ORDERS-270)', () => {
  const scopeAll = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

  const stages = [
    { id: 'os1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
    { id: 'os2', name: 'Sent', order: 1, requiredFieldKeys: [], isTerminal: true },
  ];
  const makeOrder = (): AnyRec => ({
    _id: new ObjectId(),
    projectId: 'p1',
    typeId: 't1',
    orderTypeVersion: 1,
    stageId: 'os1',
    number: '1',
    status: 'ACTIVE',
    assigneeId: 'u7',
    fieldsJson: '{}',
    snapshot: { contact: { name: 'Ann' } },
    finalActionState: { status: 'IDLE', payloadGen: 1, attempts: [] },
    createdAt: 1,
    updatedAt: 1,
  });
  const webhookRevision: AnyRec = {
    stages,
    fields: [],
    finalActionSpec: { type: 'webhook', config: { connection_id: 'conn-1' } },
    retryPolicy: { maxAttempts: 3 },
  };

  it('REFUSES the terminal move when the automation module is disabled (no silent skip, no stuck SENDING)', async () => {
    const doc = makeOrder();
    const { service, emitted } = makeService({ existingOrder: doc, revision: webhookRevision });
    await expect(
      service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll, ['orders']),
    ).rejects.toThrow(/FINAL_ACTION_EXECUTOR_UNAVAILABLE/);
    expect(emitted).toHaveLength(0);
  });

  it('moves to SENDING and publishes final_action_requested (with spec + assigneeId) when automation is enabled', async () => {
    const doc = makeOrder();
    const { service, emitted, orderUpdates } = makeService({
      existingOrder: doc,
      revision: webhookRevision,
    });
    await service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll, [
      'orders',
      'automation',
    ]);
    const req = emitted.find((e) => e.type === 'crm.order.final_action_requested');
    expect(req).toBeDefined();
    expect((req?.payload as AnyRec).spec).toEqual({
      type: 'webhook',
      config: { connection_id: 'conn-1' },
    });
    expect((req?.payload as AnyRec).assigneeId).toBe('u7');
    const set = orderUpdates[0]?.u.$set as AnyRec;
    expect(set.status).toBe('SENDING');
    expect(set['finalActionState.status']).toBe('PENDING');
  });

  it('fails open when the enabled-modules metadata is absent (trusted s2s caller)', async () => {
    const doc = makeOrder();
    const { service, emitted } = makeService({ existingOrder: doc, revision: webhookRevision });
    await service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
  });

  // Review MINOR: a repeat terminal transition (order already SENDING /
  // SEND_ERROR / DONE) must be REFUSED, not resent — the current sendGen key
  // is already terminally claimed on the automation side, so republishing it
  // would be silently dedupped and the order would sit in a false SENDING
  // until the watchdog stamps a misleading "final_action_timeout".
  it.each(['SENDING', 'SEND_ERROR', 'DONE'])(
    'REFUSES a repeat terminal move from %s (no false SENDING, no dedupped key)',
    async (fromStatus) => {
      const doc = makeOrder();
      doc.status = fromStatus;
      doc.finalActionState = {
        status:
          fromStatus === 'DONE' ? 'SUCCEEDED' : fromStatus === 'SEND_ERROR' ? 'FAILED' : 'PENDING',
        payloadGen: 1,
        sendGen: 1,
        idempotencyKey: `${(doc._id as ObjectId).toString()}:1:webhook:1:1`,
        attempts: [],
      };
      const { service, emitted, orderUpdates } = makeService({
        existingOrder: doc,
        revision: webhookRevision,
      });
      await expect(
        service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll, [
          'orders',
          'automation',
        ]),
      ).rejects.toThrow(/FINAL_ACTION_ALREADY_TRIGGERED/);
      // Nothing written, nothing published — the order keeps its real status.
      expect(orderUpdates).toHaveLength(0);
      expect(emitted).toHaveLength(0);
      expect(doc.status).toBe(fromStatus);
    },
  );

  it('points a SEND_ERROR repeat terminal move at RetryFinalAction (the one legitimate resend path)', async () => {
    const doc = makeOrder();
    doc.status = 'SEND_ERROR';
    const { service } = makeService({ existingOrder: doc, revision: webhookRevision });
    await expect(
      service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll),
    ).rejects.toThrow(/RetryFinalAction/);
  });

  it('does not gate a terminal move with finalActionSpec.type=none (goes straight to DONE)', async () => {
    const doc = makeOrder();
    const { service, emitted, orderUpdates } = makeService({
      existingOrder: doc,
      revision: { stages, fields: [], finalActionSpec: { type: 'none', config: {} } },
    });
    await service.moveOrder('p1', (doc._id as ObjectId).toString(), 'os2', false, scopeAll, [
      'orders',
    ]);
    expect((orderUpdates[0]?.u.$set as AnyRec).status).toBe('DONE');
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(false);
  });
});

describe('OrdersService.applyFinalActionResult (FR-ORDERS-280/290/320)', () => {
  const orderId = new ObjectId().toString();

  it('applies SENDING → DONE on a succeeded answer and emits status_changed', async () => {
    const { service, emitted, orderUpdates } = makeService({});
    await expect(
      service.applyFinalActionResult('p1', orderId, 'k1', true, {
        attemptNo: 1,
        httpCode: 200,
        durationMs: 42,
      }),
    ).resolves.toBe('applied');
    const { q, u } = orderUpdates[0];
    // Conditional transition = the idempotency guard: only the in-flight send
    // with the SAME business key matches.
    expect(q.status).toBe('SENDING');
    expect(q['finalActionState.idempotencyKey']).toBe('k1');
    const set = u.$set as AnyRec;
    expect(set.status).toBe('DONE');
    expect(set['finalActionState.status']).toBe('SUCCEEDED');
    expect((u.$push as AnyRec)['finalActionState.attempts']).toMatchObject({
      attemptNo: 1,
      responseCode: 200,
      durationMs: 42,
    });
    expect(
      emitted.some(
        (e) =>
          e.type === 'crm.order.status_changed' &&
          (e.payload as AnyRec).from === 'SENDING' &&
          (e.payload as AnyRec).to === 'DONE',
      ),
    ).toBe(true);
  });

  it('applies SENDING → SEND_ERROR on a failed answer with attempts[]/lastError', async () => {
    const { service, emitted, orderUpdates } = makeService({});
    await expect(
      service.applyFinalActionResult('p1', orderId, 'k1', false, {
        attemptNo: 4,
        error: 'http_503',
        httpCode: 503,
      }),
    ).resolves.toBe('applied');
    const set = orderUpdates[0].u.$set as AnyRec;
    expect(set.status).toBe('SEND_ERROR');
    expect(set['finalActionState.status']).toBe('FAILED');
    expect(set['finalActionState.lastError']).toBe('http_503');
    expect((orderUpdates[0].u.$push as AnyRec)['finalActionState.attempts']).toMatchObject({
      attemptNo: 4,
      responseCode: 503,
      errorBody: 'http_503',
    });
    expect(
      emitted.some(
        (e) => e.type === 'crm.order.status_changed' && (e.payload as AnyRec).to === 'SEND_ERROR',
      ),
    ).toBe(true);
  });

  it('is idempotent: a stale/duplicate answer matches nothing and emits nothing', async () => {
    const { service, emitted } = makeService({ orderUpdateMatched: 0 });
    await expect(service.applyFinalActionResult('p1', orderId, 'k-old', true)).resolves.toBe(
      'skipped',
    );
    expect(emitted).toHaveLength(0);
  });
});

describe('OrdersService.retryFinalAction — fresh sendGen key per retry (review BLOCKER)', () => {
  const scopeAll = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;
  const manager = { projectId: 'p1', userId: 'm1', roles: ['manager'], scope: scopeAll };
  const stages = [
    { id: 'os1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
    { id: 'os2', name: 'Sent', order: 1, requiredFieldKeys: [], isTerminal: true },
  ];
  const webhookRevision: AnyRec = {
    stages,
    fields: [],
    finalActionSpec: { type: 'webhook', config: { connection_id: 'conn-1' } },
    retryPolicy: { maxAttempts: 3 },
  };

  const makeSendErrorOrder = (): { doc: AnyRec; id: string; oldKey: string } => {
    const _id = new ObjectId();
    const id = _id.toString();
    const oldKey = `${id}:1:webhook:1:1`;
    return {
      id,
      oldKey,
      doc: {
        _id,
        projectId: 'p1',
        typeId: 't1',
        orderTypeVersion: 1,
        stageId: 'os2',
        number: '1',
        status: 'SEND_ERROR',
        assigneeId: 'u7',
        fieldsJson: '{}',
        snapshot: { contact: { name: 'Ann' } },
        finalActionState: {
          status: 'FAILED',
          payloadGen: 1,
          sendGen: 1,
          idempotencyKey: oldKey,
          lastError: 'http_503',
          attempts: [],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    };
  };

  it('SEND_ERROR → retry → successful delivery → DONE; the old key can no longer flip the order', async () => {
    const { doc, id, oldKey } = makeSendErrorOrder();
    const { service, emitted } = makeService({ existingOrder: doc, revision: webhookRevision });

    await service.retryFinalAction('p1', id, manager);

    // The retry is a NEW send generation: fresh key, old one retired.
    const newKey = `${id}:1:webhook:1:2`;
    const fas = doc.finalActionState as AnyRec;
    expect(doc.status).toBe('SENDING');
    expect(fas.sendGen).toBe(2);
    expect(fas.idempotencyKey).toBe(newKey);
    expect(newKey).not.toBe(oldKey);
    const req = emitted.find((e) => e.type === 'crm.order.final_action_requested');
    expect(req?.idempotencyKey).toBe(newKey);
    expect((req?.payload as AnyRec).idempotencyKey).toBe(newKey);

    // A stale answer for the RETIRED key is skipped — it can never resolve the retry.
    await expect(service.applyFinalActionResult('p1', id, oldKey, false)).resolves.toBe('skipped');
    expect(doc.status).toBe('SENDING');

    // The successful answer for the NEW key completes the saga: SENDING → DONE.
    await expect(
      service.applyFinalActionResult('p1', id, newKey, true, { attemptNo: 1, httpCode: 200 }),
    ).resolves.toBe('applied');
    expect(doc.status).toBe('DONE');
    expect((doc.finalActionState as AnyRec).status).toBe('SUCCEEDED');
    expect(
      emitted.some(
        (e) =>
          e.type === 'crm.order.status_changed' &&
          (e.payload as AnyRec).from === 'SENDING' &&
          (e.payload as AnyRec).to === 'DONE',
      ),
    ).toBe(true);
  });

  it('bumps sendGen independently of payloadGen (field edits) so every retry key is unique', async () => {
    const { doc, id } = makeSendErrorOrder();
    (doc.finalActionState as AnyRec).payloadGen = 3; // fields were edited in SEND_ERROR
    const { service, emitted } = makeService({ existingOrder: doc, revision: webhookRevision });
    await service.retryFinalAction('p1', id, manager);
    const req = emitted.find((e) => e.type === 'crm.order.final_action_requested');
    expect(req?.idempotencyKey).toBe(`${id}:1:webhook:3:2`);
  });

  it('rejects when a concurrent transition wins the SEND_ERROR → SENDING race (no duplicate publish)', async () => {
    const { doc, id } = makeSendErrorOrder();
    const { service, emitted } = makeService({
      existingOrder: doc,
      revision: webhookRevision,
      orderUpdateMatched: 0, // the conditional { status: 'SEND_ERROR' } update lost the race
    });
    await expect(service.retryFinalAction('p1', id, manager)).rejects.toThrow(/RETRY_NOT_ALLOWED/);
    expect(emitted).toHaveLength(0);
  });
});

describe('OrdersService.expireStaleSending — operational exit from SENDING (review MAJOR)', () => {
  const makeStuckSending = (): { doc: AnyRec; id: string; key: string } => {
    const _id = new ObjectId();
    const id = _id.toString();
    const key = `${id}:1:webhook:1:1`;
    return {
      id,
      key,
      doc: {
        _id,
        projectId: 'p1',
        typeId: 't1',
        orderTypeVersion: 1,
        stageId: 'os2',
        number: '1',
        status: 'SENDING',
        fieldsJson: '{}',
        finalActionState: { status: 'PENDING', payloadGen: 1, sendGen: 1, idempotencyKey: key },
        createdAt: 1,
        updatedAt: 1, // long in the past — stale by any budget
      },
    };
  };

  it('expires a stale SENDING order into SEND_ERROR with a readable lastError and status_changed', async () => {
    const { doc } = makeStuckSending();
    const { service, emitted } = makeService({ existingOrder: doc, staleSending: [doc] });
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(1);
    expect(doc.status).toBe('SEND_ERROR');
    const fas = doc.finalActionState as AnyRec;
    expect(fas.status).toBe('FAILED');
    expect(String(fas.lastError)).toContain('final_action_timeout');
    expect(
      emitted.some(
        (e) =>
          e.type === 'crm.order.status_changed' &&
          (e.payload as AnyRec).from === 'SENDING' &&
          (e.payload as AnyRec).to === 'SEND_ERROR',
      ),
    ).toBe(true);
    // From SEND_ERROR the user-facing RetryFinalAction path is open again —
    // SENDING always has a way out without manual DB intervention.
  });

  it('is race-safe: a second sweep (or one racing a real answer) matches nothing and expires 0', async () => {
    const { doc } = makeStuckSending();
    const { service } = makeService({ existingOrder: doc, staleSending: [doc] });
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(1);
    // Doc already left SENDING — the conditional transition skips it now.
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(0);
  });

  it('skips a LATE success answer after expiry (order already left SENDING)', async () => {
    const { doc, id, key } = makeStuckSending();
    const { service } = makeService({ existingOrder: doc, staleSending: [doc] });
    await service.expireStaleSending(15 * 60 * 1000);
    await expect(service.applyFinalActionResult('p1', id, key, true)).resolves.toBe('skipped');
    expect(doc.status).toBe('SEND_ERROR'); // surfaced as retryable, never silently flipped
  });

  it('expires nothing when there are no stale SENDING orders', async () => {
    const { service, emitted } = makeService({ staleSending: [] });
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(0);
    expect(emitted).toHaveLength(0);
  });

  // Review MINOR (legacy-doc starvation): docs written before
  // `finalActionState.idempotencyKey` existed carry the field MISSING, and in
  // Mongo `{key: ''}` does NOT match a missing field. Such a doc could never
  // leave SENDING, and since the sweep reads `sort({updatedAt:1}).limit(50)`,
  // 50+ of them would permanently occupy the head of the queue and starve every
  // younger genuinely-stuck order. The expiry filter must therefore match
  // "missing OR empty".
  const makeLegacySending = (variant: 'missing-key' | 'no-state' | 'empty-key'): AnyRec => {
    const _id = new ObjectId();
    return {
      _id,
      projectId: 'p1',
      typeId: 't1',
      orderTypeVersion: 1,
      stageId: 'os2',
      number: '1',
      status: 'SENDING',
      fieldsJson: '{}',
      ...(variant === 'no-state'
        ? {}
        : {
            finalActionState: {
              status: 'PENDING',
              payloadGen: 1,
              ...(variant === 'empty-key' ? { idempotencyKey: '' } : {}),
            },
          }),
      createdAt: 1,
      updatedAt: 1,
    };
  };

  it.each(['missing-key', 'no-state', 'empty-key'] as const)(
    'expires a LEGACY stale SENDING doc (%s) — missing key must not mean "never expires"',
    async (variant) => {
      const doc = makeLegacySending(variant);
      const { service, emitted } = makeService({ existingOrder: doc, staleSending: [doc] });
      await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(1);
      expect(doc.status).toBe('SEND_ERROR');
      expect(String((doc.finalActionState as AnyRec).lastError)).toContain('final_action_timeout');
      expect(
        emitted.some(
          (e) => e.type === 'crm.order.status_changed' && (e.payload as AnyRec).to === 'SEND_ERROR',
        ),
      ).toBe(true);
    },
  );

  it('matches a legacy doc with an $or (missing OR empty), never an equality on ""', async () => {
    const doc = makeLegacySending('missing-key');
    const { service, orderUpdates } = makeService({ existingOrder: doc, staleSending: [doc] });
    await service.expireStaleSending(15 * 60 * 1000);
    const q = orderUpdates[0].q;
    expect(q['finalActionState.idempotencyKey']).toBeUndefined();
    expect(q.$or).toEqual([
      { 'finalActionState.idempotencyKey': { $exists: false } },
      { 'finalActionState.idempotencyKey': '' },
    ]);
  });

  it('the legacy branch never flips an order that carries a real in-flight key', async () => {
    const { doc, id } = makeStuckSending();
    const { service } = makeService({ existingOrder: doc });
    // An empty expected key must stay scoped to keyless docs — a live send with
    // a real key is still owned by its own answer.
    await expect(service.applyFinalActionResult('p1', id, '', false, { error: 'x' })).resolves.toBe(
      'skipped',
    );
    expect(doc.status).toBe('SENDING');
  });

  it('legacy docs at the head of the sweep do not starve younger stuck orders', async () => {
    const legacyA = makeLegacySending('missing-key');
    const legacyB = makeLegacySending('no-state');
    const { doc: keyed } = makeStuckSending();
    // Sorted by updatedAt: the two legacy docs come first, the real one last.
    const { service } = makeService({ staleSending: [legacyA, legacyB, keyed] });
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(3);
    expect([legacyA.status, legacyB.status, keyed.status]).toEqual([
      'SEND_ERROR',
      'SEND_ERROR',
      'SEND_ERROR',
    ]);
    // Nothing is left in SENDING to occupy the head on the next tick.
    await expect(service.expireStaleSending(15 * 60 * 1000)).resolves.toBe(0);
  });
});
