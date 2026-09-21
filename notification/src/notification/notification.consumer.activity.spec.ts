import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

describe('NotificationConsumer activity events (FR-ACTIVITIES-290)', () => {
  const projectMembers = [
    { id: 'u-owner', role: 'member' },
    { id: 'u-leader', role: 'manager' },
  ];

  function build() {
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const membersSvc = {
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: projectMembers, ok: true }),
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['activities'], ok: true }),
      isModuleEnabled: jest.fn(() => true),
      resolveFanout: jest.fn().mockResolvedValue(['u-leader']),
    } as unknown as ControlMembersService;
    const metrics = {
      recordEventConsumed: jest.fn(),
      setConsumerLagMs: jest.fn(),
      observeFanout: jest.fn(),
      recordSuppressed: jest.fn(),
    };
    const rabbit = {} as unknown as RabbitMqService;
    const consumer = new NotificationConsumer(rabbit, notifications, membersSvc, metrics as never, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    return { consumer, materialize, membersSvc };
  }

  async function run(consumer: NotificationConsumer, env: unknown, key: string): Promise<void> {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(env as Record<string, unknown>, key);
  }

  it('materializes crm.activity.overdue with deep-link and leader fan-out', async () => {
    const { consumer, materialize } = build();
    await run(
      consumer,
      {
        projectId: 'p1',
        messageId: 'm-overdue',
        subject: 'activity/a-1',
        payload: {
          activityId: 'a-1',
          assigneeId: 'u-owner',
          type: 'task',
          title: 'Позвонить',
          dueDate: 1_700_000_000_000,
          links: [{ entityType: 'deal', entityId: 'd1', nameSnapshot: 'Сделка X' }],
        },
      },
      'crm.activity.overdue',
    );
    const recipients = materialize.mock.calls.map((c) => c[0].user_id).sort();
    expect(recipients).toEqual(['u-leader', 'u-owner']);
    const ownerRow = materialize.mock.calls.find((c) => c[0].user_id === 'u-owner')?.[0];
    expect(ownerRow.category).toBe('activities');
    expect(ownerRow.title).toBe('Просроченная активность');
    expect(ownerRow.body).toContain('Позвонить');
    expect(ownerRow.body).toContain('Привязка:');
    const data = JSON.parse(ownerRow.data_json as string) as { deepLink?: string; title?: string };
    expect(data.deepLink).toBe('/activities/a-1');
    expect(data.title).toBe('Позвонить');
  });

  it('materializes crm.activity.reassigned to the new assignee', async () => {
    const { consumer, materialize } = build();
    await run(
      consumer,
      {
        projectId: 'p1',
        messageId: 'm-re',
        subject: 'activity/a-2',
        payload: {
          activityId: 'a-2',
          assigneeId: 'u-owner',
          type: 'call',
          title: 'Входящий',
          dueDate: 1_700_000_000_000,
          links: [{ entityType: 'contact', entityId: 'c1', nameSnapshot: 'Иван' }],
        },
      },
      'crm.activity.reassigned',
    );
    const row = materialize.mock.calls[0][0] as {
      user_id: string;
      category: string;
      title: string;
      body: string;
      data_json: string;
    };
    expect(row.user_id).toBe('u-owner')
    expect(row.category).toBe('activities')
    expect(row.title).toBe('Вам назначена активность')
    expect(row.body).toContain('Входящий')
    expect(row.body).toContain('Привязка: Иван')
    expect(row.body).toContain('Срок:')
    expect(JSON.parse(row.data_json).deepLink).toBe('/activities/a-2')
  });
});
