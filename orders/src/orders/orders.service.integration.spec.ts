import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { VisibilityScope } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { OrdersService } from './orders.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { noopSpecValidator } from './test-helpers';
import type { SourceRead } from './order-drift';
import {
  FINAL_ACTION_FAILED_KEY,
  FINAL_ACTION_SUCCEEDED_KEY,
  FinalActionResultConsumer,
} from './final-action-result.consumer';
import { SourceDriftConsumer } from './source-drift.consumer';

/**
 * Orders integration spec (wave orders-lifecycle) — real Mongo edition.
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set. Exercises
 * OrdersService + transactional outbox + the thin consumers that delegate into it
 * (final-action result, source-drift) against a throwaway `qa_infra_*` database —
 * not mocked at every layer.
 *
 * Covers the full BOX chain:
 *  - order create → terminal move with final action → SENDING + outbox events;
 *  - automation answer via FinalActionResultConsumer → DONE / SEND_ERROR;
 *  - drift gate (checkDrift persistence, moveOrder terminal gate, markSourceDrift);
 *  - document generation trigger (`requestOrderDocument` → `crm.order.document_requested`).
 */

interface OrdersMongoAdapter {
  orders: () => ReturnType<Db['collection']>;
  orderTypes: () => ReturnType<Db['collection']>;
  orderTypeRevisions: () => ReturnType<Db['collection']>;
  orderCounters: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  nextOrderNumber: (projectId: string) => Promise<number>;
  getClient: () => MongoClient;
}

const ALL_SCOPE = {
  mode: 'all' as const,
  level: 'all' as const,
  selfId: 'u-1',
  ownerIds: [] as string[],
  sharedRecordIds: [] as string[],
} as unknown as VisibilityScope;

const STAGES = [
  { id: 'os1', name: 'Новая', order: 0, requiredFieldKeys: [], isTerminal: false },
  { id: 'os2', name: 'Отправка', order: 1, requiredFieldKeys: [], isTerminal: true },
];

const WEBHOOK_FINAL_ACTION = JSON.stringify({
  type: 'webhook',
  config: { connection_id: 'conn-test-1' },
});

/** Controllable gRPC-free source reader for integration runs. */
class ControllableSourceReader {
  private contacts = new Map<string, SourceRead>();
  private companies = new Map<string, SourceRead>();

  setContact(projectId: string, contactId: string, read: SourceRead): void {
    this.contacts.set(`${projectId}:${contactId}`, read);
  }

  setCompany(projectId: string, companyId: string, read: SourceRead): void {
    this.companies.set(`${projectId}:${companyId}`, read);
  }

  async readContact(projectId: string, contactId: string): Promise<SourceRead> {
    return this.contacts.get(`${projectId}:${contactId}`) ?? { state: 'unknown', fields: {} };
  }

  async readCompany(projectId: string, companyId: string): Promise<SourceRead> {
    return this.companies.get(`${projectId}:${companyId}`) ?? { state: 'unknown', fields: {} };
  }

  async readDealName(): Promise<string> {
    return '';
  }

  async readProductSaleType(): Promise<null> {
    return null;
  }

  async readProductForOrder(): Promise<null> {
    return null;
  }
}

jest.setTimeout(30_000);

