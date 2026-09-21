import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import type { SourceRead } from './order-drift';

function makeDocService(hasDrift: boolean) {
  const emitted: EmitIntent[] = [];
  const orderId = '507f1f77bcf86cd799439011';
  const existingOrder = {
    _id: { toString: () => orderId },
    number: 'ORD-00001',
    typeId: 't1',
    status: 'ACTIVE',
    stageId: 'os1',
    orderTypeVersion: 1,
    fieldsJson: '{}',
    contactId: 'c1',
    hasDrift,
    snapshot: { contact: { name: 'Ivan', phone: '', email: '' }, company: {} },
    finalActionState: { status: 'IDLE', payloadGen: 1, sendGen: 1, attempts: [] },
  };
  const mongo = {
    orderTypes: () => ({
      find: () => ({ toArray: async () => [] }),
      findOne: async () => ({
        id: 't1',
        name: 'Sale',
        currentVersion: 1,
        stages: [{ id: 'os1', name: 'New', order: 0 }],
        fields: [],
      }),
    }),
    orderTypeRevisions: () => ({
      findOne: async () => ({ fields: [] }),
      insertOne: async () => ({}),
    }),
    orders: () => ({
      findOne: async () => existingOrder,
      insertOne: async () => ({}),
      find: () => ({
        sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
        toArray: async () => [],
      }),
      updateOne: async () => ({ modifiedCount: 1, matchedCount: 1 }),
    }),
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
    readContact: async (): Promise<SourceRead> => ({
      state: 'present',
      fields: {
        name: hasDrift ? 'Petr' : 'Ivan',
        phone: '',
        email: '',
      },
    }),
    readCompany: async (): Promise<SourceRead> => ({ state: 'unknown', fields: {} }),
    readDealName: async () => 'Deal 1',
    readProductSaleType: async () => null,
  } as unknown as ConstructorParameters<typeof OrdersService>[2];
  const metrics = {
    recordDriftGate: jest.fn(),
    recordFinalAction: jest.fn(),
  };
  const service = new OrdersService(
    mongo,
    outbox,
    sourceReader,
    noopSpecValidator,
    metrics as never,
  );
  return { service, emitted, metrics };
}

describe('OrdersService.requestOrderDocument (FR-ORDERS-255)', () => {
  const orderId = '507f1f77bcf86cd799439011';
  const scope = {
    mode: 'all',
    ownerIds: [],
    sharedRecordIds: [],
  } as unknown as VisibilityScope;

  it('emits crm.order.document_requested when drift gate passes', async () => {
    const { service, emitted } = makeDocService(false);
    const res = await service.requestOrderDocument('p1', orderId, 'tpl-1', false, scope);
    expect(res.values['order.number']).toBe('ORD-00001');
    const evt = emitted.find((e) => e.type === 'crm.order.document_requested');
    expect(evt?.payload).toMatchObject({
      orderId,
      templateId: 'tpl-1',
    });
  });

  it('blocks generation when drift is present and acceptDrift is false', async () => {
    const { service, metrics } = makeDocService(true);
    await expect(
      service.requestOrderDocument('p1', orderId, 'tpl-1', false, scope),
    ).rejects.toBeInstanceOf(RpcException);
    expect(metrics.recordDriftGate).toHaveBeenCalledWith('document', 'blocked');
    try {
      await service.requestOrderDocument('p1', orderId, 'tpl-1', false, scope);
    } catch (err) {
      const e = (err as RpcException).getError() as { code?: number; message?: string };
      expect(e.code).toBe(status.FAILED_PRECONDITION);
      expect(JSON.parse(String(e.message))).toMatchObject({ code: 'DRIFT_NOT_ACCEPTED' });
    }
  });

  it('emits document_requested when drift is present and acceptDrift is true', async () => {
    const { service, emitted, metrics } = makeDocService(true);
    const res = await service.requestOrderDocument('p1', orderId, 'tpl-1', true, scope);
    expect(res.values['order.number']).toBe('ORD-00001');
    expect(emitted.find((e) => e.type === 'crm.order.document_requested')).toBeDefined();
    expect(metrics.recordDriftGate).toHaveBeenCalledWith('document', 'passed');
  });
});
