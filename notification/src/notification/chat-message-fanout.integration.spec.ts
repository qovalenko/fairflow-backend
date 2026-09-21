import type { Db, MongoClient } from 'mongodb';
import { buildOutboxRow } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { NotificationConsumer } from './notification.consumer';
import { NotificationService } from './notification.service';
import type { ControlMembersService } from '../control/control-members.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { ScheduledReminderService } from './scheduled-reminder.service';

/**
 * Notification integration (QA-CI wave 2 chat-flow) — real Mongo materialization.
 *
 * Exercises the ACTUAL chain notification consumer → NotificationService against
 * real `notification_messages` rows. Control gRPC is the only mocked boundary
 * (separate domain); chat facts arrive as the same envelope shape the chat outbox
 * relay publishes (`chat.message.created`).
 *
 * WS session jti deny-list is enforced in gateway (SessionDenyListService → auth);
 * here we prove the downstream fan-out respects verified project membership
 * (analogous to WS subscribe revalidate dropping non-members).
 */

interface NotificationMongoAdapter {
  notifications: () => ReturnType<Db['collection']>;
  preferences: () => ReturnType<Db['collection']>;
  scheduledReminders: () => ReturnType<Db['collection']>;
}

function buildNotificationStack(
  mongo: NotificationMongoAdapter,
  members: Partial<ControlMembersService>,
) {
  const mailer = { isEnabled: () => false, sendMail: jest.fn() };
  const directory = { resolveEmail: jest.fn().mockResolvedValue('') };
  const signal = { publishBadge: jest.fn().mockResolvedValue(undefined) };
  const rabbit = { publishEnvelope: jest.fn().mockResolvedValue(undefined) };
  const metrics = {
    recordCreated: jest.fn(),
    recordEmailSent: jest.fn(),
    recordEmailFailed: jest.fn(),
    recordSuppressed: jest.fn(),
    recordEventConsumed: jest.fn(),
    setConsumerLagMs: jest.fn(),
    observeFanout: jest.fn(),
  } as unknown as MetricsService;
  const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(true) };
  const membersSvc = {
    getMembersWithStatus: jest
      .fn()
      .mockResolvedValue({
        members: [
          { id: 'u-recipient', role: 'member' },
          { id: 'u-sender', role: 'member' },
        ],
        ok: true,
      }),
    getEffectiveModulesWithStatus: jest
      .fn()
      .mockResolvedValue({ modules: ['chat'], ok: true }),
    isModuleEnabled: jest.fn(() => true),
    ...members,
  } as unknown as ControlMembersService;

  const notifications = new NotificationService(
    mongo as never,
    mailer as never,
    directory as never,
    signal as never,
    rabbit as never,
    metrics,
    pointCheck as never,
    membersSvc,
  );
  const consumer = new NotificationConsumer(
    {} as never,
    notifications,
    membersSvc,
    metrics,
    { upsertFromEvent: jest.fn(), cancelByReminderKey: jest.fn() } as unknown as ScheduledReminderService,
  );
  return { consumer, notifications, membersSvc, metrics, signal, mongo };
}

function chatOutboxPayload(
  over: Partial<{
    projectId: string;
    conversationId: string;
    messageId: string;
    senderId: string;
    recipientUserIds: string[];
    mentionIds: string[];
    preview: string;
    conversationTitle: string;
  }> = {},
): Record<string, unknown> {
  const projectId = over.projectId ?? id('proj');
  const conversationId = over.conversationId ?? id('conv');
  const messageId = over.messageId ?? id('msg');
  const senderId = over.senderId ?? 'u-sender';
  const intent = {
    type: 'chat.message.created',
    source: 'chat',
    projectId,
    userId: senderId,
    idempotencyKey: `cid-${messageId}`,
    subject: `conversation/${conversationId}`,
    payload: {
      conversationId,
      messageId,
      seq: 1,
      senderId,
      recipientUserIds: over.recipientUserIds ?? ['u-recipient'],
      mentionIds: over.mentionIds ?? [],
      isMention: (over.mentionIds ?? []).length > 0,
      scope: { kind: 'project', scopeId: projectId },
      preview: over.preview ?? 'Привет',
      entityRefs: [],
      conversationTitle: over.conversationTitle ?? 'Общий',
    },
  };
  const row = buildOutboxRow(intent);
  return row.envelope as unknown as Record<string, unknown>;
}

async function materializeChat(
  consumer: NotificationConsumer,
  payload: Record<string, unknown>,
): Promise<void> {
  await (
    consumer as unknown as { materialize: (p: Record<string, unknown>, k: string) => Promise<void> }
  ).materialize(payload, 'chat.message.created');
}

jest.setTimeout(30_000);

