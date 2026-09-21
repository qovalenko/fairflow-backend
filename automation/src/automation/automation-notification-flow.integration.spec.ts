import 'reflect-metadata';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { Transport } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { ActionDispatcher } from './action-dispatcher.service';
import { AutomationService } from './automation.service';
import { DlqRetryService } from './dlq-retry.service';
import { EffectLedger } from './executors/effect-ledger.service';
import { NotificationExecutor } from './executors/notification-executor';
import type { ExecutorRegistry } from './executors/executor-registry.service';
import type { MongoService as AutomationMongoService } from '../mongo/mongo.service';
import type { MongoService as NotificationMongoService } from '../../../notification/src/mongo/mongo.service';
import { NotificationGrpcController } from '../../../notification/src/notification/notification.grpc.controller';
import {
  NotificationService,
} from '../../../notification/src/notification/notification.service';
import type { SecretProviderRegistry } from './secret-provider';
import type { OperatorNotifyService } from './operator-notify.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ModuleRuntimeGate } from './module-runtime-gate.service';
import type { EntitySnapshotService } from './entity-snapshot.service';
import type { RuleThrottleService } from './rule-throttle.service';
import type { AutomationMongoOutboxStore } from '../outbox/mongo-outbox.store';

/**
 * Automation → Notification integration (QA-CI wave 2, automation-notification-flow).
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set. Spins up:
 *   - a REAL in-process NotificationGrpc microservice (proto wire, keepCase loader);
 *   - REAL Mongo adapters for automation + notification collections;
 *   - REAL ActionDispatcher → NotificationExecutor → gRPC Send → NotificationService.
 *
 * Covers the operator-critical paths unit tests cannot prove:
 *   1. rule dispatch / consumeEvent trigger → in-app notification row in notification_messages;
 *   2. EffectLedger at-most-once across a broker redelivery (same generation);
 *   3. DLQ auto-retry after a transient gRPC failure → resolved row + delivered notification.
 */

jest.setTimeout(60_000);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function automationMongo(db: Db, client: MongoClient): AutomationMongoService {
  return {
    rules: () => db.collection('automation_rules'),
    executions: () => db.collection('automation_rule_executions'),
    dlq: () => db.collection('automation_dlq'),
    actionEffects: () => db.collection('automation_action_effects'),
    connections: () => db.collection('automation_connections'),
    eventHooks: () => db.collection('automation_event_hooks'),
    finalActions: () => db.collection('automation_final_actions'),
    outbox: () => db.collection('automation_event_outbox'),
    getClient: () => client,
    healthPing: async () => {
      await db.admin().ping();
    },
  } as unknown as AutomationMongoService;
}

function notificationMongo(db: Db): NotificationMongoService {
  return {
    notifications: () => db.collection('notification_messages'),
    preferences: () => db.collection('notification_prefs'),
    scheduledReminders: () => db.collection('notification_scheduled_reminders'),
    healthPing: async () => {
      await db.admin().ping();
    },
  } as unknown as NotificationMongoService;
}

function notificationDeps() {
  return {
    mailer: { isEnabled: () => false, sendMail: jest.fn() },
    directory: { resolveEmail: jest.fn(async () => '') },
    signal: { publishBadge: jest.fn() },
    rabbit: { publishEnvelope: jest.fn(async () => undefined) },
    metrics: {
      recordCreated: jest.fn(),
      recordEmailSent: jest.fn(),
      recordEmailFailed: jest.fn(),
      recordSuppressed: jest.fn(),
    },
    pointCheck: { canSendEmail: jest.fn(async () => true) },
    controlMembers: {
      getEffectiveModulesWithStatus: jest.fn(async () => ({ modules: ['notifications'], ok: true })),
    },
  };
}

type NotificationGrpcHost = {
  url: string;
  failSendRemaining: { value: number };
  close: () => Promise<void>;
};

