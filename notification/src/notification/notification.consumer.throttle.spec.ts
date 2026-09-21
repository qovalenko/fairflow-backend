import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * NFR-ORG-050: org-deactivation fan-out throttles between batches.
 */
describe('NotificationConsumer org-deactivate throttle (NFR-ORG-050)', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...OLD_ENV };
    jest.resetModules();
  });

  async function makeConsumer() {
    const { NotificationConsumer } = await import('./notification.consumer');
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const members = {
      getOrgActiveMembers: jest.fn().mockResolvedValue(['u1', 'u2', 'u3']),
    } as unknown as ControlMembersService;
    const metrics = {
      observeFanout: jest.fn(),
      recordEventConsumed: jest.fn(),
    } as unknown as MetricsService;
    const consumer = new NotificationConsumer(
      {} as RabbitMqService,
      notifications,
      members,
      metrics,
      {
        upsertFromEvent: jest.fn(),
        cancelByReminderKey: jest.fn(),
      } as unknown as ScheduledReminderService,
    );
    return { consumer, materialize, metrics };
  }

  it('materializes all recipients across chunked batches', async () => {
    jest.useRealTimers();
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = '1';
    process.env.NOTIFICATION_ORG_DEACTIVATE_FANOUT_DELAY_MS = '0';
    jest.resetModules();
    const { consumer, materialize } = await makeConsumer();
    await (
      consumer as unknown as {
        materializeOrgDeactivated: (p: Record<string, unknown>) => Promise<void>;
      }
    ).materializeOrgDeactivated({
      messageId: 'm1',
      payload: { organizationId: 'org-1', entityId: 'org-1' },
    });
    expect(materialize).toHaveBeenCalledTimes(3);
  });

  it('waits between fan-out batches (throttle delay)', async () => {
    jest.useFakeTimers();
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = '1';
    process.env.NOTIFICATION_ORG_DEACTIVATE_FANOUT_DELAY_MS = '50';
    jest.resetModules();
    const { consumer } = await makeConsumer();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const run = (
      consumer as unknown as {
        materializeOrgDeactivated: (p: Record<string, unknown>) => Promise<void>;
      }
    ).materializeOrgDeactivated({
      messageId: 'm1',
      payload: { organizationId: 'org-1', entityId: 'org-1' },
    });
    await Promise.all([run, jest.advanceTimersByTimeAsync(500)]);
    const delayCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 50);
    expect(delayCalls.length).toBeGreaterThanOrEqual(2);
    setTimeoutSpy.mockRestore();
  });
});
