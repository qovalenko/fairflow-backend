import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { NotificationGrpcController } from './notification.grpc.controller';
import type { NotificationService } from './notification.service';

const PID = 'proj-trusted';

function metadata(over: Partial<Record<string, string>> = {}): Metadata {
  const m = new Metadata();
  if (over.projectId) m.set(GW_METADATA.PROJECT_ID, over.projectId);
  if (over.userId) m.set(GW_METADATA.USER_ID, over.userId);
  return m;
}

function stubService(): jest.Mocked<
  Pick<
    NotificationService,
    | 'send'
    | 'list'
    | 'markRead'
    | 'markAllRead'
    | 'getCount'
    | 'getPreferences'
    | 'updatePreferences'
    | 'getCatalog'
  >
> {
  return {
    send: jest.fn().mockResolvedValue({ notification_id: 'n1' }),
    list: jest.fn().mockResolvedValue({ list: [], total: 0 }),
    markRead: jest.fn().mockResolvedValue({ ok: true }),
    markAllRead: jest.fn().mockResolvedValue({ updated: 2 }),
    getCount: jest.fn().mockResolvedValue({ count: 5 }),
    getPreferences: jest.fn().mockResolvedValue({ email_mode: 'instant' }),
    updatePreferences: jest.fn().mockResolvedValue({ ok: true }),
    getCatalog: jest.fn().mockResolvedValue({ categories: [] }),
  };
}

describe('NotificationGrpcController — projectId resolution', () => {
  it('Send: trusted x-project-id is used when body omits project_id', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.send(
      { user_id: 'u1', title: 'Hi', body: 'Msg' },
      metadata({ projectId: PID }),
    );
    expect(svc.send).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PID, user_id: 'u1', title: 'Hi' }),
    );
  });

  it('ListNotifications: rejects when body projectId conflicts with metadata', () => {
    const ctrl = new NotificationGrpcController(stubService() as unknown as NotificationService);
    expect(() => ctrl.list({ projectId: 'evil' }, metadata({ projectId: PID }))).toThrow(
      'projectId in request body does not match trusted x-project-id metadata',
    );
  });

  it('GetCatalog: falls back to body projectId when metadata is absent (s2s)', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.getCatalog({ projectId: 'p-body' });
    expect(svc.getCatalog).toHaveBeenCalledWith('p-body');
  });
});

describe('NotificationGrpcController — field mapping', () => {
  it('Send maps camelCase aliases and defaults channel to in_app', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.send(
      {
        projectId: PID,
        userId: 'u1',
        eventType: 'crm.deal.updated',
        idempotencyKey: 'idem-1',
        data_json: '{"a":1}',
      },
      metadata({ projectId: PID }),
    );
    expect(svc.send).toHaveBeenCalledWith({
      project_id: PID,
      user_id: 'u1',
      channel: 'in_app',
      title: '',
      body: '',
      data_json: '{"a":1}',
      email_to: '',
      category: '',
      event_type: 'crm.deal.updated',
      idempotency_key: 'idem-1',
    });
  });

  it('ListNotifications passes pagination defaults and optional filters', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.list({ project_id: PID, user_id: 'u1' }, metadata({ projectId: PID }));
    expect(svc.list).toHaveBeenCalledWith(PID, 'u1', 0, 25, false, undefined, undefined);
    await ctrl.list(
      {
        project_id: PID,
        user_id: 'u1',
        page_index: 2,
        page_size: 10,
        unread_only: true,
        category: 'deals',
        scope: 'project',
      },
      metadata({ projectId: PID }),
    );
    expect(svc.list).toHaveBeenLastCalledWith(PID, 'u1', 2, 10, true, 'deals', 'project');
  });

  it('MarkRead accepts notificationId camelCase alias', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.markRead(
      { project_id: PID, user_id: 'u1', notificationId: 'n-42' },
      metadata({ projectId: PID }),
    );
    expect(svc.markRead).toHaveBeenCalledWith(PID, 'u1', 'n-42');
  });

  it('GetCount defaults unread_only to true', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.getCount({ project_id: PID, user_id: 'u1' }, metadata({ projectId: PID }));
    expect(svc.getCount).toHaveBeenCalledWith(PID, 'u1', true, undefined);
  });
});

describe('NotificationGrpcController — per-user prefs (SEC-N-5)', () => {
  it('GetPreferences: metadata x-user-id wins over body user_id', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.getPreferences({ user_id: 'body-user' }, metadata({ userId: 'trusted-user' }));
    expect(svc.getPreferences).toHaveBeenCalledWith('trusted-user');
  });

  it('GetPreferences: falls back to body user_id when metadata absent', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    await ctrl.getPreferences({ userId: 'fallback-user' });
    expect(svc.getPreferences).toHaveBeenCalledWith('fallback-user');
  });

  it('UpdatePreferences: passes quiet_hours and uses metadata subject', async () => {
    const svc = stubService();
    const ctrl = new NotificationGrpcController(svc as unknown as NotificationService);
    const quiet = { from: '22:00', to: '08:00', tz: 'Europe/Moscow' };
    await ctrl.updatePreferences(
      {
        user_id: 'ignored',
        email_mode: 'digest',
        digest_time: '09:00',
        timezone: 'Europe/Moscow',
        categories: [{ category: 'deals', in_app: true, email: false }],
        quiet_hours: quiet,
      },
      metadata({ userId: 'prefs-user' }),
    );
    expect(svc.updatePreferences).toHaveBeenCalledWith({
      user_id: 'prefs-user',
      email_mode: 'digest',
      digest_time: '09:00',
      timezone: 'Europe/Moscow',
      categories: [{ category: 'deals', in_app: true, email: false }],
      quiet_hours: quiet,
    });
  });
});