/** In-process notification gRPC listener without auth PEP (integration harness). */
async function startNotificationGrpc(
  notifyDb: Db,
  failSendRemaining: { value: number },
): Promise<NotificationGrpcHost> {
  const deps = notificationDeps();

  class FlakyNotificationService extends NotificationService {
    async send(data: Parameters<NotificationService['send']>[0]) {
      if (failSendRemaining.value > 0) {
        failSendRemaining.value -= 1;
        throw new RpcException({ code: status.UNAVAILABLE, message: 'simulated transient outage' });
      }
      return super.send(data);
    }
  }

  const notifications = new FlakyNotificationService(
    notificationMongo(notifyDb),
    deps.mailer as never,
    deps.directory as never,
    deps.signal as never,
    deps.rabbit as never,
    deps.metrics as never,
    deps.pointCheck as never,
    deps.controlMembers as never,
  );

  @Module({
    controllers: [NotificationGrpcController],
    providers: [{ provide: NotificationService, useValue: notifications }],
  })
  class NotificationIntModule {}

  const port = await freePort();
  const protoPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'proto',
    'fairflow',
    'notification',
    'v1',
    'notification.proto',
  );
  const app = await NestFactory.createMicroservice(NotificationIntModule, {
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.notification.v1',
      protoPath,
      url: `127.0.0.1:${port}`,
      loader: { keepCase: true, arrays: true, longs: Number },
    },
  });
  await app.listen();
  return {
    url: `127.0.0.1:${port}`,
    failSendRemaining,
    close: async () => {
      await app.close();
    },
  };
}

function wireAutomationStack(
  autoDb: Db,
  autoClient: MongoClient,
  notifyDb: Db,
  grpcUrl: string,
) {
  process.env.NOTIFICATION_GRPC_URL = grpcUrl;
  process.env.AUTOMATION_SERVICE_API_KEY = 'itest-automation-service-key';
  process.env.AUTOMATION_API_KEY_ID = 'itest-automation-key-id';

  const mongo = automationMongo(autoDb, autoClient);
  const rabbit = { publishEnvelope: jest.fn(async () => undefined) } as unknown as RabbitMqService;
  const secrets = { reveal: jest.fn(), sealer: jest.fn() } as unknown as SecretProviderRegistry;
  const operatorNotify = { notify: jest.fn(async () => true) } as unknown as OperatorNotifyService;

  const ledger = new EffectLedger(mongo);
  const notificationExecutor = new NotificationExecutor(ledger);
  const executors = {
    forAction: (t: string) =>
      t === 'send_notification' || t === 'create_notification' ? notificationExecutor : null,
  } as unknown as ExecutorRegistry;

  const dispatcher = new ActionDispatcher(mongo, rabbit, executors, secrets, operatorNotify);
  const dlqRetry = new DlqRetryService(mongo, dispatcher, rabbit);

  const gate = { isAutomationRuntimeActive: jest.fn(async () => true) } as unknown as ModuleRuntimeGate;
  const entitySnapshot = {
    fetchRecord: jest.fn(async () => ({ entity_type: 'deal', entity_id: 'd1' })),
  } as unknown as EntitySnapshotService;
  const throttle = { isThrottled: jest.fn(async () => false) } as unknown as RuleThrottleService;
  const outbox = {
    withOutbox: jest.fn(async (work: (session?: unknown) => Promise<unknown>) => work(undefined)),
  } as unknown as AutomationMongoOutboxStore;

  const automation = new AutomationService(
    mongo,
    rabbit,
    gate,
    dispatcher,
    secrets,
    executors,
    dlqRetry,
    entitySnapshot,
    throttle,
    operatorNotify,
    outbox,
  );

  return { mongo, dispatcher, dlqRetry, automation, notifyCol: () => notifyDb.collection('notification_messages') };
}

