import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

import type { MetricsService } from '../metrics/metrics.service';

const metrics = {
  observeFanout: jest.fn(),
  recordEventConsumed: jest.fn(),
} as unknown as MetricsService;

/**
 * control.org.deactivated fan-out (be-org-deactivated-notify): notify every ACTIVE
 * employee of the org (resolved via control ListEmployees), scope the feed item by
 * organization id (no projectId), dedup per addressee, and — because the employees
 * are the WHOLE audience — nack (throw) into the retry ladder when control is down.
 */
describe('NotificationConsumer control.org.deactivated', () => {
  function build(getOrgActiveMembers: jest.Mock) {
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const members = { getOrgActiveMembers } as unknown as ControlMembersService;
    const rabbit = {} as unknown as RabbitMqService;
    const consumer = new NotificationConsumer(rabbit, notifications, members, metrics, { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService);
    return { consumer, materialize };
  }

  const envelope = {
    messageId: 'msg-org-1',
    idempotencyKey: 'idem-org-1',
    subject: 'organization/org-9',
    userId: 'u-owner',
    payload: {
      action: 'organization.deactivated',
      entityType: 'organization',
      entityId: 'org-9',
      organizationId: 'org-9',
      projectId: null,
      actorUserId: 'u-owner',
    },
  };

  async function run(consumer: NotificationConsumer, env: unknown): Promise<void> {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(env as Record<string, unknown>, 'control.org.deactivated');
  }

  it('materializes one org-scoped notice per active employee with per-addressee dedup', async () => {
    const getOrgActiveMembers = jest.fn().mockResolvedValue(['u-owner', 'u-a', 'u-b']);
    const { consumer, materialize } = build(getOrgActiveMembers);

    await run(consumer, envelope);

    // resolved with the org id + the deactivating owner as actor.
    expect(getOrgActiveMembers).toHaveBeenCalledWith('org-9', 'u-owner');
    expect(materialize).toHaveBeenCalledTimes(3);

    const recipients = materialize.mock.calls.map((c) => c[0].user_id).sort();
    expect(recipients).toEqual(['u-a', 'u-b', 'u-owner']);

    for (const [arg] of materialize.mock.calls) {
      // org-scoped isolation (no projectId → organization id).
      expect(arg.project_id).toBe('org-9');
      expect(arg.category).toBe('org');
      expect(arg.event_type).toBe('control.org.deactivated');
      expect(arg.entity_type).toBe('organization');
      expect(arg.entity_id).toBe('org-9');
      // per-addressee dedup key so the uniq {user_id, message_id} index holds.
      expect(arg.dedup_key).toBe(`idem-org-1:${arg.user_id}`);
    }
  });

  it('inactive employees are filtered by the resolver (never materialized)', async () => {
    // getOrgActiveMembers already returns only active user-ids (is_active filter).
    const getOrgActiveMembers = jest.fn().mockResolvedValue(['u-active']);
    const { consumer, materialize } = build(getOrgActiveMembers);

    await run(consumer, envelope);

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-active');
  });

  it('no active employees → ack, nothing materialized', async () => {
    const getOrgActiveMembers = jest.fn().mockResolvedValue([]);
    const { consumer, materialize } = build(getOrgActiveMembers);

    await run(consumer, envelope);

    expect(materialize).not.toHaveBeenCalled();
  });

  it('missing organizationId → skipped (no throw, no materialize)', async () => {
    const getOrgActiveMembers = jest.fn();
    const { consumer, materialize } = build(getOrgActiveMembers);

    await run(consumer, { messageId: 'm', payload: { action: 'organization.deactivated' } });

    expect(getOrgActiveMembers).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('control ListEmployees down → throws (nack → retry ladder, not silently dropped)', async () => {
    const getOrgActiveMembers = jest.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    const { consumer, materialize } = build(getOrgActiveMembers);

    await expect(run(consumer, envelope)).rejects.toThrow('UNAVAILABLE');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('falls back to subject/entityId for the org id when organizationId is absent', async () => {
    const getOrgActiveMembers = jest.fn().mockResolvedValue(['u-x']);
    const { consumer, materialize } = build(getOrgActiveMembers);

    await run(consumer, {
      messageId: 'm2',
      subject: 'organization/org-77',
      payload: { action: 'organization.deactivated', entityId: 'org-77', actorUserId: 'u-owner' },
    });

    expect(getOrgActiveMembers).toHaveBeenCalledWith('org-77', 'u-owner');
    expect(materialize.mock.calls[0][0].project_id).toBe('org-77');
  });
});
