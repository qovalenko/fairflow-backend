import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

describe('NotificationConsumer effectiveModules (FR-NOTIF-240)', () => {
  function build(members: Partial<ControlMembersService>, metrics?: Partial<MetricsService>) {
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const membersSvc = {
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: [{ id: 'u-owner', role: 'member' }], ok: true }),
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['deals'], ok: true }),
      resolveFanout: jest.fn().mockResolvedValue([]),
      isModuleEnabled: jest.fn((mods: string[], id: string) => mods.includes(id)),
      ...members,
    } as unknown as ControlMembersService;
    const metricsSvc = {
      recordEventConsumed: jest.fn(),
      setConsumerLagMs: jest.fn(),
      observeFanout: jest.fn(),
      recordSuppressed: jest.fn(),
      ...metrics,
    } as unknown as MetricsService;
    const rabbit = {} as unknown as RabbitMqService;
    const consumer = new NotificationConsumer(rabbit, notifications, membersSvc, metricsSvc, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    return { consumer, materialize, membersSvc, metricsSvc };
  }

  async function run(consumer: NotificationConsumer, env: unknown, key: string): Promise<void> {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(env as Record<string, unknown>, key);
  }

  it('skips when source module is disabled in project', async () => {
    const { consumer, materialize, metricsSvc } = build({
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['contacts'], ok: true }),
    });

    await run(
      consumer,
      {
        projectId: 'p1',
        messageId: 'm1',
        subject: 'deal/d1',
        payload: { dealId: 'd1', ownerId: 'u-owner', name: 'Deal' },
      },
      'crm.deal.reassigned',
    );

    expect(materialize).not.toHaveBeenCalled();
    expect(metricsSvc.recordSuppressed).toHaveBeenCalledWith('module_disabled');
  });
});
