import {
  BoxGatewayClient,
  BoxMongoReader,
  createOrdersGrpcClient,
  createLocalAutomationGrpcClient,
  createLocalProductGrpcClient,
  describeBoxIntegration,
  startLocalOrdersService,
  stopLocalOrdersService,
  startLocalAutomationService,
  stopLocalAutomationService,
  startLocalProductService,
  stopLocalProductService,
  ensureLocalOrdersService,
  ensureLocalAutomationService,
  uniqueBoxName,
  waitFor,
  type OrdersGrpcClient,
  type LocalAutomationGrpcClient,
} from '@fairflow/testing';

/**
 * Integration closure wave — group money (#1–#9).
 *
 * Local: orders gRPC (+ Rabbit consumers on the box stand bus).
 * Peers on the box stand: pipe, product, contact, company, search, automation (via gateway REST + bus).
 *
 * Data isolation: each test creates its own project via gateway; all mutations stay inside it.
 * Requires: BOX_INTEGRATION=1, network reachability to the box stand, built orders dist + @fairflow/testing.
 */

jest.setTimeout(180_000);

const SEARCH_WAIT_MS = 240_000;
const AUTOMATION_WAIT_MS = 120_000;

const MONEY_MODULES = [
  'contacts',
  'companies',
  'deals',
  'products',
  'orders',
  'search',
  'automation',
];

const ORDER_STAGES = [
  { id: 's1', name: 'Новая', order: 0, required_field_keys: [], is_terminal: false },
  { id: 's2', name: 'В работе', order: 1, required_field_keys: [], is_terminal: false },
  { id: 's3', name: 'Готово', order: 2, required_field_keys: [], is_terminal: true },
];

