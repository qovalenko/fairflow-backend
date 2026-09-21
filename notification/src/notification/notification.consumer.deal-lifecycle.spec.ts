import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

/** FR-DEALS-455: won/lost/reopened must be in the consumer matrix. */
describe('NotificationConsumer deal lifecycle (FR-DEALS-455)', () => {
  const projectMembers = [{ id: 'u-owner', role: 'member' }];

  function build() {
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const membersSvc = {
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: projectMembers, ok: true }),
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['deals'], ok: true }),
      isModuleEnabled: jest.fn(() => true),
      resolveFanout: jest.fn(),
    } as unknown as ControlMembersService;
    const metrics = {
      recordEventConsumed: jest.fn(),
      setConsumerLagMs: jest.fn(),
      observeFanout: jest.fn(),
      recordSuppressed: jest.fn(),
    };
    const rabbit = {} as unknown as RabbitMqService;
    const consumer = new NotificationConsumer(rabbit, notifications, membersSvc, metrics as never, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    return { consumer, materialize };
  }

  async function run(consumer: NotificationConsumer, key: string, dealId: string) {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(
      {
        projectId: 'proj-1',
        messageId: `msg-${dealId}`,
        subject: `deal/${dealId}`,
        payload: { dealId, assigneeId: 'u-owner' },
      },
      key,
    );
  }

  it.each(['crm.deal.won', 'crm.deal.lost', 'crm.deal.reopened'])(
    'materializes %s for the deal owner',
    async (key) => {
      const { consumer, materialize } = build();
      await run(consumer, key, 'd-42');
      expect(materialize).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: 'd-42',
          event_type: key,
          user_id: 'u-owner',
        }),
      );
    },
  );

  it('skips lost/reopened without assigneeId (no silent all-hands fan-out)', async () => {
    const { consumer, materialize } = build();
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(
      {
        projectId: 'proj-1',
        messageId: 'msg-empty',
        subject: 'deal/d-empty',
        payload: { dealId: 'd-empty' },
      },
      'crm.deal.lost',
    );
    expect(materialize).not.toHaveBeenCalled();
  });
});
