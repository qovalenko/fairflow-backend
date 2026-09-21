import type { EventEnvelope } from '@fairflow/shared';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Entity routes the SPA exposes for CRM deep-links from the notification feed. */
const ENTITY_PATH: Record<string, string> = {
  deal: 'deals',
  contact: 'contacts',
  company: 'companies',
  order: 'orders',
  conversation: 'chat',
  organization: 'account/projects',
};

/**
 * Build an in-app deep-link for matrix-projected events (TODO-200). Chat messages
 * carry their own link in the chat consumer; matrix CRM facts use payload ids or
 * envelope subject entity_type/entity_id.
 */
export function buildMatrixDeepLink(
  routingKey: string,
  env: EventEnvelope<Record<string, unknown>>,
  entityType: string,
  entityId: string,
): string | undefined {
  const p = (env.payload ?? {}) as Record<string, unknown>;

  if (routingKey === 'control.project.archived') {
    return '/account/projects';
  }

  if (routingKey === 'control.role.assigned' || routingKey === 'control.role.revoked') {
    const projectId = str(env.projectId);
    return projectId ? `/account/projects/${projectId}/settings` : '/account/projects';
  }

  if (routingKey === 'control.visibility.narrowed') {
    return '/settings/projects/settings';
  }

  if (routingKey === 'control.role.assignment.expiring') {
    return '/settings/projects/roles';
  }

  if (routingKey === 'control.record.shared') {
    const et = str(p.entityType) || entityType;
    const eid = str(p.entityId) || entityId;
    const segment = ENTITY_PATH[et] ?? (et ? `${et}s` : '');
    if (segment && eid) return `/${segment}/${eid}`;
    return undefined;
  }

  if (routingKey.startsWith('crm.deal.')) {
    const dealId = str(p.dealId) || entityId;
    return dealId ? `/deals/${dealId}` : undefined;
  }

  if (routingKey === 'crm.order.final_action_failed') {
    const orderId = str(p.orderId) || entityId;
    return orderId ? `/orders/${orderId}` : undefined;
  }

  if (routingKey === 'crm.contact.drift') {
    const contactId = str(p.contactId) || entityId;
    return contactId ? `/contacts/${contactId}` : undefined;
  }

  if (routingKey === 'crm.company.drift') {
    const companyId = str(p.companyId) || entityId;
    return companyId ? `/companies/${companyId}` : undefined;
  }

  if (routingKey.startsWith('crm.activity.')) {
    const activityId = str(p.activityId) || entityId;
    return activityId ? `/activities/${activityId}` : undefined;
  }

  if (routingKey.startsWith('billing.')) {
    return '/billing';
  }

  const segment = ENTITY_PATH[entityType];
  if (segment && entityId) return `/${segment}/${entityId}`;
  return undefined;
}
