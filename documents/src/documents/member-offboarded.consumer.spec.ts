import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { DocumentsService } from './documents.service';
import { DriftRabbitMqConsumer } from '../drift/rabbitmq-consumer.service';

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
  const documents = { reassignOwnedRecords } as unknown as DocumentsService;
  const rabbit = { consume: jest.fn() } as unknown as DriftRabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(documents, rabbit), reassignOwnedRecords };
}

describe('documents MemberOffboardedConsumer.handle', () => {
  it('reassigns document groups and reports the outcome', async () => {
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
});