describeMongoIntegration('chat.message.created fan-out (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: NotificationMongoAdapter;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('notification');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    mongo = {
      notifications: () => db.collection('notification_messages'),
      preferences: () => db.collection('notification_preferences'),
      scheduledReminders: () => db.collection('notification_scheduled_reminders'),
    };
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  beforeEach(async () => {
    await mongo.notifications().deleteMany({});
  });

  it('materializes in_app notification rows for verified recipients (ordinary message)', async () => {
    const pid = id('proj');
    const convId = id('conv');
    const msgId = id('msg');
    const recipient = id('user');
    const { consumer, signal } = buildNotificationStack(mongo, {
      getMembersWithStatus: jest.fn().mockResolvedValue({
        members: [
          { id: recipient, role: 'member' },
          { id: 'u-sender', role: 'member' },
        ],
        ok: true,
      }),
    });

    await materializeChat(
      consumer,
      chatOutboxPayload({
        projectId: pid,
        conversationId: convId,
        messageId: msgId,
        recipientUserIds: [recipient],
        preview: 'Новости',
        conversationTitle: 'Канал',
      }),
    );

    const rows = await mongo
      .notifications()
      .find({ user_id: recipient, project_id: pid })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: recipient,
      project_id: pid,
      scope_kind: 'project',
      event_type: 'chat.message.created',
      entity_type: 'conversation',
      entity_id: convId,
      readed: false,
    });
    expect(rows[0].message_id).toMatch(/^chat:win:/);
    expect(signal.publishBadge).toHaveBeenCalledWith(recipient, pid);
  });

  it('@mention path creates a dedicated mention notification (not collapsed window)', async () => {
    const pid = id('proj');
    const convId = id('conv');
    const msgId = id('msg');
    const recipient = id('user');
    const { consumer } = buildNotificationStack(mongo, {
      getMembersWithStatus: jest.fn().mockResolvedValue({
        members: [
          { id: recipient, role: 'member' },
          { id: 'u-sender', role: 'member' },
        ],
        ok: true,
      }),
    });

    await materializeChat(
      consumer,
      chatOutboxPayload({
        projectId: pid,
        conversationId: convId,
        messageId: msgId,
        recipientUserIds: [recipient],
        mentionIds: [recipient],
        preview: `@${recipient} смотри`,
      }),
    );

    const rows = await mongo.notifications().find({ user_id: recipient, project_id: pid }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('mention');
    expect(rows[0].severity).toBe('important');
    expect(rows[0].message_id).not.toMatch(/^chat:win:/);
    const data = JSON.parse(String(rows[0].data_json));
    expect(data.isMention).toBe(true);
  });

  it('drops recipients who are not project members (membership gate — WS revalidate analogue)', async () => {
    const pid = id('proj');
    const { consumer } = buildNotificationStack(mongo, {
      getMembersWithStatus: jest.fn().mockResolvedValue({
        members: [{ id: 'u-sender', role: 'member' }],
        ok: true,
      }),
    });

    await materializeChat(
      consumer,
      chatOutboxPayload({
        projectId: pid,
        recipientUserIds: ['u-outsider'],
      }),
    );

    const rows = await mongo.notifications().find({ user_id: 'u-outsider' }).toArray();
    expect(rows).toHaveLength(0);
  });

  it('control unavailable → throws (nack/retry ladder, no unverified delivery)', async () => {
    const { consumer } = buildNotificationStack(mongo, {
      getMembersWithStatus: jest.fn().mockResolvedValue({ members: [], ok: false }),
    });

    await expect(
      materializeChat(
        consumer,
        chatOutboxPayload({ recipientUserIds: ['u-recipient'] }),
      ),
    ).rejects.toThrow(/cannot verify chat addressees/);
  });

  it('org-scoped DM materializes under scope_kind=user (TODO-205)', async () => {
    const orgId = id('org');
    const convId = id('conv');
    const msgId = id('msg');
    const recipient = id('user');
    const { consumer } = buildNotificationStack(mongo, {});

    const envelope: Record<string, unknown> = {
      projectId: '',
      messageId: msgId,
      subject: `conversation/${convId}`,
      payload: {
        conversationId: convId,
        messageId: msgId,
        senderId: 'u-sender',
        recipientUserIds: [recipient],
        mentionIds: [],
        scope: { kind: 'org', scopeId: orgId },
        preview: 'dm hi',
        conversationTitle: 'DM',
      },
    };

    await materializeChat(consumer, envelope);

    const row = await mongo.notifications().findOne({ user_id: recipient, project_id: orgId });
    expect(row).toMatchObject({
      project_id: orgId,
      scope_kind: 'user',
      event_type: 'chat.message.created',
    });
  });

  it('end-to-end: chat outbox row shape → consumer → persisted notification', async () => {
    const pid = id('proj');
    const convId = id('conv');
    const msgId = id('msg');
    const recipient = id('user');
    const intent = {
      type: 'chat.message.created',
      source: 'chat',
      projectId: pid,
      userId: 'u-sender',
      idempotencyKey: 'cid-chain',
      subject: `conversation/${convId}`,
      payload: {
        conversationId: convId,
        messageId: msgId,
        seq: 2,
        senderId: 'u-sender',
        recipientUserIds: [recipient],
        mentionIds: [],
        isMention: false,
        scope: { kind: 'project', scopeId: pid },
        preview: 'chain test',
        entityRefs: [],
        conversationTitle: 'E2E',
      },
    };
    const outboxRow = buildOutboxRow(intent);
    const { consumer } = buildNotificationStack(mongo, {
      getMembersWithStatus: jest.fn().mockResolvedValue({
        members: [
          { id: recipient, role: 'member' },
          { id: 'u-sender', role: 'member' },
        ],
        ok: true,
      }),
    });

    await materializeChat(consumer, outboxRow.envelope as unknown as Record<string, unknown>);

    const stored = await mongo.notifications().findOne({ user_id: recipient, project_id: pid });
    expect(stored?.body).toContain('E2E');
    expect(stored?.entity_id).toBe(convId);
    const data = JSON.parse(String(stored?.data_json));
    expect(data.preview).toBe('chain test');
  });
});
