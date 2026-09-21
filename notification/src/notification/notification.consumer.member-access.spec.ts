import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { MetricsService } from '../metrics/metrics.service';

/** FR-ORG-780 — notification materializes control.member.* access changes. */
describe('NotificationConsumer member access (FR-ORG-780)', () => {
  const materialize = jest.fn().mockResolvedValue(true);

  function makeConsumer() {
    const notifications = { materialize } as unknown as NotificationService;
    const members = {} as unknown as ControlMembersService;
    const rabbit = {} as unknown as RabbitMqService;
    const metrics = {
      setConsumerLagMs: jest.fn(),
      recordEventConsumed: jest.fn(),
    } as unknown as MetricsService;
    return new NotificationConsumer(rabbit, notifications, members, metrics, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
  }

  const envelope = {
    messageId: 'msg-1',
    type: 'control.member.changed',
    payload: {
      organizationId: 'org-1',
      entityId: 'user-42',
      role: 'employee',
    },
  };

  beforeEach(() => {
    materialize.mockClear();
  });

  it('materializes in-app notification for the affected member', async () => {
    const consumer = makeConsumer();
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(envelope, 'control.member.changed');

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-42',
        project_id: 'org-1',
        event_type: 'control.member.changed',
        title: 'Изменились ваши права в организации',
      }),
    );
  });

  it('skips when organizationId or entityId is missing', async () => {
    const consumer = makeConsumer();
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(
      { messageId: 'm2', type: 'control.member.added', payload: {} },
      'control.member.added',
    );
    expect(materialize).not.toHaveBeenCalled();
  });
});
