import { SourceDriftConsumer } from './source-drift.consumer';
import type { OrdersService } from './orders.service';
import type { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/**
 * FR-ORDERS-390 / TODO-213: the bus side of the reactive drift marking. Poison
 * messages are terminal, an unreadable donor propagates (retry ladder), and the
 * project/entity always come from the ENVELOPE — never from a body-chosen project.
 */
type Call = { projectId: string; entity: string; entityId: string };

function makeConsumer(marked = 1, err?: Error) {
  const calls: Call[] = [];
  const orders = {
    markSourceDrift: async (projectId: string, entity: string, entityId: string) => {
      calls.push({ projectId, entity, entityId });
      if (err) throw err;
      return { scanned: marked, marked };
    },
  } as unknown as OrdersService;
  const rabbit = { consume: async () => undefined } as unknown as RabbitMqConsumer;
  return { consumer: new SourceDriftConsumer(orders, rabbit), calls };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  type: 'crm.contact.updated',
  version: 1,
  messageId: 'm1',
  timestamp: '2026-08-18T00:00:00.000Z',
  source: 'contact',
  projectId: 'p1',
  subject: 'contact/c1',
  payload: { contactId: 'c1', changes: [] },
  ...over,
});

describe('SourceDriftConsumer', () => {
  it('marks the orders of the contact that changed', async () => {
    const { consumer, calls } = makeConsumer();
    const outcome = await consumer.handle(envelope(), 'crm.contact.updated');
    expect(outcome).toBe('marked');
    expect(calls).toEqual([{ projectId: 'p1', entity: 'contact', entityId: 'c1' }]);
  });

  it('routes company keys to the company side', async () => {
    const { consumer, calls } = makeConsumer();
    await consumer.handle(
      envelope({ subject: 'company/co1', payload: { companyId: 'co1' } }),
      'crm.company.deleted',
    );
    expect(calls[0]).toEqual({ projectId: 'p1', entity: 'company', entityId: 'co1' });
  });

  it('falls back to the envelope subject when the payload has no flat id', async () => {
    const { consumer, calls } = makeConsumer();
    await consumer.handle(envelope({ payload: {} }), 'crm.contact.updated');
    expect(calls[0].entityId).toBe('c1');
  });

  it('dead-letters a message without a projectId (poison)', async () => {
    const { consumer, calls } = makeConsumer();
    const outcome = await consumer.handle(
      envelope({ projectId: undefined }),
      'crm.contact.updated',
    );
    expect(outcome).toBe('dead_letter');
    expect(calls).toHaveLength(0);
  });

  it('dead-letters a message without an entity id (poison)', async () => {
    const { consumer, calls } = makeConsumer();
    const outcome = await consumer.handle(
      envelope({ subject: undefined, payload: {} }),
      'crm.contact.updated',
    );
    expect(outcome).toBe('dead_letter');
    expect(calls).toHaveLength(0);
  });

  it('reports `skipped` when nothing drifted (redelivery is a no-op)', async () => {
    const { consumer } = makeConsumer(0);
    expect(await consumer.handle(envelope(), 'crm.contact.updated')).toBe('skipped');
  });

  it('propagates a donor/Mongo failure so the retry ladder handles it', async () => {
    const { consumer } = makeConsumer(1, new Error('source unreadable'));
    await expect(consumer.handle(envelope(), 'crm.contact.updated')).rejects.toThrow(/unreadable/);
  });

  it('onModuleInit не подписывается при SOURCE_DRIFT_CONSUMER_ENABLED=false', async () => {
    const prev = process.env.SOURCE_DRIFT_CONSUMER_ENABLED;
    process.env.SOURCE_DRIFT_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const consumer = new SourceDriftConsumer(
      {} as OrdersService,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.SOURCE_DRIFT_CONSUMER_ENABLED;
    else process.env.SOURCE_DRIFT_CONSUMER_ENABLED = prev;
  });
});
