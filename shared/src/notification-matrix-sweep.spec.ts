import { getRoutingKeyEntry } from './routing-keys';
import { listNotificationEventTypes } from './notification-event-registry';

/**
 * TODO-403 / FR-NOTIF-215: notification matrix must not bind keys with no emitter
 * (planned-only) except documented exceptions removed from the matrix.
 */
describe('notification matrix sweep (TODO-403)', () => {
  const REMOVED_DEAD_KEYS = new Set([
    'crm.deal.transferred',
    'crm.deal.assigned',
    'crm.contact.drift',
    'crm.company.drift',
    'control.project.archived',
  ]);

  it('matrix keys removed for dead/planned-only bindings', () => {
    const matrix = new Set(listNotificationEventTypes());
    for (const key of REMOVED_DEAD_KEYS) {
      expect(matrix.has(key)).toBe(false);
    }
  });

  it('every remaining matrix key is registered and lists notification as consumer', () => {
    for (const key of listNotificationEventTypes()) {
      const entry = getRoutingKeyEntry(key);
      expect(entry).toBeDefined();
      expect(entry?.listeners).toContain('notification');
    }
  });
});
