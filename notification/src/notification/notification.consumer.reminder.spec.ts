import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';

describe('NotificationConsumer reminder scheduler (TODO-116)', () => {
  function build(scheduled: Partial<ScheduledReminderService>) {
    const upsertFromEvent = jest.fn().mockResolvedValue(true);
    const cancelByReminderKey = jest.fn().mockResolvedValue(1);
    const scheduledReminders = {
      upsertFromEvent,
      cancelByReminderKey,
      ...scheduled,
    } as unknown as ScheduledReminderService;
    const notifications = { materialize: jest.fn() } as unknown as NotificationService;
    const membersSvc = {
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['activities'], ok: true }),
      isModuleEnabled: jest.fn(() => true),
    } as unknown as ControlMembersService;
    const metrics = {
      recordEventConsumed: jest.fn(),
      setConsumerLagMs: jest.fn(),
      recordSuppressed: jest.fn(),
    };
    const consumer = new NotificationConsumer(
      {} as RabbitMqService,
      notifications,
      membersSvc,
      metrics as never,
      scheduledReminders,
    );
    return { consumer, upsertFromEvent, cancelByReminderKey, metrics };
  }

  async function run(consumer: NotificationConsumer, env: unknown, key: string): Promise<void> {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(env as Record<string, unknown>, key);
  }

  it('stores delayed row on crm.activity.reminder_scheduled', async () => {
    const { consumer, upsertFromEvent } = build({});
    await run(
      consumer,
      {
        projectId: 'p1',
        messageId: 'm-sched',
        payload: {
          activityId: 'a1',
          recipientId: 'u1',
          fireAt: Date.now() + 900_000,
          title: 'Call',
        },
      },
      'crm.activity.reminder_scheduled',
    );
    expect(upsertFromEvent).toHaveBeenCalledTimes(1);
  });

  it('cancels pending rows on crm.activity.reminder_cancelled', async () => {
    const { consumer, cancelByReminderKey } = build({});
    await run(
      consumer,
      {
        projectId: 'p1',
        payload: { activityId: 'a1', reminderKey: 'activity.reminder:a1' },
      },
      'crm.activity.reminder_cancelled',
    );
    expect(cancelByReminderKey).toHaveBeenCalledWith('activity.reminder:a1');
  });

  it('skips scheduling when activities module disabled', async () => {
    const { consumer, upsertFromEvent, metrics } = build({});
    const membersSvc = {
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
      isModuleEnabled: jest.fn(() => false),
    };
    const scheduledReminders = {
      upsertFromEvent,
      cancelByReminderKey: jest.fn(),
    } as unknown as ScheduledReminderService;
    const c = new NotificationConsumer(
      {} as RabbitMqService,
      { materialize: jest.fn() } as unknown as NotificationService,
      membersSvc as unknown as ControlMembersService,
      metrics as never,
      scheduledReminders,
    );
    await run(
      c,
      { projectId: 'p1', payload: { activityId: 'a1', recipientId: 'u1', fireAt: 1 } },
      'crm.activity.reminder_scheduled',
    );
    expect(upsertFromEvent).not.toHaveBeenCalled();
    expect(metrics.recordSuppressed).toHaveBeenCalledWith('module_disabled');
  });
});