describeBoxIntegration('group-money the box stand (orders local, peers on the box stand)', () => {
  let gateway: BoxGatewayClient;
  let orders: OrdersGrpcClient;
  let mongo: BoxMongoReader;
  let projectId: string;
  const mdCtx = () => ({ projectId, userId: gateway.userId });

  beforeAll(async () => {
    await startLocalOrdersService();
    gateway = await BoxGatewayClient.login(MONEY_MODULES);
    orders = createOrdersGrpcClient();
    mongo = await BoxMongoReader.connect();
  }, 180_000);

  afterAll(async () => {
    orders.close();
    await stopLocalAutomationService();
    await stopLocalOrdersService();
    await mongo.close();
  });

  beforeEach(async () => {
    await ensureLocalOrdersService();
    projectId = await gateway.createProject(uniqueBoxName('money'), MONEY_MODULES);
  });

  afterEach(async () => {
    await gateway.archiveProject(projectId);
  });

  async function createOrderTypeViaLocal(stages = ORDER_STAGES): Promise<string> {
    const detail = await orders.createOrderType(
      {
        project_id: projectId,
        spec: {
          name: uniqueBoxName('sale-type'),
          fields: [],
          stages,
          final_action_spec_json: '',
        },
      },
      mdCtx(),
    );
    return String(detail.id ?? '');
  }

  async function createBasicOrder(over: Record<string, unknown> = {}) {
    const typeId = await createOrderTypeViaLocal();
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Buyer',
      lastName: 'Test',
      email: `${uniqueBoxName('buyer')}@example.com`,
      phone: '+79001234567',
    });
    return orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: contactId,
        assignee_id: gateway.userId,
        ...over,
      },
      mdCtx(),
    );
  }

  // ── #9 product → pipe (first: cold bus; local product + the box stand pipe consumer) ─
  it('#9: crm.product.deleted clears deal.productId on pipe deals', async () => {
    await startLocalProductService();
    const localProduct = createLocalProductGrpcClient();
    try {
      const typeId = await createOrderTypeViaLocal();
      const productId = await gateway.createProduct(projectId, {
        name: uniqueBoxName('del-product'),
        orderTypeId: typeId,
      });
      const dealId = await gateway.createDeal(projectId, {
        name: uniqueBoxName('deal-prod-del'),
      });
      await gateway.updateDeal(projectId, dealId, { productId });

      const linked = await waitFor(
        async () => {
          const doc = await mongo.findDeal(projectId, dealId);
          return doc?.productId === productId ? doc : false;
        },
        { label: 'deal.productId linked before delete', timeoutMs: 30_000 },
      );
      expect(linked?.productId).toBe(productId);

      await localProduct.deleteProduct(
        { project_id: projectId, id: productId, force: true },
        { projectId, userId: gateway.userId },
      );

      await mongo.waitForOutboxPublished(
        projectId,
        'crm.product.deleted',
        { productId },
        { timeoutMs: 60_000 },
      );

      const cleared = await waitFor(
        async () => {
          const doc = await mongo.findDeal(projectId, dealId);
          return doc?.productId === '' || doc?.productId == null ? doc : false;
        },
        { label: 'deal.productId cleared after product.deleted', timeoutMs: 90_000 },
      );
      expect(cleared?.productId).toBeFalsy();
    } finally {
      localProduct.close();
      await stopLocalProductService();
    }
  });

  // ── #6 / #7 / #9 search+automation — merge/drift tests follow ─────────────
  it('#6: crm.order search projections for created, updated and status_changed', async () => {
    const newNotes = uniqueBoxName('search-updated');
    const created = await createBasicOrder({ notes: 'before-search-update' });
    const orderId = String(created.id);

    await mongo.waitForOutboxPublished(
      projectId,
      'crm.order.created',
      { orderId },
      { timeoutMs: 90_000 },
    );

    const indexed = await mongo.waitForSearchDoc(
      projectId,
      'order',
      orderId,
      (doc) => doc.entityId === orderId,
      { label: 'search_index after crm.order.created', timeoutMs: SEARCH_WAIT_MS },
    );
    expect(indexed?.entityType).toBe('order');
    expect(String(indexed?.title ?? '')).toMatch(/^ORD-/);
    const updatedAtBefore = Number(indexed?.updatedAt ?? 0);

    await orders.updateOrder({ project_id: projectId, id: orderId, notes: newNotes }, mdCtx());
    await waitFor(
      async () => {
        const row = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
        return row.notes === newNotes ? row : false;
      },
      { label: 'order notes after UpdateOrder', timeoutMs: 30_000 },
    );

    await mongo.waitForOutboxPublished(
      projectId,
      'crm.order.updated',
      { orderId },
      { timeoutMs: 90_000 },
    );

    const afterUpdate = await mongo.waitForSearchDoc(
      projectId,
      'order',
      orderId,
      (doc) => Number(doc.updatedAt ?? 0) > updatedAtBefore,
      { label: 'search_index after crm.order.updated', timeoutMs: SEARCH_WAIT_MS },
    );
    expect(afterUpdate?.entityType).toBe('order');

    await orders.cancelOrder(
      { project_id: projectId, id: orderId, reason: 'search status test', user_id: gateway.userId },
      mdCtx(),
    );

    await mongo.waitForOutboxPublished(
      projectId,
      'crm.order.status_changed',
      { orderId },
      { timeoutMs: 90_000 },
    );

    const afterCancel = await mongo.waitForSearchDoc(
      projectId,
      'order',
      orderId,
      (doc) => doc.subtitle === 'CANCELLED',
      { label: 'search_index after crm.order.status_changed', timeoutMs: SEARCH_WAIT_MS },
    );
    expect(afterCancel?.subtitle).toBe('CANCELLED');
  }, 900_000);

  it('#9: crm.product.deleted tombstones product in search_index', async () => {
    const typeId = await createOrderTypeViaLocal();
    const productName = uniqueBoxName('search-del-product');
    const productId = await gateway.createProduct(projectId, {
      name: productName,
      orderTypeId: typeId,
    });

    const indexed = await mongo.waitForSearchDoc(
      projectId,
      'product',
      productId,
      (doc) => doc.deletedAt == null,
      { label: 'search_index product before hard delete', timeoutMs: SEARCH_WAIT_MS },
    );
    expect(indexed?.entityType).toBe('product');

    await gateway.deleteProduct(projectId, productId, { force: true });

    await mongo.waitForSearchAfterOutbox(
      projectId,
      'crm.product.deleted',
      {
        productId,
        searchFallback: {
          entityType: 'product',
          entityId: productId,
          ready: (doc) => doc.deletedAt != null && doc.deletedAt !== 0,
        },
      },
      { timeoutMs: SEARCH_WAIT_MS },
    );

    const tombstone = await mongo.findSearchDoc(projectId, 'product', productId);
    expect(tombstone?.entityType).toBe('product');
    expect(tombstone?.deletedAt).toEqual(expect.any(Number));
  }, 900_000);

  // ── #7 orders → automation: crm.order.status_changed trigger ──────────────
  it('#7: crm.order.status_changed fires automation rule on cancel', async () => {
    const ruleId = await gateway.createAutomationRule(projectId, {
      name: uniqueBoxName('on-cancel'),
      triggerType: 'crm.order.status_changed',
      triggerConfig: {},
      actions: [
        {
          id: 'send_notification',
          config: { userId: gateway.userId, body: 'order cancelled by rule' },
        },
      ],
    });
    const created = await createBasicOrder();
    const orderId = String(created.id);

    await orders.cancelOrder(
      { project_id: projectId, id: orderId, reason: 'intclosure test', user_id: gateway.userId },
      mdCtx(),
    );

    const executions = await mongo.waitForAutomationExecution(projectId, ruleId, {
      routingKey: 'crm.order.status_changed',
      match: { orderId },
      timeoutMs: AUTOMATION_WAIT_MS,
    });
    expect(executions[0]?.rule_id).toBe(ruleId);
    expect(executions[0]?.status).not.toBe('skipped');
  });

  // ── #1 pipe → orders: crm.deal.won → auto-create sale ─────────────────────
  it('#1: crm.deal.won auto-creates a sale when product has a sale-type', async () => {
    const typeId = await createOrderTypeViaLocal(ORDER_STAGES);
    const productId = await gateway.createProduct(projectId, {
      name: uniqueBoxName('won-product'),
      orderTypeId: typeId,
      price: 2500,
    });
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Won',
      lastName: 'Buyer',
      email: `${uniqueBoxName('won')}@example.com`,
    });
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('won-deal'),
      contactId,
      assigneeId: gateway.userId,
    });
    await gateway.updateDeal(projectId, dealId, { productId });

    await gateway.closeDeal(projectId, dealId, 'won');

    const orderDoc = await waitFor(
      async () => {
        const doc = await mongo.findOrderByDealId(projectId, dealId);
        return doc?.dealId === dealId ? doc : false;
      },
      { label: 'auto-created order after crm.deal.won', timeoutMs: 60_000 },
    );
    expect(orderDoc?.productId).toBe(productId);
    expect(orderDoc?.contactId).toBe(contactId);
    expect(orderDoc?.typeId ?? orderDoc?.orderTypeId).toBe(typeId);
  });

  // ── #2 orders → product: GetProduct on createOrder ────────────────────────
  it('#2: createOrder resolves product price and sale-type via live ProductGrpc', async () => {
    const typeId = await createOrderTypeViaLocal();
    const productId = await gateway.createProduct(projectId, {
      name: uniqueBoxName('priced-product'),
      orderTypeId: typeId,
      price: 4321,
      currency: 'RUB',
    });
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Price',
      lastName: 'Check',
      email: `${uniqueBoxName('price')}@example.com`,
    });

    const created = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        product_id: productId,
        contact_id: contactId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );

    expect(created.product_id).toBe(productId);
    expect(created.type_id).toBe(typeId);
    expect(Number(created.product_price)).toBe(4321);
    expect(created.product_currency).toBe('RUB');
  });

  // ── #3 contact → orders: crm.contact.merged → rewrite contactId + drift ─
  it('#3: crm.contact.merged rewrites order contactId and marks drift', async () => {
    const sourceId = await gateway.createContact(projectId, {
      firstName: 'Merge',
      lastName: 'Source',
      email: `${uniqueBoxName('m-src')}@example.com`,
      phone: '+79001112233',
    });
    const targetId = await gateway.createContact(projectId, {
      firstName: 'Merge',
      lastName: 'Target',
      email: `${uniqueBoxName('m-tgt')}@example.com`,
      phone: '+79004445566',
    });
    const typeId = await createOrderTypeViaLocal();
    const order = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: sourceId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );
    const orderId = String(order.id);

    await gateway.mergeContacts(projectId, sourceId, targetId);

    const stored = await waitFor(
      async () => {
        const doc = await mongo.findOrder(projectId, orderId);
        return doc?.contactId === targetId && doc?.hasDrift === true ? doc : false;
      },
      {
        label: 'order contactId rewritten and drift marked after contact.merged',
        timeoutMs: 60_000,
      },
    );
    expect(stored?.contactId).toBe(targetId);
    expect(stored?.hasDrift).toBe(true);
  });

  // ── #4 company → orders: crm.company.merged → rewrite companyId + drift ──
  it('#4: crm.company.merged rewrites order companyId and marks drift', async () => {
    const masterId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-master'),
      inn: '7700000201',
    });
    const loserId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('co-loser'),
      inn: '7700000202',
    });
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Co',
      lastName: 'Buyer',
      email: `${uniqueBoxName('co-buy')}@example.com`,
    });
    const typeId = await createOrderTypeViaLocal();
    const order = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: contactId,
        company_id: loserId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );
    const orderId = String(order.id);

    await gateway.mergeCompanies(projectId, masterId, loserId);

    const stored = await waitFor(
      async () => {
        const doc = await mongo.findOrder(projectId, orderId);
        return doc?.companyId === masterId && doc?.hasDrift === true ? doc : false;
      },
      {
        label: 'order companyId rewritten and drift marked after company.merged',
        timeoutMs: 60_000,
      },
    );
    expect(stored?.companyId).toBe(masterId);
    expect(stored?.hasDrift).toBe(true);
  });

  // ── #5 orders → contact/company/pipe: live Get* for snapshot / drift ──────
  it('#5: live contact update triggers order drift via GetContact snapshot', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('Drift Co'),
      inn: '7700000203',
    });
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Drift',
      lastName: 'Before',
      email: `${uniqueBoxName('drift')}@example.com`,
      phone: '+79005556677',
    });
    const dealId = await gateway.createDeal(projectId, {
      name: uniqueBoxName('drift-deal'),
      contactId,
      companyId,
    });
    const typeId = await createOrderTypeViaLocal();
    const order = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: contactId,
        company_id: companyId,
        deal_id: dealId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );
    const orderId = String(order.id);

    const before = await orders.checkDrift({ project_id: projectId, id: orderId }, mdCtx());
    expect(before.has_drift).toBe(false);

    const liveOrder = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
    expect(String(liveOrder.deal_id ?? '')).toBe(dealId);

    await gateway.updateContact(projectId, contactId, {
      firstName: 'Drift',
      lastName: 'After',
    });

    const drift = await waitFor(
      async () => {
        const res = await orders.checkDrift({ project_id: projectId, id: orderId }, mdCtx());
        return res.has_drift ? res : false;
      },
      { label: 'order drift after live contact update', timeoutMs: 60_000 },
    );
    expect(drift.has_drift).toBe(true);
  });

  it('#5: live company update triggers order drift via GetCompany snapshot', async () => {
    const companyId = await gateway.createCompany(projectId, {
      name: uniqueBoxName('Drift Co Before'),
      inn: '7700000204',
    });
    const contactId = await gateway.createContact(projectId, {
      firstName: 'CoDrift',
      lastName: 'Buyer',
      email: `${uniqueBoxName('co-drift')}@example.com`,
    });
    const typeId = await createOrderTypeViaLocal();
    const order = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: contactId,
        company_id: companyId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );
    const orderId = String(order.id);

    const before = await orders.checkDrift({ project_id: projectId, id: orderId }, mdCtx());
    expect(before.has_drift).toBe(false);

    await gateway.updateCompany(projectId, companyId, {
      name: uniqueBoxName('Drift Co After'),
    });

    const drift = await waitFor(
      async () => {
        const res = await orders.checkDrift({ project_id: projectId, id: orderId }, mdCtx());
        return res.has_drift ? res : false;
      },
      { label: 'order drift after live company update', timeoutMs: 60_000 },
    );
    expect(drift.has_drift).toBe(true);
  });

  it('#5: resolveDocumentVariables reads deal.name via live GetDeal on pipe', async () => {
    const dealNameBefore = uniqueBoxName('deal-before');
    const dealNameAfter = uniqueBoxName('deal-after');
    const contactId = await gateway.createContact(projectId, {
      firstName: 'Deal',
      lastName: 'Reader',
      email: `${uniqueBoxName('deal-read')}@example.com`,
    });
    const dealId = await gateway.createDeal(projectId, {
      name: dealNameBefore,
      contactId,
    });
    const typeId = await createOrderTypeViaLocal();
    const order = await orders.createOrder(
      {
        project_id: projectId,
        order_type_id: typeId,
        contact_id: contactId,
        deal_id: dealId,
        assignee_id: gateway.userId,
      },
      mdCtx(),
    );
    const orderId = String(order.id);

    const before = await orders.resolveDocumentVariables(
      { project_id: projectId, record_id: orderId },
      mdCtx(),
    );
    const valuesBefore = (before.values ?? {}) as Record<string, string>;
    expect(valuesBefore['deal.name']).toBe(dealNameBefore);

    await gateway.updateDeal(projectId, dealId, { name: dealNameAfter });

    const after = await orders.resolveDocumentVariables(
      { project_id: projectId, record_id: orderId },
      mdCtx(),
    );
    const valuesAfter = (after.values ?? {}) as Record<string, string>;
    expect(valuesAfter['deal.name']).toBe(dealNameAfter);
  });

  // ── #8 automation → orders: GetOrder / UpdateOrder / MoveOrderToStage ───────
  // Local automation (monorepo protos) + local orders; the box stand automation image
  // still lacks orders.proto (see REPORT — deployment regression).
  describe('#8 automation → orders via local automation gRPC', () => {
    let localAutomation: LocalAutomationGrpcClient;

    beforeAll(async () => {
      await startLocalAutomationService();
      localAutomation = createLocalAutomationGrpcClient();
    }, 180_000);

    afterAll(async () => {
      localAutomation?.close();
      await stopLocalAutomationService();
    });

    beforeEach(async () => {
      await ensureLocalAutomationService();
      if (!localAutomation) {
        localAutomation = createLocalAutomationGrpcClient();
      }
    }, 180_000);

    it('#8: automation GetOrder via manualRun entity snapshot', async () => {
      const created = await createBasicOrder({ notes: 'before-automation-read' });
      const orderId = String(created.id);

      const ruleId = await gateway.createAutomationRule(projectId, {
        name: uniqueBoxName('get-order'),
        triggerType: 'crm.order.status_changed',
        triggerConfig: {},
        actions: [
          {
            id: 'send_notification',
            config: { userId: gateway.userId, body: 'order snapshot read ok' },
          },
        ],
      });

      const exec = await localAutomation.manualRun(
        {
          project_id: projectId,
          rule_id: ruleId,
          entity_type: 'order',
          entity_id: orderId,
          user_id: gateway.userId,
        },
        mdCtx(),
      );
      expect(exec.status).toBe('success');
    });

    it('#8: automation update_field mutates order via UpdateOrder gRPC', async () => {
      const created = await createBasicOrder({ notes: 'before-automation' });
      const orderId = String(created.id);

      const ruleId = await gateway.createAutomationRule(projectId, {
        name: uniqueBoxName('update-order'),
        triggerType: 'crm.order.status_changed',
        triggerConfig: {},
        actions: [
          {
            id: 'update_field',
            config: { field: 'notes', value: 'automation-updated' },
          },
        ],
      });

      const exec = await localAutomation.executeRule(
        {
          project_id: projectId,
          rule_id: ruleId,
          source: 'intclosure-money-test',
          payload_json: JSON.stringify({ order_id: orderId, orderId }),
        },
        mdCtx(),
      );
      expect(exec.status).toBe('success');

      const live = await waitFor(
        async () => {
          const row = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
          return row.notes === 'automation-updated' ? row : false;
        },
        { label: 'automation UpdateOrder via executeRule', timeoutMs: 30_000 },
      );
      expect(live.notes).toBe('automation-updated');
    });

    it('#8: automation move_stage moves order via MoveOrderToStage gRPC', async () => {
      const created = await createBasicOrder();
      const orderId = String(created.id);
      const before = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
      expect(String(before.stage_id ?? '')).toBe('s1');

      const ruleId = await gateway.createAutomationRule(projectId, {
        name: uniqueBoxName('move-order'),
        triggerType: 'crm.order.status_changed',
        triggerConfig: {},
        actions: [{ id: 'move_stage', config: { stage: 's2' } }],
      });

      const exec = await localAutomation.executeRule(
        {
          project_id: projectId,
          rule_id: ruleId,
          source: 'intclosure-money-test',
          payload_json: JSON.stringify({ order_id: orderId, orderId }),
        },
        mdCtx(),
      );
      expect(exec.status).toBe('success');

      const moved = await waitFor(
        async () => {
          const row = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
          return row.stage_id === 's2' ? row : false;
        },
        { label: 'automation MoveOrderToStage via executeRule', timeoutMs: 30_000 },
      );
      expect(moved.stage_id).toBe('s2');
    });
  });
});
