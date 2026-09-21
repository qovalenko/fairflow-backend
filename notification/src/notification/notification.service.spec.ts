import { NotificationService } from './notification.service';

function buildService() {
  const notificationsCol = {
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn().mockReturnThis(),
    countDocuments: jest.fn(),
    updateMany: jest.fn(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn(),
  };
  const prefsCol = { findOne: jest.fn(), updateOne: jest.fn() };
  const mongo = {
    notifications: () => notificationsCol,
    preferences: () => prefsCol,
  };
  const mailer = { isEnabled: () => false, sendMail: jest.fn() };
  const directory = { resolveEmail: jest.fn() };
  const signal = { publishBadge: jest.fn() };
  const rabbit = { publishEnvelope: jest.fn(async () => undefined) };
  const metrics = {
    recordCreated: jest.fn(),
    recordEmailSent: jest.fn(),
    recordEmailFailed: jest.fn(),
    recordSuppressed: jest.fn(),
  };
  const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(true) };
  const controlMembers = {
    getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
  } as never;
  const service = new NotificationService(
    mongo as never,
    mailer as never,
    directory as never,
    signal as never,
    rabbit as never,
    metrics as never,
    pointCheck as never,
    controlMembers,
  );
  return { service, notificationsCol, prefsCol, rabbit };
}

describe('NotificationService send idempotency', () => {
  it('returns existing row when idempotency key matches', async () => {
    const { service, notificationsCol } = buildService();
    const existing = {
      id: 'n1',
      project_id: 'p1',
      user_id: 'u1',
      channel: 'in_app',
      title: 't',
      body: 'b',
      data_json: '{}',
      status: 'sent',
      readed: false,
      email_to: '',
      created_at: 1,
      sent_at: 2,
      read_at: 0,
      category: 'data',
    };
    notificationsCol.findOne.mockResolvedValue(existing);
    const res = await service.send({
      project_id: 'p1',
      user_id: 'u1',
      channel: 'in_app',
      title: 't2',
      body: 'b2',
      data_json: '{}',
      email_to: '',
      category: 'data',
      idempotency_key: 'idem-1',
    });
    expect(res.id).toBe('n1');
    expect(notificationsCol.insertOne).not.toHaveBeenCalled();
    // Dedup lookup is project-scoped: the same client key in another project
    // must not return this project's row.
    expect(notificationsCol.findOne).toHaveBeenCalledWith({
      user_id: 'u1',
      message_id: 'p1:idem-1',
    });
  });

  it('stores a self-unique message_id for key-less sends (sparse index E11000 guard)', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.insertOne.mockResolvedValue({});
    notificationsCol.updateOne.mockResolvedValue({});
    await service.send({
      project_id: 'p1',
      user_id: 'u1',
      channel: 'in_app',
      title: 't',
      body: 'b',
      data_json: '{}',
      email_to: '',
      category: 'data',
      idempotency_key: '',
    });
    const row = notificationsCol.insertOne.mock.calls[0][0];
    expect(row.message_id).toBe(row.id);
    expect(row.message_id).toBeTruthy();
    expect(row.expires_at).toBeInstanceOf(Date);
  });

  it('infers category from event_type when category is omitted (TODO-404)', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.insertOne.mockResolvedValue({});
    notificationsCol.updateOne.mockResolvedValue({});
    await service.send({
      project_id: 'p1',
      user_id: 'u1',
      channel: 'in_app',
      title: 't',
      body: 'b',
      data_json: '{}',
      email_to: '',
      event_type: 'crm.activity.overdue',
      idempotency_key: '',
    });
    const row = notificationsCol.insertOne.mock.calls[0][0];
    expect(row.category).toBe('activities');
    expect(row.event_type).toBe('crm.activity.overdue');
  });
});

describe('NotificationService audit facts', () => {
  it('markRead emits notification.message.read', async () => {
    const { service, notificationsCol, rabbit } = buildService();
    notificationsCol.findOne.mockResolvedValue({
      _id: 'oid',
      id: 'n1',
      project_id: 'p1',
      user_id: 'u1',
      channel: 'in_app',
      title: 't',
      body: 'b',
      data_json: '{}',
      status: 'sent',
      readed: false,
      email_to: '',
      created_at: 1,
      sent_at: 2,
      read_at: 0,
    });
    notificationsCol.updateOne.mockResolvedValue({});
    notificationsCol.countDocuments.mockResolvedValue(0);
    await service.markRead('p1', 'u1', 'n1');
    expect(rabbit.publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.message.read',
        projectId: 'p1',
        userId: 'u1',
        payload: { notification_id: 'n1', batch: false },
      }),
    );
  });

  it('markAllRead emits batch notification.message.read when rows updated', async () => {
    const { service, notificationsCol, rabbit } = buildService();
    notificationsCol.updateMany.mockResolvedValue({ modifiedCount: 3 });
    await service.markAllRead('p1', 'u1');
    expect(rabbit.publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.message.read',
        projectId: 'p1',
        userId: 'u1',
        payload: { batch: true, updated: 3 },
      }),
    );
  });

  it('updatePreferences emits notification.preferences.changed', async () => {
    const { service, prefsCol, rabbit } = buildService();
    prefsCol.updateOne.mockResolvedValue({});
    prefsCol.findOne.mockResolvedValue({
      user_id: 'u1',
      email_mode: 'daily',
      digest_time: '09:00',
      timezone: 'UTC',
      categories: [],
      quiet_hours: null,
      updated_at: 100,
    });
    await service.updatePreferences({ user_id: 'u1', email_mode: 'daily' });
    expect(rabbit.publishEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.preferences.changed',
        userId: 'u1',
        payload: expect.objectContaining({ user_id: 'u1', email_mode: 'daily' }),
      }),
    );
  });
});

