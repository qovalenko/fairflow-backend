import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { MetricsService } from '../metrics/metrics.service';

/** FR-PROJ-280 — project-member role add/change/remove → in-app notification. */
describe('NotificationConsumer project role access (FR-PROJ-280)', () => {
  const materialize = jest.fn().mockResolvedValue(true);
  const getMembersWithStatus = jest.fn().mockResolvedValue({
    ok: true,
    members: [{ id: 'user-42', role: 'member' }],
  });
  const getEffectiveModulesWithStatus = jest.fn().mockResolvedValue({
    ok: true,
    modules: ['documents', 'deals'],
  });

  function makeConsumer() {
    const notifications = { materialize } as unknown as NotificationService;
    const members = {
      getMembersWithStatus,
      getEffectiveModulesWithStatus,
      isModuleEnabled: () => true,
      resolveFanout: jest.fn().mockResolvedValue([]),
    } as unknown as ControlMembersService;
    const rabbit = {} as unknown as RabbitMqService;
    const metrics = {
      setConsumerLagMs: jest.fn(),
      recordEventConsumed: jest.fn(),
      recordSuppressed: jest.fn(),
      observeFanout: jest.fn(),
    } as unknown as MetricsService;
    return new NotificationConsumer(
      rabbit,
      notifications,
      members,
      metrics,
      {
        upsertFromEvent: jest.fn(),
        cancelByReminderKey: jest.fn(),
      } as unknown as ScheduledReminderService,
    );
  }

  beforeEach(() => {
    materialize.mockClear();
    getMembersWithStatus.mockClear();
    getEffectiveModulesWithStatus.mockClear();
  });

  it('materializes control.role.assigned for the affected project member', async () => {
    const consumer = makeConsumer();
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(
      {
        messageId: 'msg-1',
        projectId: 'proj-1',
        type: 'control.role.assigned',
        payload: {
          subjectUserId: 'user-42',
          role: 'admin',
          memberAction: 'member_role.changed',
        },
      },
      'control.role.assigned',
    );

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-42',
        project_id: 'proj-1',
        event_type: 'control.role.assigned',
      }),
    );
  });

  it('materializes control.role.revoked when a member is removed', async () => {
    getMembersWithStatus.mockResolvedValue({
      ok: true,
      members: [],
    });
    const consumer = makeConsumer();
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(
      {
        messageId: 'msg-2',
        projectId: 'proj-1',
        type: 'control.role.revoked',
        payload: {
          subjectUserId: 'user-42',
          previousRole: 'member',
          memberAction: 'member.removed',
        },
      },
      'control.role.revoked',
    );

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-42',
        project_id: 'proj-1',
        event_type: 'control.role.revoked',
      }),
    );
  });
});
