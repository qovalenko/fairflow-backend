import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { OrdersService } from './orders.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** BX-OFFB-2 — orders `control.member.offboarded` consumer: delegation + poison guard. */
const env = (over: Record<string, unknown> = {}) => ({
  type: 'control.member.offboarded',
  projectId: 'projectId' in over ? over.projectId : 'p1',
  payload: {
    entityType: 'employee',
    entityId: 'leaver',
    metadata: { departingUserId: 'leaver', reassignToUserId: 'mgr', offboardTs: 7 },
  },
});

function make(reassigned = 1) {
  const reassignOwnedRecords = jest.fn().mockResolvedValue({ reassigned });
  const orders = { reassignOwnedRecords } as unknown as OrdersService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(orders, rabbit), reassignOwnedRecords };
}

describe('orders MemberOffboardedConsumer.handle', () => {
  it('reassigns orders and reports the outcome', async () => {
    const { consumer, reassignOwnedRecords } = make(2);
    await expect(consumer.handle(env())).resolves.toBe('reassigned');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 7);
  });

  it('dead-letters a poison message (no projectId) without reassigning', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(consumer.handle(env({ projectId: '' }))).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('dead-letters when offboardTs is missing (would collapse the idempotency key to :0)', async () => {
    const { consumer, reassignOwnedRecords } = make();
    const poison = {
      type: 'control.member.offboarded',
      projectId: 'p1',
      payload: {
        entityType: 'employee',
        entityId: 'leaver',
        metadata: { departingUserId: 'leaver', reassignToUserId: 'mgr' },
      },
    };
    await expect(consumer.handle(poison)).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('skips when from equals to (no-op offboard)', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle({
        type: 'control.member.offboarded',
        projectId: 'p1',
        payload: {
          entityType: 'employee',
          entityId: 'same',
          metadata: { departingUserId: 'same', reassignToUserId: 'same', offboardTs: 9 },
        },
      }),
    ).resolves.toBe('skipped');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('reports skipped when nothing was reassigned', async () => {
    const { consumer } = make(0);
    await expect(consumer.handle(env())).resolves.toBe('skipped');
  });

  it('onModuleInit не подписывается при MEMBER_OFFBOARD_CONSUMERS_ENABLED=false', async () => {
    const prev = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const consumer = new MemberOffboardedConsumer(
      {} as OrdersService,
      {
        consume,
      } as unknown as RabbitMqConsumer,
    );
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    else process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = prev;
  });
});
