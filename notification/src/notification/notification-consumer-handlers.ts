import type { EventEnvelope } from '@fairflow/shared';
import {
  getNotificationEventSpec,
  listNotificationEventTypes,
  type NotifyFanoutGroup,
  buildHumanContext,
} from '@fairflow/shared';
import { payloadEntityLabel, quotedLabel } from './notification-human-context';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function payloadMeta(p: Record<string, unknown>): Record<string, unknown> {
  const m = p.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** Owner/assignee carried by I1a deal/contact/company/order/activity payloads. */
export function payloadOwner(p: Record<string, unknown>): string[] {
  const ids = [
    p.assigneeId,
    p.ownerId,
    p.ownerUserId,
    p.toUserId,
    p.toOwnerId,
    p.targetUserId,
    p.recipientUserId,
  ]
    .map(str)
    .filter(Boolean);
  return ids;
}

type AddresseeHandler = {
  addressees: (env: EventEnvelope<Record<string, unknown>>) => string[];
  fanout?: readonly NotifyFanoutGroup[];
  entityIdKeys?: string[];
};

/** Payload-specific addressee resolvers (manifest covers channels/severity/i18n). */
export const NOTIFICATION_ADDRESSEE_HANDLERS: Record<string, AddresseeHandler> = {
  'crm.deal.reassigned': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: ['dealId'] },
  'crm.deal.stage_changed': {
    addressees: (e) => payloadOwner(e.payload).concat(str(e.payload.movedBy)).filter(Boolean),
    entityIdKeys: ['dealId'],
  },
  'crm.deal.won': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: ['dealId'] },
  'crm.deal.lost': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: ['dealId'] },
  'crm.deal.reopened': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: ['dealId'] },
  'control.record.shared': {
    addressees: (e) =>
      [str(e.payload.recipientUserId), str(e.payload.toUserId)].filter(Boolean),
    entityIdKeys: ['entityId'],
  },
  'crm.order.final_action_failed': {
    addressees: (e) => payloadOwner(e.payload),
    entityIdKeys: ['orderId'],
  },
  'crm.activity.reassigned': {
    addressees: (e) => payloadOwner(e.payload),
    entityIdKeys: ['activityId'],
  },
  'crm.activity.overdue': {
    addressees: (e) => payloadOwner(e.payload),
    fanout: ['leader'],
    entityIdKeys: ['activityId'],
  },
  'crm.activity.reminder': {
    addressees: (e) => payloadOwner(e.payload),
    entityIdKeys: ['activityId'],
  },
  'control.project.archived': {
    addressees: (e) => payloadOwner(e.payload),
    entityIdKeys: [],
  },
  'control.visibility.narrowed': {
    addressees: (e) => {
      const ids = payloadMeta(e.payload).userIds;
      return Array.isArray(ids) ? ids.map(str).filter(Boolean) : [];
    },
    entityIdKeys: [],
  },
  'control.role.assignment.expiring': {
    addressees: (e) => [str(payloadMeta(e.payload).userId)].filter(Boolean),
    entityIdKeys: [],
  },
  'control.role.changed': {
    addressees: (e) => {
      const ids = payloadMeta(e.payload).affectedUserIds;
      return Array.isArray(ids) ? ids.map(str).filter(Boolean) : [];
    },
    entityIdKeys: [],
  },
  'control.role.assigned': {
    addressees: (e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return [str(p.subjectUserId)].filter(Boolean);
    },
    entityIdKeys: [],
  },
  'control.role.revoked': {
    addressees: (e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return [str(p.subjectUserId)].filter(Boolean);
    },
    entityIdKeys: [],
  },
  'billing.quota.exceeded': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: [] },
  'billing.grace.expiring': { addressees: (e) => payloadOwner(e.payload), entityIdKeys: [] },
  'automation.action.failed': {
    addressees: () => [],
    fanout: ['pa'],
    entityIdKeys: ['ruleId'],
  },
  'automation.dlq.exhausted': {
    addressees: () => [],
    fanout: ['pa'],
    entityIdKeys: ['ruleId'],
  },
};

/** Build template variables for manifest i18n rendering. */
export function notifyTemplateVars(
  env: EventEnvelope<Record<string, unknown>>,
  entityType: string,
  entityId: string,
  handler?: AddresseeHandler,
): Record<string, string> {
  const p = (env.payload ?? {}) as Record<string, unknown>;
  const meta = payloadMeta(p);
  if (!p.humanContext) {
    p.humanContext = buildHumanContext(p, handler?.entityIdKeys ?? ['dealId', 'orderId', 'contactId', 'companyId']);
  }
  const label = quotedLabel(
    payloadEntityLabel(p, handler?.entityIdKeys ?? ['dealId', 'orderId', 'contactId', 'companyId']),
  );
  const expiresAt = str(meta.expiresAt);
  return {
    entityLabel: label.replace(/^«|»$/g, ''),
    entityType,
    entityId,
    projectId: str(env.projectId),
    metric: str(p.metric),
    dealId: str(p.dealId),
    orderId: str(p.orderId),
    contactId: str(p.contactId),
    companyId: str(p.companyId),
    role: str(p.role) || str(meta.role),
    from: str(meta.from),
    to: str(meta.to),
    actorName: str(meta.actorName ?? (p.humanContext as Record<string, unknown> | undefined)?.actorName).trim(),
    expiresAt: expiresAt ? expiresAt.slice(0, 10) : '',
  };
}

/** Matrix routing keys bound by the consumer (excludes chat/org special handlers). */
export function matrixRoutingKeys(): string[] {
  return listNotificationEventTypes();
}

export function getEventSpec(routingKey: string) {
  return getNotificationEventSpec(routingKey);
}

export function getAddresseeHandler(routingKey: string): AddresseeHandler | undefined {
  return NOTIFICATION_ADDRESSEE_HANDLERS[routingKey];
}
