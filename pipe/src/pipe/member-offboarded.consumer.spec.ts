import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { PipeService } from './pipe.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** BX-OFFB-2 — pipe `control.member.offboarded` consumer: delegation + poison guard. */
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
  const pipe = { reassignOwnedRecords } as unknown as PipeService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(pipe, rabbit), reassignOwnedRecords };
}

describe('pipe MemberOffboardedConsumer.handle', () => {
  it('reassigns deals and reports the outcome', async () => {
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

  it('skips when from and to are the same user', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle({
        type: 'control.member.offboarded',
        projectId: 'p1',
        payload: {
          entityType: 'employee',
          entityId: 'same',
          metadata: {
            departingUserId: 'same',
            reassignToUserId: 'same',
            offboardTs: 9,
          },
        },
      }),
    ).resolves.toBe('skipped');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('reports skipped when no deals were reassigned', async () => {
    const { consumer, reassignOwnedRecords } = make(0);
    await expect(consumer.handle(env())).resolves.toBe('skipped');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 7);
  });
});