describe('NotificationService feed filter', () => {
  it('includes personal-scope rows in list queries', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.countDocuments.mockResolvedValue(0);
    notificationsCol.toArray.mockResolvedValue([]);
    await service.list('p1', 'u1', 0, 10, false);
    const filter = notificationsCol.countDocuments.mock.calls[0][0];
    expect(filter.user_id).toBe('u1');
    expect(filter.$or).toEqual([
      { project_id: 'p1', scope_kind: { $ne: 'user' } },
      { scope_kind: 'user' },
    ]);
  });

  it('scope=all queries all projects for the user (FR-NOTIF-060)', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.countDocuments.mockResolvedValue(0);
    notificationsCol.toArray.mockResolvedValue([]);
    await service.list('p1', 'u1', 0, 10, false, undefined, 'all');
    const filter = notificationsCol.countDocuments.mock.calls[0][0];
    expect(filter).toEqual({ user_id: 'u1', status: { $ne: 'suppressed' } });
  });

  it('getCount scope=all does not constrain project_id (FR-NOTIF-060)', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.countDocuments.mockResolvedValue(3);
    const res = await service.getCount('p1', 'u1', true, 'all');
    expect(res.count).toBe(3);
    expect(notificationsCol.countDocuments.mock.calls[0][0]).toEqual({
      user_id: 'u1',
      readed: false,
      status: { $ne: 'suppressed' },
    });
  });

  it('markRead finds the row by id+user across projects (FR-NOTIF-060)', async () => {
    const { service, notificationsCol } = buildService();
    notificationsCol.findOne.mockResolvedValue({
      _id: 'oid',
      id: 'n-other',
      project_id: 'p-other',
      user_id: 'u1',
      channel: 'in_app',
      title: 't',
      body: 'b',
      data_json: '{}',
      status: 'sent',
      readed: false,
      email_to: '',
      created_at: 1,
      sent_at: 2,
      read_at: 0,
    });
    notificationsCol.updateOne.mockResolvedValue({});
    notificationsCol.countDocuments.mockResolvedValue(0);
    await service.markRead('p-current', 'u1', 'n-other');
    expect(notificationsCol.findOne).toHaveBeenCalledWith({
      id: 'n-other',
      user_id: 'u1',
    });
  });
});

describe('NotificationService point-check suppression (FR-NOTIF-330)', () => {
  it('email-only row becomes status=suppressed when point-check denies', async () => {
    const notificationsCol = {
      findOne: jest.fn().mockResolvedValue(null),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockReturnThis(),
      countDocuments: jest.fn(),
      updateMany: jest.fn(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn(),
    };
    const prefsCol = {
      findOne: jest.fn().mockResolvedValue({
        user_id: 'u1',
        email_mode: 'immediate',
        categories: [],
      }),
    };
    const metrics = {
      recordCreated: jest.fn(),
      recordEmailSent: jest.fn(),
      recordEmailFailed: jest.fn(),
      recordSuppressed: jest.fn(),
    };
    const pointCheck = { canSendEmail: jest.fn().mockResolvedValue(false) };
    const controlMembers = {
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
    } as never;
    const service = new NotificationService(
      { notifications: () => notificationsCol, preferences: () => prefsCol } as never,
      { isEnabled: () => true, sendMail: jest.fn() } as never,
      { resolveEmail: jest.fn() } as never,
      { publishBadge: jest.fn() } as never,
      { publishEnvelope: jest.fn(async () => undefined) } as never,
      metrics as never,
      pointCheck as never,
      controlMembers,
    );

    const inserted = await service.materialize({
      project_id: 'p1',
      user_id: 'u1',
      dedup_key: 'k1',
      category: 'sales',
      event_type: 'crm.order.final_action_failed',
      severity: 'critical',
      channels: ['email'],
      title: 'T',
      body: 'B',
      entity_type: 'order',
      entity_id: 'o-1',
    });

    expect(inserted).toBe(true);
    expect(pointCheck.canSendEmail).toHaveBeenCalled();
    const set = notificationsCol.updateOne.mock.calls[0][1].$set as { status: string };
    expect(set.status).toBe('suppressed');
    expect(metrics.recordSuppressed).toHaveBeenCalledWith('point_check');
    expect(metrics.recordSuppressed).toHaveBeenCalledTimes(1);
  });
});
