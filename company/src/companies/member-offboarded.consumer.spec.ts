import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { CompaniesService } from './companies.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

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
  const companies = { reassignOwnedRecords } as unknown as CompaniesService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(companies, rabbit), reassignOwnedRecords };
}

describe('company MemberOffboardedConsumer.handle', () => {
  it('reassigns companies and reports the outcome', async () => {
    const { consumer, reassignOwnedRecords } = make(2);
    await expect(consumer.handle(env())).resolves.toBe('reassigned');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 7);
  });

  it('dead-letters a poison message (no projectId) without reassigning', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(consumer.handle(env({ projectId: '' }))).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('dead-letters when offboardTs is missing', async () => {
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

  it('skips when from and to are the same user', async () => {
    const { consumer, reassignOwnedRecords } = make();
    const msg = {
      type: 'control.member.offboarded',
      projectId: 'p1',
      payload: {
        entityType: 'employee',
        entityId: 'same',
        metadata: { departingUserId: 'same', reassignToUserId: 'same', offboardTs: 1 },
      },
    };
    await expect(consumer.handle(msg)).resolves.toBe('skipped');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('skips when service reports zero reassigned records', async () => {
    const { consumer, reassignOwnedRecords } = make(0);
    await expect(consumer.handle(env())).resolves.toBe('skipped');
    expect(reassignOwnedRecords).toHaveBeenCalled();
  });

  it('dead-letters when reassignToUserId is missing', async () => {
    const { consumer, reassignOwnedRecords } = make();
    const poison = {
      type: 'control.member.offboarded',
      projectId: 'p1',
      payload: {
        entityType: 'employee',
        entityId: 'leaver',
        metadata: { departingUserId: 'leaver', offboardTs: 7 },
      },
    };
    await expect(consumer.handle(poison)).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('falls back to entityId when departingUserId is absent', async () => {
    const { consumer, reassignOwnedRecords } = make(1);
    const msg = {
      type: 'control.member.offboarded',
      projectId: 'p1',
      payload: {
        entityType: 'employee',
        entityId: 'leaver-from-entity',
        metadata: { reassignToUserId: 'mgr', offboardTs: 9 },
      },
    };
    await expect(consumer.handle(msg)).resolves.toBe('reassigned');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver-from-entity', 'mgr', 9);
  });

  it('does not bind RabbitMQ when disabled by env', async () => {
    const prev = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'false';
    try {
      const consume = jest.fn();
      const consumer = new MemberOffboardedConsumer(
        {} as CompaniesService,
        {
          consume,
        } as unknown as RabbitMqConsumer,
      );
      await consumer.onModuleInit();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
      else process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = prev;
    }
  });
});
