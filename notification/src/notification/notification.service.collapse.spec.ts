import { NotificationService } from './notification.service';

function buildService() {
  const notificationsCol = {
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
  };
  const prefsCol = {
    findOne: jest.fn().mockResolvedValue({
      user_id: 'u1',
      email_mode: 'immediate',
      categories: [{ category: 'data', in_app: true, email: false }],
    }),
  };
  const mongo = {
    notifications: () => notificationsCol,
    preferences: () => prefsCol,
  };
  const metrics = {
    recordCreated: jest.fn(),
    recordSuppressed: jest.fn(),
    recordEmailSent: jest.fn(),
    recordEmailFailed: jest.fn(),
  };
  const service = new NotificationService(
    mongo as never,
    { isEnabled: () => false } as never,
    { resolveEmail: jest.fn() } as never,
    { publishBadge: jest.fn() } as never,
    { publishEnvelope: jest.fn() } as never,
    metrics as never,
    { canSendEmail: jest.fn().mockResolvedValue(true) } as never,
    {
      getEffectiveModulesWithStatus: jest.fn().mockResolvedValue({ modules: [], ok: true }),
    } as never,
  );
  return { service, notificationsCol, metrics };
}

describe('NotificationService collapse (FR-NOTIF-230)', () => {
  it('increments counter on duplicate collapse_key within window instead of inserting', async () => {
    const { service, notificationsCol, metrics } = buildService();
    const existing = {
      _id: 'oid',
      channels: ['in_app'],
      user_id: 'u1',
      project_id: 'p1',
      dedup_message_ids: ['msg-1'],
      data_json: '{}',
      body: 'Контакт изменён',
    };
    notificationsCol.findOne.mockResolvedValue(existing);
    const inserted = await service.materialize({
      project_id: 'p1',
      user_id: 'u1',
      dedup_key: 'idem:u1',
      category: 'data',
      event_type: 'crm.contact.drift',
      severity: 'info',
      channels: ['in_app'],
      title: 't',
      body: 'Контакт изменён',
      entity_type: 'contact',
      entity_id: 'c1',
      source_message_id: 'msg-2',
      collapse_window_sec: 300,
    });
    expect(inserted).toBe(false);
    expect(notificationsCol.insertOne).not.toHaveBeenCalled();
    expect(notificationsCol.updateOne).toHaveBeenCalled();
    expect(metrics.recordSuppressed).toHaveBeenCalledWith('collapsed');
  });
});
