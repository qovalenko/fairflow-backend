import { EntitySourceConsumerService } from './entity-source.consumer';
import type { MongoService } from '../mongo/mongo.service';
import type { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

function make() {
  const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });
  const deals = jest.fn().mockReturnValue({ updateMany });
  const mongo = { deals } as unknown as MongoService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  const consumer = new EntitySourceConsumerService(mongo, rabbit);
  const handle = (
    consumer as unknown as {
      handle: (p: Record<string, unknown>, k: string) => Promise<void>;
    }
  ).handle.bind(consumer);
  return { handle, updateMany, deals };
}

describe('EntitySourceConsumerService (FR-DEALS-490 / FR-DEALS-500)', () => {
  it('clears productId on crm.product.deleted', async () => {
    const { handle, updateMany } = make();
    await handle(
      {
        projectId: 'p1',
        payload: { id: 'prod-1' },
      },
      'crm.product.deleted',
    );
    expect(updateMany).toHaveBeenCalledWith(
      { projectId: 'p1', productId: 'prod-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ productId: '' }),
      }),
    );
  });

  it('marks contactSourceDeleted on crm.contact.deleted', async () => {
    const { handle, updateMany } = make();
    await handle(
      {
        projectId: 'p1',
        payload: { contactId: 'c-9' },
      },
      'crm.contact.deleted',
    );
    expect(updateMany).toHaveBeenCalledWith(
      { projectId: 'p1', contactId: 'c-9' },
      expect.objectContaining({
        $set: expect.objectContaining({ contactSourceDeleted: true }),
      }),
    );
  });

  it('marks companySourceDeleted on crm.company.deleted', async () => {
    const { handle, updateMany } = make();
    await handle(
      {
        projectId: 'p1',
        payload: { companyId: 'co-3' },
      },
      'crm.company.deleted',
    );
    expect(updateMany).toHaveBeenCalledWith(
      { projectId: 'p1', companyId: 'co-3' },
      expect.objectContaining({
        $set: expect.objectContaining({ companySourceDeleted: true }),
      }),
    );
  });

  it('skips events without projectId', async () => {
    const { handle, updateMany } = make();
    await handle({ payload: { contactId: 'c-1' } }, 'crm.contact.deleted');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('skips product.deleted when product id is missing', async () => {
    const { handle, updateMany } = make();
    await handle({ projectId: 'p1', payload: {} }, 'crm.product.deleted');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('resolves contactId from subject when payload omits it', async () => {
    const { handle, updateMany } = make();
    await handle(
      { projectId: 'p1', subject: 'projects/p1/contacts/c-from-subject', payload: {} },
      'crm.contact.deleted',
    );
    expect(updateMany).toHaveBeenCalledWith(
      { projectId: 'p1', contactId: 'c-from-subject' },
      expect.any(Object),
    );
  });
});
