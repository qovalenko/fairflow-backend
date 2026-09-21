import { NotificationConsumer } from './notification.consumer';
import type { NotificationService } from './notification.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import { listNotificationEventTypes } from '@fairflow/shared';
import { getAddresseeHandler } from './notification-consumer-handlers';

/**
 * Fan-out union/dedup at the consumer level: control-resolved PA/leader are added
 * to verified payload owners and de-duped; control down skips the event (SEC-N-8).
 */
describe('NotificationConsumer fan-out (union + dedup + membership)', () => {
  const NODE_ENV = process.env.NOTIFICATION_CONSUMER_ENABLED;
  afterAll(() => {
    if (NODE_ENV === undefined) delete process.env.NOTIFICATION_CONSUMER_ENABLED;
    else process.env.NOTIFICATION_CONSUMER_ENABLED = NODE_ENV;
  });

  const projectMembers = [
    { id: 'u-owner', role: 'member' },
    { id: 'u-admin', role: 'admin' },
    { id: 'u-manager', role: 'manager' },
  ];

  function build(members: Partial<ControlMembersService>) {
    const materialize = jest.fn().mockResolvedValue(true);
    const notifications = { materialize } as unknown as NotificationService;
    const membersSvc = {
      getMembersWithStatus: jest
        .fn()
        .mockResolvedValue({ members: projectMembers, ok: true }),
      getEffectiveModulesWithStatus: jest
        .fn()
        .mockResolvedValue({ modules: ['deals', 'orders', 'contacts', 'companies', 'documents'], ok: true }),
      isModuleEnabled: jest.fn(() => true),
      resolveFanout: jest.fn(),
      ...members,
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

  const orderEnvelope = {
    projectId: 'proj-1',
    messageId: 'msg-1',
    subject: 'order/o-9',
    payload: { orderId: 'o-9', ownerId: 'u-owner' },
  };

  async function run(consumer: NotificationConsumer, env: unknown, key: string): Promise<void> {
    await (
      consumer as unknown as {
        materialize: (p: Record<string, unknown>, k: string) => Promise<void>;
      }
    ).materialize(env as Record<string, unknown>, key);
  }

  it('unions PA/leader with the verified payload owner and de-dupes overlap', async () => {
    const resolveFanout = jest.fn().mockResolvedValue(['u-owner', 'u-admin', 'u-manager']);
    const { consumer, materialize } = build({ resolveFanout });

    await run(consumer, orderEnvelope, 'crm.order.final_action_failed');

    expect(resolveFanout).toHaveBeenCalledWith('proj-1', ['pa', 'leader']);
    const recipients = materialize.mock.calls.map((c) => c[0].user_id).sort();
    expect(recipients).toEqual(['u-admin', 'u-manager', 'u-owner']);
    for (const [arg] of materialize.mock.calls) {
      expect(arg.project_id).toBe('proj-1');
    }
  });

  it('drops payload owners who are not project members', async () => {
    const resolveFanout = jest.fn().mockResolvedValue([]);
    const { consumer, materialize } = build({ resolveFanout });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm2',
        subject: 'deal/d-1',
        payload: { dealId: 'd-1', ownerId: 'u-outsider' },
      },
      'crm.deal.reassigned',
    );

    expect(resolveFanout).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('control down (membersOk=false) → throws (nack to retry ladder), no unverified delivery', async () => {
    const resolveFanout = jest.fn().mockResolvedValue([]);
    const { consumer, materialize, membersSvc } = build({
      getMembersWithStatus: jest.fn().mockResolvedValue({ members: [], ok: false }),
      resolveFanout,
    });

    await expect(run(consumer, orderEnvelope, 'crm.order.final_action_failed')).rejects.toThrow(
      /cannot verify addressees/,
    );

    expect(membersSvc.getMembersWithStatus).toHaveBeenCalledWith('proj-1');
    expect(resolveFanout).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('delivers crm.deal.reassigned to toOwnerId (real pipe payload shape)', async () => {
    const { consumer, materialize } = build({
      getMembersWithStatus: jest.fn().mockResolvedValue({
        members: [...projectMembers, { id: 'u-new-owner', role: 'member' }],
        ok: true,
      }),
    });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm3',
        subject: 'deal/d-2',
        // pipe.service.ts emits exactly { dealId, fromOwnerId, toOwnerId }.
        payload: { dealId: 'd-2', fromOwnerId: 'u-owner', toOwnerId: 'u-new-owner' },
      },
      'crm.deal.reassigned',
    );

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-new-owner');
  });

  it('non-fanout event never queries fanout groups', async () => {
    const resolveFanout = jest.fn();
    const { consumer, materialize } = build({ resolveFanout });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm2',
        subject: 'deal/d-1',
        payload: { dealId: 'd-1', ownerId: 'u-owner', name: 'Сделка №5' },
      },
      'crm.deal.reassigned',
    );

    expect(resolveFanout).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-owner');
    expect(materialize.mock.calls[0][0].body).toBe('Сделка Сделка №5 переведена на вас');
  });

  it('control.visibility.narrowed notifies holders from metadata.userIds', async () => {
    const resolveFanout = jest.fn();
    const { consumer, materialize } = build({ resolveFanout });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm-vis',
        subject: 'visibility_config/proj-1',
        payload: {
          metadata: { role: 'manager', from: 'all', to: 'own_and_department', userIds: ['u-manager'] },
        },
      },
      'control.visibility.narrowed',
    );

    expect(resolveFanout).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-manager');
    expect(materialize.mock.calls[0][0].title).toBe('Ваш охват записей сужен');
  });

  it('control.role.assignment.expiring notifies metadata.userId', async () => {
    const { consumer, materialize } = build({});

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm-exp',
        subject: 'role_assignment/ra1',
        payload: {
          metadata: { userId: 'u-owner', expiresAt: '2026-08-26T00:00:00.000Z' },
        },
      },
      'control.role.assignment.expiring',
    );

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-owner');
    expect(materialize.mock.calls[0][0].title).toBe('Срок назначения роли истекает');
  });

  it('every matrix key has an addressee handler (TODO-403 — no silent drop)', () => {
    const missing = listNotificationEventTypes().filter((k) => !getAddresseeHandler(k));
    expect(missing).toEqual([]);
  });

  it('automation.dlq.exhausted fans out to project admins (TODO-134)', async () => {
    const resolveFanout = jest.fn().mockResolvedValue(['u-admin']);
    const { consumer, materialize } = build({ resolveFanout });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm-dlq',
        subject: 'rule/r1',
        payload: { rule_id: 'r1', humanContext: { displayName: 'правило А' } },
      },
      'automation.dlq.exhausted',
    );

    expect(resolveFanout).toHaveBeenCalledWith('proj-1', ['pa']);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-admin');
  });

  it('automation.action.failed fans out to project admins (TODO-403)', async () => {
    const resolveFanout = jest.fn().mockResolvedValue(['u-admin']);
    const { consumer, materialize } = build({ resolveFanout });

    await run(
      consumer,
      {
        projectId: 'proj-1',
        messageId: 'm-fail',
        subject: 'rule/r1',
        payload: { rule_id: 'r1' },
      },
      'automation.action.failed',
    );

    expect(resolveFanout).toHaveBeenCalledWith('proj-1', ['pa']);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0].user_id).toBe('u-admin');
  });
});
