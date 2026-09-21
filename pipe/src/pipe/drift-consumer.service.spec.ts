import { ObjectId } from 'mongodb';
import {
  COMPANY_UPDATED_KEY,
  CONTACT_UPDATED_KEY,
  DriftConsumerService,
} from './drift-consumer.service';

describe('DriftConsumerService runtime', () => {
  const handle = (
    svc: DriftConsumerService,
    payload: Record<string, unknown>,
    routingKey: string,
  ) =>
    (svc as unknown as { handle(p: Record<string, unknown>, k: string): Promise<void> }).handle(
      payload,
      routingKey,
    );

  it('skips events without projectId instead of touching deals', async () => {
    const updateOne = jest.fn();
    const svc = new DriftConsumerService(
      {
        deals: () => ({ find: jest.fn(), updateOne }),
        driftInbox: () => ({ findOne: jest.fn(), insertOne: jest.fn() }),
      } as never,
      { consume: jest.fn() } as never,
    );
    await handle(svc, { messageId: 'm1', payload: { contactId: 'c1' } }, CONTACT_UPDATED_KEY);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('short-circuits duplicate messageId deliveries', async () => {
    const findOne = jest.fn().mockResolvedValue({ messageId: 'dup-1' });
    const updateOne = jest.fn();
    const svc = new DriftConsumerService(
      {
        deals: () => ({ find: jest.fn(), updateOne }),
        driftInbox: () => ({ findOne, insertOne: jest.fn() }),
      } as never,
      { consume: jest.fn() } as never,
    );
    await handle(
      svc,
      { projectId: 'p1', messageId: 'dup-1', payload: { contactId: 'c1', changes: [] } },
      CONTACT_UPDATED_KEY,
    );
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('persists contact drift on open deals and records the inbox row', async () => {
    const dealId = new ObjectId();
    const updateOne = jest.fn().mockResolvedValue({});
    const insertOne = jest.fn().mockResolvedValue({});
    const find = jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue([
        {
          _id: dealId,
          projectId: 'p1',
          contactSnapshot: { phone: '+79990000000' },
        },
      ]),
    }));
    const svc = new DriftConsumerService(
      {
        deals: () => ({ find, updateOne }),
        driftInbox: () => ({ findOne: jest.fn().mockResolvedValue(null), insertOne }),
      } as never,
      { consume: jest.fn() } as never,
    );
    await handle(
      svc,
      {
        projectId: 'p1',
        messageId: 'm-contact',
        userId: 'u1',
        payload: {
          contactId: 'c1',
          changes: [{ field: 'phone', newValue: '+79991111111', changedBy: 'u1', changedAt: 1 }],
        },
      },
      CONTACT_UPDATED_KEY,
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: dealId, projectId: 'p1' },
      expect.objectContaining({
        $set: expect.objectContaining({ driftFlag: true }),
        $addToSet: { driftFields: { $each: ['phone'] } },
      }),
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm-contact', routingKey: CONTACT_UPDATED_KEY }),
    );
  });

  it('persists company drift using company.updated payload shape', async () => {
    const dealId = new ObjectId();
    const updateOne = jest.fn().mockResolvedValue({});
    const insertOne = jest.fn().mockResolvedValue({});
    const find = jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue([
        {
          _id: dealId,
          projectId: 'p1',
          companySnapshot: { name: 'Old LLC' },
        },
      ]),
    }));
    const svc = new DriftConsumerService(
      {
        deals: () => ({ find, updateOne }),
        driftInbox: () => ({ findOne: jest.fn().mockResolvedValue(null), insertOne }),
      } as never,
      { consume: jest.fn() } as never,
    );
    await handle(
      svc,
      {
        projectId: 'p1',
        messageId: 'm-company',
        userId: 'u2',
        payload: {
          companyId: 'co1',
          changedFields: [{ field: 'name', old: 'Old LLC', new: 'New LLC' }],
        },
      },
      COMPANY_UPDATED_KEY,
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: dealId, projectId: 'p1' },
      expect.objectContaining({
        $addToSet: { driftFields: { $each: ['company.name'] } },
      }),
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm-company', routingKey: COMPANY_UPDATED_KEY }),
    );
  });
});
