import { NotificationService } from './notification.service';
import { MongoService } from '../mongo/mongo.service';
import { MailerService } from '../mail/mailer.service';
import { UserDirectoryService } from '../mail/user-directory.service';
import { NotificationSignalService } from '../realtime/notification-signal.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import type { MetricsService } from '../metrics/metrics.service';

describe('NotificationService chat collapse (FR-CHAT-315)', () => {
  const signal = { publishBadge: jest.fn() };
  const metrics = { recordCreated: jest.fn() } as unknown as MetricsService;
  const notificationsColl = {
    findOne: jest.fn(),
    find: jest.fn(() => ({ limit: () => ({ toArray: async () => [] }) })),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
  };

  const preferencesColl = { findOne: jest.fn(async () => null) };

  const svc = new NotificationService(
    {
      notifications: () => notificationsColl,
      preferences: () => preferencesColl,
    } as unknown as MongoService,
    {} as MailerService,
    {} as UserDirectoryService,
    signal as unknown as NotificationSignalService,
    {} as RabbitMqService,
    metrics,
    { canSendEmail: jest.fn().mockResolvedValue(true) } as never,
    {
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
    } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    notificationsColl.find.mockReturnValue({ limit: () => ({ toArray: async () => [] }) });
  });

  it('collapses consecutive new_message into one row in the window', async () => {
    const existing = {
      _id: 'oid1',
      data_json: JSON.stringify({
        dedup_message_ids: ['m1'],
        dedup_event_ids: ['e1:u1'],
        counter: 1,
      }),
    };
    notificationsColl.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    notificationsColl.updateOne.mockResolvedValue({});

    const ok = await svc.materializeChatNotification({
      project_id: 'p1',
      user_id: 'u1',
      event_message_id: 'e2:u1',
      bus_message_id: 'm2',
      conversation_id: 'c1',
      conversation_title: 'Общий',
      seq: 2,
      is_mention: false,
      event_type: 'chat.message.created',
      severity: 'info',
      channels: ['in_app'],
      title: 'Новое сообщение',
      body: 'preview',
      entity_type: 'conversation',
      entity_id: 'c1',
      data_payload: { conversationId: 'c1' },
    });

    expect(ok).toBe(true);
    expect(notificationsColl.updateOne).toHaveBeenCalledWith(
      { _id: 'oid1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          body: '2 новых сообщений в «Общий»',
        }),
      }),
    );
    expect(signal.publishBadge).toHaveBeenCalledWith('u1', 'p1');
  });

  it('folds a lost insert race into the existing window row', async () => {
    const raced = {
      _id: 'oid-race',
      data_json: JSON.stringify({
        dedup_message_ids: ['m1'],
        dedup_event_ids: ['e1:u1'],
        counter: 1,
      }),
    };
    notificationsColl.findOne
      .mockResolvedValueOnce(null) // chatBusEventAlreadyProcessed event id
      .mockResolvedValueOnce(null) // no window row yet
      .mockResolvedValueOnce(raced); // after lost insert
    notificationsColl.insertOne.mockRejectedValue({ code: 11000 });
    notificationsColl.updateOne.mockResolvedValue({});

    const ok = await svc.materializeChatNotification({
      project_id: 'p1',
      user_id: 'u1',
      event_message_id: 'e2:u1',
      bus_message_id: 'm2',
      conversation_id: 'c1',
      conversation_title: 'Общий',
      seq: 2,
      is_mention: false,
      event_type: 'chat.message.created',
      severity: 'info',
      channels: ['in_app'],
      title: 'Новое сообщение',
      body: 'preview',
      entity_type: 'conversation',
      entity_id: 'c1',
      data_payload: { conversationId: 'c1' },
    });

    expect(ok).toBe(true);
    expect(notificationsColl.updateOne).toHaveBeenCalledWith(
      { _id: 'oid-race' },
      expect.objectContaining({
        $set: expect.objectContaining({
          body: '2 новых сообщений в «Общий»',
        }),
      }),
    );
  });

  it('materializes mention without collapse path', async () => {
    notificationsColl.findOne.mockResolvedValue(null);
    notificationsColl.insertOne.mockResolvedValue({});
    (svc as unknown as { deliver: () => Promise<unknown> }).deliver = jest.fn(async () => ({
      status: 'none',
    }));

    const ok = await svc.materializeChatNotification({
      project_id: 'p1',
      user_id: 'u1',
      event_message_id: 'e3:u1',
      bus_message_id: 'm3',
      conversation_id: 'c1',
      is_mention: true,
      event_type: 'chat.message.created',
      severity: 'important',
      channels: ['in_app', 'email'],
      title: 'Вас упомянули',
      body: '@you',
      entity_type: 'conversation',
      entity_id: 'c1',
      data_payload: { conversationId: 'c1' },
    });

    expect(ok).toBe(true);
    expect(notificationsColl.insertOne).toHaveBeenCalled();
  });
});
