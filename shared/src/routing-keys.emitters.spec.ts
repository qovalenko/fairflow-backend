import { MODULE_MANIFESTS } from './module-manifests';
import {
  ROUTING_KEY_REGISTRY,
  getRoutingKeyEntry,
  isRegisteredRoutingKey,
  validatePublishKey,
} from './routing-keys';

/** Supplemental emits not declared in module manifests (gateway/chat/notification facts). */
const SUPPLEMENTAL_EMITTERS = [
  'chat.message.created',
  'control.org.deactivated',
  'control.member.offboarded',
  'control.invitation.created',
  'control.invitation.revoked',
  'control.invitation.accepted',
  'gateway.auth.login',
  'gateway.auth.logout',
  'gateway.auth.login_failed',
  'gateway.auth.mfa_changed',
  'gateway.auth.password_changed',
  'gateway.profile.email_change_requested',
  'gateway.profile.email_changed',
  'notification.message.read',
  'notification.preferences.changed',
  'notification.email.sent',
  'partner.webhook.dead_lettered',
  'statistics.exported',
  'report.generated',
  'crm.deal.restored',
  'crm.deal.reopened',
  'crm.deal.drift_accepted',
  'crm.deal.product_linked',
  'crm.deal.product_unlinked',
  'crm.contact.restored',
  'crm.company.restored',
  'crm.company.purged',
  'crm.company.contact_linked',
  'crm.company.contact_unlinked',
  'crm.activity.restored',
  'crm.order.final_action_requested',
  'crm.order.final_action_succeeded',
  'crm.order.final_action_failed',
  'crm.order.drift_accepted',
  'automation.action.failed',
  'automation.dlq.exhausted',
] as const;

/** FR-EVT-055/270: every declared emitter must be registered; registry entries are stable. */
describe('routing-keys emitters ⊆ registry (FR-EVT-055/270)', () => {
  const manifestEmits = new Set<string>();
  for (const manifest of Object.values(MODULE_MANIFESTS)) {
    for (const key of manifest.backend?.events?.emits ?? []) manifestEmits.add(key);
  }
  for (const key of SUPPLEMENTAL_EMITTERS) manifestEmits.add(key);

  it('every manifest/supplemental emit is registered with a keySnapshot entry', () => {
    const missing: string[] = [];
    for (const key of manifestEmits) {
      const v = validatePublishKey(key);
      if (!v.ok) missing.push(`${key}:${v.reason}`);
      else expect(v.entry?.key).toBe(key);
    }
    expect(missing).toEqual([]);
  });

  it('registry has no duplicate keys (keySnapshot uniqueness)', () => {
    const keys = ROUTING_KEY_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('active notification-bound keys listing notification as listener are registered', () => {
    for (const entry of ROUTING_KEY_REGISTRY) {
      if (!entry.listeners.includes('notification')) continue;
      expect(isRegisteredRoutingKey(entry.key)).toBe(true);
      expect(getRoutingKeyEntry(entry.key)?.key).toBe(entry.key);
    }
  });
});
