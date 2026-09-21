import { NotificationConsumer } from './notification.consumer';
import { NotificationService } from './notification.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';

const metrics = {
  observeFanout: jest.fn(),
  recordSuppressed: jest.fn(),
} as unknown as MetricsService;

describe('NotificationConsumer chat isolation', () => {
  it('materializes org/workspace-scoped DM under scope_kind=user (TODO-205)', async () => {
    const materializeChatNotification = jest.fn(async () => true);
    const notifications = { materializeChatNotification } as unknown as NotificationService;
    const members = {} as ControlMembersService;
    const consumer = new NotificationConsumer({} as never, notifications, members, metrics, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    const payload = {
      projectId: '',
      payload: {
        conversationId: 'c1',
        messageId: 'm1',
        senderId: 'u2',
        recipientUserIds: ['u1'],
        mentionIds: [],
        scope: { kind: 'org', scopeId: 'org-1' },
        preview: 'hi',
      },
      idempotencyKey: 'ik1',
      messageId: 'bus-1',
    };
    await (consumer as unknown as { materializeChatMessage: (p: unknown) => Promise<void> }).materializeChatMessage(
      payload,
    );
    expect(materializeChatNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'org-1',
        user_id: 'u1',
        scope_kind: 'user',
        is_mention: false,
      }),
    );
  });

  it('materializes project-scoped chat notifications under project id', async () => {
    const materializeChatNotification = jest.fn(async () => true);
    const notifications = { materializeChatNotification } as unknown as NotificationService;
    const members = {
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: ['chat'], ok: true }),
      isModuleEnabled: jest.fn(() => true),
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: [{ id: 'u1', role: 'member' }], ok: true }),
    } as unknown as ControlMembersService;
    const consumer = new NotificationConsumer({} as never, notifications, members, metrics, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    const payload = {
      projectId: 'p1',
      payload: {
        conversationId: 'c1',
        messageId: 'm1',
        senderId: 'u2',
        recipientUserIds: ['u1'],
        mentionIds: [],
        scope: { kind: 'project', scopeId: 'p1' },
        preview: 'hi',
      },
      idempotencyKey: 'ik1',
      messageId: 'bus-1',
    };
    await (consumer as unknown as { materializeChatMessage: (p: unknown) => Promise<void> }).materializeChatMessage(
      payload,
    );
    expect(materializeChatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p1', user_id: 'u1', is_mention: false }),
    );
  });
});