describeMongoIntegration('automation → notification (real Mongo + gRPC)', () => {
  let autoClient: MongoClient;
  let autoDb: Db;
  let closeAuto: () => Promise<void>;
  let notifyClient: MongoClient;
  let notifyDb: Db;
  let closeNotify: () => Promise<void>;
  let grpcHost: NotificationGrpcHost;
  let failSendRemaining: { value: number };

  beforeAll(async () => {
    const auto = await connectEphemeralMongo('automation-int');
    autoClient = auto.client;
    autoDb = auto.db;
    closeAuto = auto.close;

    const notify = await connectEphemeralMongo('notification-int');
    notifyClient = notify.client;
    notifyDb = notify.db;
    closeNotify = notify.close;

    await autoDb.collection('automation_action_effects').createIndex({ effect_key: 1 }, { unique: true });
    await autoDb.collection('automation_dlq').createIndex({ status: 1, next_retry_at: 1 });
    await autoDb.collection('automation_rule_executions').createIndex(
      { idempotency_key: 1 },
      { unique: true, sparse: true },
    );

    failSendRemaining = { value: 0 };
    grpcHost = await startNotificationGrpc(notifyDb, failSendRemaining);
  }, 120_000);

  afterAll(async () => {
    if (grpcHost) await grpcHost.close();
    delete process.env.NOTIFICATION_GRPC_URL;
    delete process.env.AUTOMATION_SERVICE_API_KEY;
    delete process.env.AUTOMATION_API_KEY_ID;
    if (closeNotify) await closeNotify();
    if (closeAuto) await closeAuto();
  });

  it('dispatchOne(send_notification) reaches NotificationGrpc.Send and persists a feed row', async () => {
    const projectId = id('proj');
    const userId = id('user');
    const { dispatcher, notifyCol } = wireAutomationStack(autoDb, autoClient, notifyDb, grpcHost.url);

    const executionId = id('exec');
    const result = await dispatcher.dispatchOne(
      'send_notification',
      { config: { title: 'Сделка обновлена', body: 'Проверьте карточку {{trigger.dealId}}' } },
      {
        projectId,
        ruleId: id('rule'),
        ruleName: 'Уведомить',
        executionId,
        source: 'integration',
        payload: { deal_id: 'd-42', dealId: 'd-42', assignee_id: userId, assigneeId: userId },
        actor: 'system',
        userId: '',
        actionIndex: 0,
        retryGeneration: 0,
      },
    );

    expect(result.status).toBe('success');
    const rows = await notifyCol()
      .find({ project_id: projectId, user_id: userId })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Сделка обновлена');
    expect(rows[0].body).toBe('Проверьте карточку d-42');
    expect(JSON.parse(String(rows[0].data_json))).toMatchObject({
      source: 'automation',
      deal_id: 'd-42',
    });
  });

  it('EffectLedger suppresses a redelivery of the same attempt (one notification row)', async () => {
    const projectId = id('proj');
    const userId = id('user');
    const { dispatcher, notifyCol } = wireAutomationStack(autoDb, autoClient, notifyDb, grpcHost.url);
    const executionId = id('exec');
    const action = { config: { title: 'Раз', body: 'Один раз' } };
    const ctx = {
      projectId,
      ruleId: id('rule'),
      executionId,
      source: 'integration',
      payload: { assignee_id: userId },
      actor: 'system' as const,
      userId: '',
      actionIndex: 0,
      retryGeneration: 0,
    };

    expect((await dispatcher.dispatchOne('send_notification', action, ctx)).status).toBe('success');
    expect((await dispatcher.dispatchOne('send_notification', action, ctx)).status).toBe('success');

    const rows = await notifyCol().find({ project_id: projectId, user_id: userId }).toArray();
    expect(rows).toHaveLength(1);
  });

  it('consumeEvent trigger → send_notification delivers through the real dispatcher chain', async () => {
    const projectId = id('proj');
    const userId = id('user');
    const ruleId = id('rule');
    const { mongo, automation, notifyCol } = wireAutomationStack(
      autoDb,
      autoClient,
      notifyDb,
      grpcHost.url,
    );

    await mongo.rules().insertOne({
      _id: new ObjectId(),
      id: ruleId,
      project_id: projectId,
      name: 'On deal created',
      description: '',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '{}',
      actions_json: JSON.stringify([
        {
          type: 'send_notification',
          config: { title: 'Новая сделка', body: 'Сделка {{trigger.dealId}} ждёт вас' },
        },
      ]),
      created_by: userId,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_executed_at: 0,
      stats_json: '{}',
    });

    const disposition = await automation.consumeEvent({
      type: 'crm.deal.created',
      version: 1,
      messageId: id('msg'),
      timestamp: new Date().toISOString(),
      source: 'pipe',
      projectId,
      payload: { deal_id: 'd-new', dealId: 'd-new', assignee_id: userId, assigneeId: userId },
      idempotencyKey: id('idem'),
    });

    expect(disposition).toBe('ack');
    const rows = await notifyCol().find({ project_id: projectId, user_id: userId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('Сделка d-new ждёт вас');
    const exec = await mongo
      .executions()
      .findOne({ project_id: projectId, rule_id: ruleId });
    expect(exec?.status).toBe('success');
  });

  it('DLQ auto-retry: transient Send failure → sweep → resolved + notification delivered', async () => {
    failSendRemaining.value = 1;
    const projectId = id('proj');
    const userId = id('user');
    const ruleId = id('rule');
    const executionId = id('exec');
    const { mongo, dispatcher, dlqRetry, notifyCol } = wireAutomationStack(
      autoDb,
      autoClient,
      notifyDb,
      grpcHost.url,
    );

    await mongo.rules().insertOne({
      _id: new ObjectId(),
      id: ruleId,
      project_id: projectId,
      name: 'Retry me',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '{}',
      actions_json: '[]',
      created_at: Date.now(),
      updated_at: Date.now(),
      last_executed_at: 0,
      stats_json: '{}',
    });

    const action = {
      type: 'send_notification',
      config: { title: 'DLQ retry', body: 'После сбоя' },
    };
    const fail = await dispatcher.dispatchOne('send_notification', action, {
      projectId,
      ruleId,
      executionId,
      source: 'integration',
      payload: { assignee_id: userId },
      actor: 'system',
      actionIndex: 0,
      retryGeneration: 0,
    });
    expect(fail.status).toBe('fail');
    expect(fail.dlq_id).toBeTruthy();

    const dlqRow = await mongo.dlq().findOne({ project_id: projectId, id: fail.dlq_id });
    expect(dlqRow?.status).toBe('failed');

    await mongo.dlq().updateOne(
      { project_id: projectId, id: fail.dlq_id },
      { $set: { next_retry_at: Date.now() - 1, status: 'failed' } },
    );

    const handled = await dlqRetry.sweep(Date.now());
    expect(handled).toBeGreaterThanOrEqual(1);

    const after = await mongo.dlq().findOne({ project_id: projectId, id: fail.dlq_id });
    expect(after?.status).toBe('resolved');

    const rows = await notifyCol().find({ project_id: projectId, user_id: userId }).toArray();
    expect(rows.some((r) => r.title === 'DLQ retry')).toBe(true);
  });

  it('manual RetryDlq: operator retry after transient failure → resolved + notification', async () => {
    failSendRemaining.value = 1;
    const projectId = id('proj');
    const userId = id('user');
    const ruleId = id('rule');
    const executionId = id('exec');
    const { mongo, dispatcher, automation, notifyCol } = wireAutomationStack(
      autoDb,
      autoClient,
      notifyDb,
      grpcHost.url,
    );

    await mongo.rules().insertOne({
      _id: new ObjectId(),
      id: ruleId,
      project_id: projectId,
      name: 'Manual retry',
      enabled: true,
      state: 'enabled',
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: 'crm.deal.created' }),
      conditions_json: '{}',
      actions_json: '[]',
      created_at: Date.now(),
      updated_at: Date.now(),
      last_executed_at: 0,
      stats_json: '{}',
    });

    const action = {
      type: 'send_notification',
      config: { title: 'Manual DLQ', body: 'Оператор перезапустил' },
    };
    const fail = await dispatcher.dispatchOne('send_notification', action, {
      projectId,
      ruleId,
      executionId,
      source: 'integration',
      payload: { assignee_id: userId },
      actor: 'system',
      actionIndex: 0,
      retryGeneration: 0,
    });
    expect(fail.status).toBe('fail');
    expect(fail.dlq_id).toBeTruthy();

    const settled = await automation.retryDlq(projectId, fail.dlq_id!);
    expect(settled.status).toBe('resolved');

    const after = await mongo.dlq().findOne({ project_id: projectId, id: fail.dlq_id });
    expect(after?.status).toBe('resolved');

    const rows = await notifyCol().find({ project_id: projectId, user_id: userId }).toArray();
    expect(rows.some((r) => r.title === 'Manual DLQ')).toBe(true);
  });
});
