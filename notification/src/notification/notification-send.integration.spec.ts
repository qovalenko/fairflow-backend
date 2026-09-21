import type { Db, MongoClient } from 'mongodb';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { NotificationService } from './notification.service';
import type { MongoService } from '../mongo/mongo.service';

/**
 * Notification Send integration (QA-CI wave 2, automation-notification-flow).
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set. Exercises
 * NotificationService.send against REAL Mongo (notification_messages) — the same
 * persistence path automation's gRPC Send hits. Cross-domain gRPC wiring is covered
 * in automation/src/automation/automation-notification-flow.integration.spec.ts.
 */

jest.setTimeout(30_000);

function mongoAdapter(db: Db): MongoService {
  return {
    notifications: () => db.collection('notification_messages'),
    preferences: () => db.collection('notification_prefs'),
    scheduledReminders: () => db.collection('notification_scheduled_reminders'),
    healthPing: async () => {
      await db.admin().ping();
    },
  } as unknown as MongoService;
}

function buildService(db: Db): NotificationService {
  const mailer = { isEnabled: () => false, sendMail: jest.fn() };
  const directory = { resolveEmail: jest.fn(async () => '') };
  const signal = { publishBadge: jest.fn() };
  const rabbit = { publishEnvelope: jest.fn(async () => undefined) };
  const metrics = {
    recordCreated: jest.fn(),
    recordEmailSent: jest.fn(),
    recordEmailFailed: jest.fn(),
    recordSuppressed: jest.fn(),
  };
  const pointCheck = { canSendEmail: jest.fn(async () => true) };
  const controlMembers = {
    getEffectiveModulesWithStatus: jest.fn(async () => ({ modules: ['notifications'], ok: true })),
  } as never;
  return new NotificationService(
    mongoAdapter(db),
    mailer as never,
    directory as never,
    signal as never,
    rabbit as never,
    metrics as never,
    pointCheck as never,
    controlMembers,
  );
}

describeMongoIntegration('NotificationService.send (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('notification-send');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    await db.collection('notification_messages').createIndex(
      { user_id: 1, message_id: 1 },
      { unique: true, sparse: true },
    );
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  it('persists an in-app row and marks it sent', async () => {
    const service = buildService(db);
    const projectId = id('proj');
    const userId = id('user');

    const msg = await service.send({
      project_id: projectId,
      user_id: userId,
      channel: 'in_app',
      title: 'Тест интеграции',
      body: 'Тело уведомления',
      data_json: JSON.stringify({ source: 'integration-spec' }),
      email_to: '',
    });

    expect(msg.id).toBeTruthy();
    const stored = await db.collection('notification_messages').findOne({ id: msg.id });
    expect(stored?.project_id).toBe(projectId);
    expect(stored?.user_id).toBe(userId);
    expect(stored?.status).toBe('sent');
    expect(stored?.readed).toBe(false);
  });

  it('deduplicates on idempotency_key scoped by project', async () => {
    const service = buildService(db);
    const projectId = id('proj');
    const userId = id('user');
    const idem = id('idem');

    const first = await service.send({
      project_id: projectId,
      user_id: userId,
      channel: 'in_app',
      title: 'A',
      body: 'B',
      data_json: '{}',
      email_to: '',
      idempotency_key: idem,
    });
    const second = await service.send({
      project_id: projectId,
      user_id: userId,
      channel: 'in_app',
      title: 'A2',
      body: 'B2',
      data_json: '{}',
      email_to: '',
      idempotency_key: idem,
    });

    expect(second.id).toBe(first.id);
    const count = await db.collection('notification_messages').countDocuments({
      user_id: userId,
      message_id: `${projectId}:${idem}`,
    });
    expect(count).toBe(1);
  });
});
