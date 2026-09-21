import {
  getNotificationEventSpec,
  notificationEventModuleId,
} from './notification-event-registry';

describe('notification-event-registry', () => {
  it('resolves deal reassignment from deals manifest', () => {
    const spec = getNotificationEventSpec('crm.deal.reassigned');
    expect(spec).toBeDefined();
    expect(spec?.moduleId).toBe('deals');
    expect(spec?.severity).toBe('info');
    expect(spec?.defaultChannels).toEqual(['in_app']);
    expect(spec?.i18n?.title.ru).toBeTruthy();
  });

  it('maps routing key to source module id', () => {
    expect(notificationEventModuleId('crm.order.final_action_failed')).toBe('orders');
  });

  it('FR-PROJ-280: registers project-member access notifications', () => {
    const assigned = getNotificationEventSpec('control.role.assigned');
    const revoked = getNotificationEventSpec('control.role.revoked');
    expect(assigned?.defaultChannels).toEqual(['in_app', 'email']);
    expect(revoked?.i18n?.title.ru).toContain('закрыт');
  });
});
