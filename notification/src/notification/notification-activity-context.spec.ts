import {
  activityNotificationBody,
  activityTypeLabel,
} from './notification-activity-context';

describe('notification-activity-context (NFR-080)', () => {
  it('renders activity type labels from the i18n map', () => {
    expect(activityTypeLabel('task')).toBe('Задача');
    expect(activityTypeLabel('task', 'en')).toBe('Task');
    expect(activityTypeLabel('unknown', 'en')).toBe('unknown');
    expect(activityTypeLabel('', 'en')).toBe('Activity');
  });

  it('builds supplemental body from manifest action + payload context', () => {
    const env = {
      payload: {
        title: 'Follow up',
        type: 'call',
        dueDate: Date.UTC(2026, 0, 15, 10, 0),
        links: [{ nameSnapshot: 'ACME' }],
      },
    };
    const body = activityNotificationBody(env as never, 'Activity reminder', 'en');
    expect(body).toContain('Activity reminder');
    expect(body).toContain('«Follow up»');
    expect(body).toContain('(Call)');
    expect(body).toContain('Links: ACME');
    expect(body).toContain('Due:');
  });
});
