import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** BX-OFFB-2 — activity `control.member.offboarded` consumer: delegation + poison guard. */
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
  const activity = { reassignOwnedRecords } as unknown as ActivityService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(activity, rabbit), reassignOwnedRecords };
}

describe('activity MemberOffboardedConsumer.handle', () => {
  it('reassigns activities and reports the outcome', async () => {
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

  it('skips when leaver and target are the same user', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle({
        type: 'control.member.offboarded',
        projectId: 'p1',
        payload: {
          entityType: 'employee',
          entityId: 'same',
          metadata: { departingUserId: 'same', reassignToUserId: 'same', offboardTs: 42 },
        },
      }),
    ).resolves.toBe('skipped');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('reports skipped when no activities remain owned by the leaver', async () => {
    const { consumer, reassignOwnedRecords } = make(0);
    await expect(consumer.handle(env())).resolves.toBe('skipped');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 7);
  });

  it('falls back to payload.entityId when departingUserId is absent', async () => {
    const { consumer, reassignOwnedRecords } = make(1);
    await expect(
      consumer.handle({
        type: 'control.member.offboarded',
        projectId: 'p1',
        payload: {
          entityType: 'employee',
          entityId: 'leaver',
          metadata: { reassignToUserId: 'mgr', offboardTs: 9 },
        },
      }),
    ).resolves.toBe('reassigned');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 9);
  });
});

describe('activity MemberOffboardedConsumer.onModuleInit', () => {
  const OLD = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new MemberOffboardedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][1]).toEqual(['control.member.offboarded']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const c = new MemberOffboardedConsumer({} as ActivityService, { consume } as never);
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
