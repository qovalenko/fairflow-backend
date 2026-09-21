import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { ContactsService } from './contacts.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/**
 * BX-OFFB-2 — `control.member.offboarded` consumer decision matrix. The
 * reassignment itself lives in `ContactsService.reassignOwnedRecords` (mocked);
 * these tests pin the envelope parsing, poison/skip handling, and delegation.
 */
type Env = Record<string, unknown>;

const makeEnv = (
  over: { projectId?: unknown; metadata?: Record<string, unknown>; entityId?: unknown } = {},
): Env => ({
  type: 'control.member.offboarded',
  projectId: 'projectId' in over ? over.projectId : 'p1',
  payload: {
    action: 'employee.offboarded',
    entityType: 'employee',
    entityId: 'entityId' in over ? over.entityId : 'leaver',
    metadata:
      'metadata' in over
        ? over.metadata
        : { departingUserId: 'leaver', reassignToUserId: 'mgr', offboardTs: 123 },
  },
});

function make(reassigned = 2) {
  const reassignOwnedRecords = jest.fn().mockResolvedValue({ reassigned });
  const contacts = { reassignOwnedRecords } as unknown as ContactsService;
  const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
  return { consumer: new MemberOffboardedConsumer(contacts, rabbit), reassignOwnedRecords };
}

describe('contact MemberOffboardedConsumer.handle', () => {
  it('reassigns the leaver’s contacts and reports "reassigned"', async () => {
    const { consumer, reassignOwnedRecords } = make(3);
    await expect(consumer.handle(makeEnv())).resolves.toBe('reassigned');
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 123);
  });

  it('reports "skipped" when nothing was still owned by the leaver', async () => {
    const { consumer, reassignOwnedRecords } = make(0);
    await expect(consumer.handle(makeEnv())).resolves.toBe('skipped');
    expect(reassignOwnedRecords).toHaveBeenCalledTimes(1);
  });

  it('falls back to payload.entityId when metadata.departingUserId is absent', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await consumer.handle(makeEnv({ metadata: { reassignToUserId: 'mgr', offboardTs: 5 } }));
    expect(reassignOwnedRecords).toHaveBeenCalledWith('p1', 'leaver', 'mgr', 5);
  });

  it('dead-letters a poison message with no projectId (never reassigns)', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(consumer.handle(makeEnv({ projectId: '' }))).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('dead-letters when reassignToUserId is missing (never reassigns)', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle(makeEnv({ metadata: { departingUserId: 'leaver' } })),
    ).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('dead-letters when offboardTs is missing (would collapse the idempotency key to :0)', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle(
        makeEnv({ metadata: { departingUserId: 'leaver', reassignToUserId: 'mgr' } }),
      ),
    ).resolves.toBe('dead_letter');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });

  it('skips (no-op) when target equals the departing user', async () => {
    const { consumer, reassignOwnedRecords } = make();
    await expect(
      consumer.handle(
        makeEnv({ metadata: { departingUserId: 'leaver', reassignToUserId: 'leaver' } }),
      ),
    ).resolves.toBe('skipped');
    expect(reassignOwnedRecords).not.toHaveBeenCalled();
  });
});

describe('contact MemberOffboardedConsumer.onModuleInit', () => {
  const OLD = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = OLD;
  });

  it('подписывается на control.member.offboarded', async () => {
    delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new MemberOffboardedConsumer(
      { reassignOwnedRecords: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('contact.member-offboarded'),
      ['control.member.offboarded'],
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('не подписывается при MEMBER_OFFBOARD_CONSUMERS_ENABLED=false', async () => {
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const c = new MemberOffboardedConsumer(
      { reassignOwnedRecords: jest.fn() } as never,
      {
        consume,
      } as never,
    );
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