describeMongoIntegration('orders integration (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: OrdersMongoAdapter;
  let outbox: MongoOutboxStore;
  let sourceReader: ControllableSourceReader;
  let service: OrdersService;
  let finalActionConsumer: FinalActionResultConsumer;
  let sourceDriftConsumer: SourceDriftConsumer;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('orders');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    mongo = {
      orders: () => db.collection('crm_orders'),
      orderTypes: () => db.collection('crm_order_types'),
      orderTypeRevisions: () => db.collection('crm_order_type_revisions'),
      orderCounters: () => db.collection('crm_order_counters'),
      outbox: () => db.collection('crm_event_outbox'),
      nextOrderNumber: async (projectId: string) => {
        const doc = await db
          .collection('crm_order_counters')
          .findOneAndUpdate(
            { _id: projectId as never },
            { $inc: { seq: 1 } },
            { upsert: true, returnDocument: 'after' },
          );
        return (doc as { seq?: number } | null)?.seq ?? 1;
      },
      getClient: () => client,
    };
    outbox = new MongoOutboxStore(mongo as never);
    sourceReader = new ControllableSourceReader();
    service = new OrdersService(mongo as never, outbox, sourceReader as never, noopSpecValidator);
    finalActionConsumer = new FinalActionResultConsumer({ consume: jest.fn() } as never, service);
    sourceDriftConsumer = new SourceDriftConsumer(service, { consume: jest.fn() } as never);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function outboxTypes(projectId: string): Promise<string[]> {
    const rows = await mongo.outbox().find({ projectId }).sort({ createdAt: 1 }).toArray();
    return rows.map((r) => (r as unknown as { routingKey: string }).routingKey);
  }

  async function freshProject(): Promise<{ projectId: string; typeId: string }> {
    const projectId = id('proj');
    const ot = await service.createOrderType(
      projectId,
      {
        name: `Тип ${projectId}`,
        stages: STAGES,
        fields: [],
        final_action_spec_json: WEBHOOK_FINAL_ACTION,
      },
      'u-1',
    );
    return { projectId, typeId: ot.id };
  }

  async function makeOrder(
    projectId: string,
    contactId = 'c1',
    over: Record<string, unknown> = {},
  ) {
    sourceReader.setContact(projectId, contactId, {
      state: 'present',
      fields: { name: 'Ann', phone: '+7000', email: 'a@x.ru' },
    });
    return service.createOrder(
      {
        assignee_id: 'u-1',
        contact_id: contactId,
        ...over,
      },
      { projectId, userId: 'u-1', scope: ALL_SCOPE },
    );
  }

  async function rawOrder(projectId: string, orderId: string) {
    return mongo.orders().findOne({ _id: new ObjectId(orderId), projectId });
  }

  // ── final-action lifecycle end-to-end ────────────────────────────────────
  describe('terminal move → SENDING → automation answer', () => {
    it('creates an order, moves to terminal stage and writes final_action_requested to outbox', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId);
      expect(order.status).toBe('ACTIVE');
      expect(order.stage_id).toBe('os1');

      await service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, [
        'orders',
        'automation',
      ]);

      const stored = await service.getOrder(projectId, order.id, ALL_SCOPE);
      expect(stored.status).toBe('SENDING');
      expect(stored.stage_id).toBe('os2');
      const keys = await outboxTypes(projectId);
      expect(keys).toContain('crm.order.stage_changed');
      expect(keys).toContain('crm.order.status_changed');
      expect(keys).toContain('crm.order.final_action_requested');
    });

    it('FinalActionResultConsumer closes SENDING → DONE on success answer', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId);
      await service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, [
        'orders',
        'automation',
      ]);
      const raw = await rawOrder(projectId, order.id);
      const idemKey = String(
        (raw?.finalActionState as { idempotencyKey?: string })?.idempotencyKey ?? '',
      );
      expect(idemKey).toBeTruthy();

      const outcome = await finalActionConsumer.handle(
        {
          projectId,
          messageId: 'm-ok',
          payload: { orderId: order.id, idempotencyKey: idemKey, attemptNo: 1, durationMs: 12 },
        },
        FINAL_ACTION_SUCCEEDED_KEY,
      );
      expect(outcome).toBe('applied');

      const after = await service.getOrder(projectId, order.id, ALL_SCOPE);
      expect(after.status).toBe('DONE');
      expect(await outboxTypes(projectId)).toContain('crm.order.status_changed');
    });

    it('duplicate success answer is idempotent (skipped, order stays DONE)', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId);
      await service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, [
        'orders',
        'automation',
      ]);
      const raw = await rawOrder(projectId, order.id);
      const idemKey = String(
        (raw?.finalActionState as { idempotencyKey?: string })?.idempotencyKey ?? '',
      );
      await finalActionConsumer.handle(
        {
          projectId,
          payload: { orderId: order.id, idempotencyKey: idemKey },
        },
        FINAL_ACTION_SUCCEEDED_KEY,
      );
      const rowsBefore = await mongo.outbox().countDocuments({ projectId });
      expect(
        await finalActionConsumer.handle(
          {
            projectId,
            payload: { orderId: order.id, idempotencyKey: idemKey },
          },
          FINAL_ACTION_SUCCEEDED_KEY,
        ),
      ).toBe('skipped');
      const rowsAfter = await mongo.outbox().countDocuments({ projectId });
      expect(rowsAfter).toBe(rowsBefore);
    });

    it('FinalActionResultConsumer closes SENDING → SEND_ERROR on failed answer', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId);
      await service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, [
        'orders',
        'automation',
      ]);
      const raw = await rawOrder(projectId, order.id);
      const idemKey = String(
        (raw?.finalActionState as { idempotencyKey?: string })?.idempotencyKey ?? '',
      );

      expect(
        await finalActionConsumer.handle(
          {
            projectId,
            payload: {
              orderId: order.id,
              idempotencyKey: idemKey,
              error: 'upstream 502',
              httpCode: 502,
              attemptNo: 2,
            },
          },
          FINAL_ACTION_FAILED_KEY,
        ),
      ).toBe('applied');

      const after = await service.getOrder(projectId, order.id, ALL_SCOPE);
      expect(after.status).toBe('SEND_ERROR');
      const doc = await rawOrder(projectId, order.id);
      const fas = doc?.finalActionState as {
        status?: string;
        lastError?: string;
        attempts?: unknown[];
      };
      expect(fas.status).toBe('FAILED');
      expect(fas.lastError).toContain('502');
      expect(Array.isArray(fas.attempts)).toBe(true);
      expect(fas.attempts?.length).toBeGreaterThan(0);
    });
  });

  // ── drift gate (real Mongo + controllable donor reads) ───────────────────
  describe('drift gate and reactive marking', () => {
    it('checkDrift persists hasDrift when the live contact diverges', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-drift');
      const res = await service.checkDrift(projectId, order.id, ALL_SCOPE);
      expect(res.has_drift).toBe(false);

      sourceReader.setContact(projectId, 'c-drift', {
        state: 'present',
        fields: { name: 'CHANGED', phone: '+7000', email: 'a@x.ru' },
      });
      const after = await service.checkDrift(projectId, order.id, ALL_SCOPE);
      expect(after.has_drift).toBe(true);
      const doc = await rawOrder(projectId, order.id);
      expect(doc?.hasDrift).toBe(true);
    });

    it('moveOrder blocks terminal transition when drift is present', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-block');
      sourceReader.setContact(projectId, 'c-block', {
        state: 'present',
        fields: { name: 'CHANGED', phone: '+7000', email: 'a@x.ru' },
      });
      await expect(
        service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, ['orders', 'automation']),
      ).rejects.toBeInstanceOf(RpcException);
      try {
        await service.moveOrder(projectId, order.id, 'os2', false, ALL_SCOPE, [
          'orders',
          'automation',
        ]);
      } catch (err) {
        const e = (err as RpcException).getError() as { code?: number; message?: string };
        expect(e.code).toBe(status.FAILED_PRECONDITION);
        expect(JSON.parse(String(e.message))).toMatchObject({ code: 'DRIFT_NOT_ACCEPTED' });
      }
      const doc = await rawOrder(projectId, order.id);
      expect(doc?.status).toBe('ACTIVE');
      expect((await outboxTypes(projectId)).includes('crm.order.final_action_requested')).toBe(
        false,
      );
    });

    it('accept_drift lets the terminal move through to SENDING', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-accept');
      sourceReader.setContact(projectId, 'c-accept', {
        state: 'present',
        fields: { name: 'CHANGED', phone: '+7000', email: 'a@x.ru' },
      });
      await service.moveOrder(projectId, order.id, 'os2', true, ALL_SCOPE, [
        'orders',
        'automation',
      ]);
      const stored = await service.getOrder(projectId, order.id, ALL_SCOPE);
      expect(stored.status).toBe('SENDING');
      expect(await outboxTypes(projectId)).toContain('crm.order.final_action_requested');
    });

    it('SourceDriftConsumer marks linked orders when crm.contact.updated fires', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-react');
      sourceReader.setContact(projectId, 'c-react', {
        state: 'present',
        fields: { name: 'Fresh Name', phone: '+7999', email: 'new@x.ru' },
      });
      const outcome = await sourceDriftConsumer.handle(
        {
          projectId,
          subject: 'contact/c-react',
          payload: { contactId: 'c-react' },
        },
        'crm.contact.updated',
      );
      expect(outcome).toBe('marked');
      const doc = await rawOrder(projectId, order.id);
      expect(doc?.hasDrift).toBe(true);
    });
  });

  // ── document generation trigger ─────────────────────────────────────────
  describe('requestOrderDocument (FR-ORDERS-255)', () => {
    it('emits crm.order.document_requested when drift gate passes', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId);
      const vars = await service.requestOrderDocument(
        projectId,
        order.id,
        'tpl-contract',
        false,
        ALL_SCOPE,
      );
      expect(vars.values['order.number']).toMatch(/^ORD-/);
      expect(await outboxTypes(projectId)).toContain('crm.order.document_requested');
    });

    it('blocks document generation when drift is present and acceptDrift is false', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-doc');
      sourceReader.setContact(projectId, 'c-doc', {
        state: 'present',
        fields: { name: 'CHANGED', phone: '+7000', email: 'a@x.ru' },
      });
      await service.checkDrift(projectId, order.id, ALL_SCOPE);
      await expect(
        service.requestOrderDocument(projectId, order.id, 'tpl-contract', false, ALL_SCOPE),
      ).rejects.toBeInstanceOf(RpcException);
      expect((await outboxTypes(projectId)).includes('crm.order.document_requested')).toBe(false);
    });

    it('emits document_requested when acceptDrift overrides drift', async () => {
      const { projectId } = await freshProject();
      const order = await makeOrder(projectId, 'c-doc-ok');
      sourceReader.setContact(projectId, 'c-doc-ok', {
        state: 'present',
        fields: { name: 'CHANGED', phone: '+7000', email: 'a@x.ru' },
      });
      await service.checkDrift(projectId, order.id, ALL_SCOPE);
      await service.requestOrderDocument(projectId, order.id, 'tpl-contract', true, ALL_SCOPE);
      expect(await outboxTypes(projectId)).toContain('crm.order.document_requested');
    });
  });

  // ── project isolation ─────────────────────────────────────────────────────
  describe('project-id isolation (Mongo)', () => {
    it('a foreign project cannot read another tenant order', async () => {
      const a = await freshProject();
      const b = await freshProject();
      const orderA = await makeOrder(a.projectId, 'c-a', { name: 'Secret A' });

      await expect(service.getOrder(b.projectId, orderA.id, ALL_SCOPE)).rejects.toMatchObject({
        error: { code: status.NOT_FOUND },
      });
      const untouched = await service.getOrder(a.projectId, orderA.id, ALL_SCOPE);
      expect(untouched.id).toBe(orderA.id);
    });
  });
});
