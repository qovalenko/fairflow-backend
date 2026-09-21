/**
 * Canonical routing-key registry — RFC-4 §Р-3 (full normative registry).
 *
 * Single source of truth in code for the `<domain>.<entity>.<action>` event
 * names published over the broker. This module is *registration & typing only*
 * (R2-E0-05): it does NOT publish, build an outbox, or wire consumers — that is
 * E3-01/E3-02. It exists so the outbox (E3-01) and manifest validators have a
 * complete, machine-checkable list of legal emit names.
 *
 * Rules (RFC-4 §Р-3, as resolved by OQ-R2-1):
 *  - format `<domain>.<entity>.<action>` (3 segments) OR `<namespace>.<action>`
 *    (2 segments) for the platform-output namespaces `report`/`statistics`/
 *    `document`/`template` (RFC-4 §3.8/§3.9/§Р-6);
 *  - regex `^[a-z]+\.[a-z_]+(\.[a-z_]+)?$` (first segment `[a-z]+`, rest `[a-z_]+`);
 *  - version lives ONLY in `EventEnvelope.version`; no `.vN` suffix in the key;
 *  - multi-word action is one segment joined with `_` (`final_action_requested`).
 *
 * OQ-R2-1 resolution (tech-pm, BOARD): RFC-4 §3.8/§3.9/§Р-6 list
 * `report.generated`, `report.scheduled_run`, `statistics.exported`,
 * `document.generated`, `template.created/.updated/.deleted` as 2-segment
 * namespace keys, which contradicted the former hard 3-segment regex. The regex
 * is softened to allow an OPTIONAL 3rd segment (2 or 3 segments) and these keys
 * are registered in their canonical 2-segment form (dup `report.report.*`
 * variants removed). No code emits these keys yet (E3-02), so nothing breaks.
 *
 * Namespace owners (RFC-4 §Р-2): `crm` (1st-party CRM alias), `control`,
 * `billing`, `notification`, `partner`, `automation`, `gateway`, `report`,
 * `statistics`, `document`, `template`. The legacy bare prefixes
 * `org/module/access/policy/role/grant/auth/profile/order/order_type` are NOT
 * registered — collapsed into the owners above.
 */

/**
 * Regex an event routing-key must satisfy (RFC-4 §Р-3, OQ-R2-1 resolution):
 * 2 or 3 segments — `<namespace>.<action>` or `<domain>.<entity>.<action>`.
 * First segment `[a-z]+`, the remaining 1–2 segments `[a-z_]+`.
 */
export const ROUTING_KEY_REGEX = /^[a-z]+\.[a-z_]+(\.[a-z_]+)?$/;

/** Lifecycle status of a registered routing-key (RFC-4 §Р-3). */
export type RoutingKeyStatus = 'active' | 'planned';

/**
 * Publisher (`source`) domains — enum of legal envelope `source` values
 * (RFC-4 §Р-1/§Р-2). CRM facts are emitted by these backend domains but
 * published under the `crm` namespace alias.
 */
export const EVENT_SOURCE_DOMAINS = [
  'contact',
  'company',
  'pipe',
  'orders',
  'product',
  'activity',
  'control',
  'billing',
  'notification',
  'platform',
  'automation',
  'gateway',
  'reports',
  'documents',
  'chat',
] as const;
export type EventSourceDomain = (typeof EVENT_SOURCE_DOMAINS)[number];

/**
 * Registered namespace owners — first segment of every legal routing-key
 * (RFC-4 §Р-2). `crm` is the platform alias (see `PLATFORM_EMIT_ALIASES`).
 */
export const EVENT_NAMESPACES = [
  'crm',
  'control',
  'billing',
  'notification',
  'partner',
  'automation',
  'gateway',
  'report',
  'statistics',
  'document',
  'template',
  'chat',
] as const;
export type EventNamespace = (typeof EVENT_NAMESPACES)[number];

/** A single registry entry. */
export interface RoutingKeyEntry {
  /** Canonical routing-key (`type` in the envelope). */
  key: string;
  /** First segment — registered namespace owner. */
  namespace: EventNamespace;
  /** Publishing backend domain (envelope `source`). */
  publisher: EventSourceDomain;
  /** Listener domains (informational; for emit/listen pairing Р-5). */
  listeners: readonly string[];
  /** `active` (implemented/target emit) or `planned` (TO-BE, outbox-dependent). */
  status: RoutingKeyStatus;
}

const e = (
  key: string,
  namespace: EventNamespace,
  publisher: EventSourceDomain,
  listeners: readonly string[],
  status: RoutingKeyStatus,
): RoutingKeyEntry => ({ key, namespace, publisher, listeners, status });

/**
 * Full registry — RFC-4 §Р-3 §§3.1–3.9, every key brought to canon.
 */
export const ROUTING_KEY_REGISTRY: readonly RoutingKeyEntry[] = [
  // 3.1 CRM (crm.*) — publishers contact/company/pipe/orders/product/activity
  e('crm.contact.created', 'crm', 'contact', ['audit', 'search', 'automation', 'statistics'], 'active'),
  e('crm.contact.updated', 'crm', 'contact', ['audit', 'search', 'automation'], 'active'),
  e('crm.contact.deleted', 'crm', 'contact', ['audit', 'search', 'automation'], 'active'),
  // restore/unmerge — pipe/orders restore the link, search/audit re-index (contact.md §3.5/§3.9, RFC-4 §Р-5).
  e('crm.contact.restored', 'crm', 'contact', ['pipe', 'orders', 'search', 'audit'], 'active'),
  e('crm.contact.merged', 'crm', 'contact', ['audit', 'search', 'automation', 'statistics', 'orders'], 'active'),
  e('crm.contact.transferred', 'crm', 'contact', ['audit', 'notification', 'statistics'], 'planned'),
  e('crm.contact.drift', 'crm', 'contact', ['notification', 'audit'], 'planned'),
  e('crm.contact.deal_attached', 'crm', 'pipe', ['search', 'audit', 'statistics'], 'planned'),
  e('crm.company.deal_attached', 'crm', 'pipe', ['search', 'audit', 'statistics'], 'active'),
  e('crm.company.created', 'crm', 'company', ['audit', 'search', 'automation', 'statistics'], 'active'),
  e('crm.company.updated', 'crm', 'company', ['audit', 'search', 'automation'], 'active'),
  e('crm.company.deleted', 'crm', 'company', ['contact', 'audit', 'search'], 'active'),
  // restore — the `deletedAt: active` transition. Distinct from `updated` so audit
  // reads the un-delete as a restore fact and search re-indexes the revived row
  // (company.md restore; RFC-4 §Р-3, be-event-keys-rfc4). audit via `crm.#`, search binds it.
  e('crm.company.restored', 'crm', 'company', ['audit', 'search'], 'active'),
  e(
    'crm.company.merged',
    'crm',
    'company',
    ['contact', 'pipe', 'orders', 'activity', 'audit', 'search', 'automation', 'statistics'],
    'active',
  ),
  e('crm.company.merge_reverted', 'crm', 'company', ['audit', 'search'], 'planned'),
  // «Удалить навсегда» (FR-COMPANIES-040): the source row is physically gone, so
  // search ERASES the index row (not a tombstone — ProjectionApply.isPurge) and
  // audit chains the purge fact via `crm.#`. Emitted by companies.service.ts
  // (deletePermanently outbox stage); registered post-factum by the round-2 sweep.
  e('crm.company.purged', 'crm', 'company', ['search', 'audit'], 'active'),
  e('crm.company.contact_linked', 'crm', 'contact', ['company'], 'active'),
  e('crm.company.contact_unlinked', 'crm', 'contact', ['company'], 'active'),
  e('crm.company.transferred', 'crm', 'company', ['audit', 'notification', 'statistics'], 'planned'),
  e('crm.company.drift', 'crm', 'company', ['notification', 'audit'], 'planned'),
  e('crm.deal.created', 'crm', 'pipe', ['audit', 'search', 'automation', 'statistics'], 'active'),
  e('crm.deal.updated', 'crm', 'pipe', ['audit', 'search', 'automation'], 'active'),
  e('crm.deal.deleted', 'crm', 'pipe', ['audit', 'search', 'automation'], 'active'),
  // restore — un-delete transition (distinct from `updated`; audit reads the restore
  // fact, search re-indexes the revived deal). RFC-4 §Р-3 (be-event-keys-rfc4).
  e('crm.deal.restored', 'crm', 'pipe', ['audit', 'search'], 'active'),
  // reopen — closed(won/lost)→open transition (pipe.md §5.1). Semantically distinct
  // from a plain stage move: audit/automation must NOT conflate a reopen with an
  // ordinary stage_changed. search re-indexes (status/stage flip). RFC-4 §Р-3.
  e('crm.deal.reopened', 'crm', 'pipe', ['audit', 'search', 'automation', 'notification'], 'active'),
  // bulk update (pipe.md §5.1) — RESERVED aggregate key. The bulk path deliberately
  // emits per-record SEMANTIC events (crm.deal.reassigned / crm.deal.stage_changed)
  // so consumers keep the richer per-deal detail; no aggregate emit today (planned).
  e('crm.deal.bulk_updated', 'crm', 'pipe', ['audit', 'search', 'automation'], 'planned'),
  // drift accept — snapshot re-capture / drift clear (pipe.md §5.1). Legally
  // significant fact; audit chains it via `crm.#`. Mirrors crm.order.drift_accepted.
  e('crm.deal.drift_accepted', 'crm', 'pipe', ['audit'], 'active'),
  e('crm.deal.stage_changed', 'crm', 'pipe', ['audit', 'automation', 'statistics', 'notification'], 'active'),
  e('crm.deal.won', 'crm', 'pipe', ['orders', 'audit', 'statistics', 'notification'], 'active'),
  e('crm.deal.lost', 'crm', 'pipe', ['orders', 'audit', 'statistics', 'notification'], 'active'),
  e('crm.deal.assigned', 'crm', 'pipe', ['notification', 'audit'], 'planned'),
  e('crm.deal.reassigned', 'crm', 'pipe', ['statistics', 'audit', 'automation', 'notification'], 'active'),
  e('crm.deal.transferred', 'crm', 'pipe', ['notification', 'activity', 'audit'], 'planned'),
  e('crm.deal.stalled', 'crm', 'pipe', ['notification', 'automation'], 'planned'),
  e('crm.deal.product_linked', 'crm', 'pipe', ['product', 'audit'], 'planned'),
  e('crm.deal.product_unlinked', 'crm', 'pipe', ['product', 'audit'], 'planned'),
  e('crm.order.created', 'crm', 'orders', ['audit', 'search', 'automation', 'statistics', 'product'], 'planned'),
  e('crm.order.updated', 'crm', 'orders', ['audit', 'search', 'automation'], 'planned'),
  e('crm.order.deleted', 'crm', 'orders', ['audit', 'search'], 'planned'),
  e('crm.order.status_changed', 'crm', 'orders', ['reports', 'automation', 'statistics', 'notification'], 'planned'),
  e('crm.order.stage_changed', 'crm', 'orders', ['reports', 'automation', 'statistics'], 'planned'),
  // product consumes it as the ordersCount DECREMENT fact (the authoritative
  // countOrdersByProduct counts `status != CANCELLED`); the envelope carries productId.
  e('crm.order.cancelled', 'crm', 'orders', ['notification', 'audit', 'statistics', 'product'], 'planned'),
  e('crm.order.drift_accepted', 'crm', 'orders', ['audit'], 'planned'),
  e('crm.order.document_requested', 'crm', 'orders', ['documents', 'audit'], 'planned'),
  // final-action saga (FR-ORDERS-240/270/280/290): orders emits `requested` on the
  // terminal transition; the automation domain executes the spec and answers with
  // `succeeded`/`failed`; orders consumes the answer (SENDING → DONE | SEND_ERROR).
  e('crm.order.final_action_requested', 'crm', 'orders', ['automation', 'audit'], 'active'),
  e('crm.order.final_action_succeeded', 'crm', 'automation', ['orders', 'notification', 'audit', 'statistics'], 'active'),
  e('crm.order.final_action_failed', 'crm', 'automation', ['orders', 'notification', 'audit'], 'active'),
  e('crm.order.transferred', 'crm', 'orders', ['notification', 'audit'], 'planned'),
  e('crm.order_type.created', 'crm', 'orders', ['product', 'audit'], 'planned'),
  e('crm.order_type.updated', 'crm', 'orders', ['product', 'audit'], 'planned'),
  e('crm.order_type.deleted', 'crm', 'orders', ['product', 'audit'], 'planned'),
  e('crm.order_type.archived', 'crm', 'orders', ['product', 'audit'], 'planned'),
  // restore — the `deletedAt: null` un-delete transition of an order type. Distinct
  // from `updated` so audit reads the un-delete as a restore fact rather than a
  // plain field edit (orders restoreOrderType; RFC-4 §Р-3, be-ordertype-restored-key).
  // Same listeners as the sibling order_type.* keys (audit binds it via `crm.#`);
  // marked `planned` for consistency with the whole orders block, where even
  // really-emitted keys (crm.order.created, crm.order.drift_accepted) stay `planned`.
  e('crm.order_type.restored', 'crm', 'orders', ['product', 'audit'], 'planned'),
  e('crm.product.created', 'crm', 'product', ['audit', 'search', 'automation'], 'planned'),
  e('crm.product.updated', 'crm', 'product', ['audit', 'search', 'automation'], 'planned'),
  e('crm.product.deleted', 'crm', 'product', ['audit', 'search'], 'planned'),
  e('crm.product.price_changed', 'crm', 'product', ['audit', 'automation', 'statistics'], 'planned'),
  e('crm.product.order_type_changed', 'crm', 'product', ['orders', 'audit'], 'planned'),
  e('crm.product.order_type_dangling', 'crm', 'product', ['orders', 'notification', 'audit'], 'planned'),
  e('crm.product.archived', 'crm', 'product', ['audit', 'search'], 'planned'),
  e('crm.product.restored', 'crm', 'product', ['audit', 'search'], 'planned'),
  e('crm.activity.created', 'crm', 'activity', ['audit', 'automation', 'statistics'], 'planned'),
  e('crm.activity.updated', 'crm', 'activity', ['audit', 'automation'], 'planned'),
  e('crm.activity.deleted', 'crm', 'activity', ['audit'], 'planned'),
  // restore — un-delete transition (distinct from `updated`; audit reads the restore
  // fact, search re-indexes the revived activity). RFC-4 §Р-3 (be-event-keys-rfc4).
  e('crm.activity.restored', 'crm', 'activity', ['audit', 'search'], 'active'),
  e('crm.activity.completed', 'crm', 'activity', ['audit', 'statistics', 'automation', 'contact'], 'planned'),
  e('crm.activity.reassigned', 'crm', 'activity', ['notification', 'audit'], 'active'),
  e('crm.activity.overdue', 'crm', 'activity', ['notification', 'audit'], 'active'),
  e('crm.activity.reminder', 'crm', 'activity', ['notification', 'audit'], 'active'),
  e('crm.activity.reminder_scheduled', 'crm', 'activity', ['notification'], 'active'),
  e('crm.activity.reminder_cancelled', 'crm', 'activity', ['notification'], 'active'),
  e('crm.import.completed', 'crm', 'contact', ['notification', 'search', 'audit'], 'planned'),

  // 3.2 control (control.*) — publisher control
  e('control.role.changed', 'control', 'control', ['audit', 'automation', 'notification'], 'active'),
  e('control.role.assigned', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.role.revoked', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.role.assignment.expiring', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.grant.changed', 'control', 'control', ['audit'], 'active'),
  e('control.policy.updated', 'control', 'control', ['audit', 'search', 'automation'], 'active'),
  e('control.access.denied', 'control', 'control', ['audit'], 'active'),
  // TODO-239: emitted by ProjectsService.update (one chained RoleAuditLog fact +
  // outbox row per module transition), covering both the enable/disable path and
  // the install/uninstall/upgrade path that persists through it.
  e('control.module.enabled', 'control', 'control', ['audit', 'notification', 'search'], 'active'),
  e('control.module.disabled', 'control', 'control', ['audit', 'notification', 'search'], 'active'),
  e('control.module.installed', 'control', 'control', ['audit', 'billing'], 'active'),
  e('control.module.upgraded', 'control', 'control', ['audit', 'billing'], 'active'),
  e('control.module.uninstalled', 'control', 'control', ['audit', 'billing'], 'active'),
  e('control.module.runtime_resumed', 'control', 'control', ['audit', 'notification', 'search'], 'active'),
  e('control.member.added', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.member.removed', 'control', 'control', ['audit', 'notification', 'control'], 'active'),
  e('control.member.changed', 'control', 'control', ['audit', 'notification'], 'active'),
  // BX-OFFB-2: employee offboard record-reassignment cascade. Distinct from the
  // audit-only control.member.removed/changed facts — this is a per-PROJECT event
  // (envelope `projectId` set, one per org-project the departed member held) that
  // drives the Mongo CRM domains to reassign every record the leaver owned to the
  // chosen active responsible. Mirrors control.project.purged as a control→domains
  // data cascade. metadata carries `{reassignToUserId}`.
  e('control.member.offboarded', 'control', 'control', ['contact', 'company', 'pipe', 'orders', 'activity', 'documents', 'audit', 'notification'], 'active'),
  e('control.department.changed', 'control', 'control', ['audit', 'search'], 'active'),
  // FR-MORG-7/8/11: department→project binding lifecycle (created/changed/deleted
  // all funnel through OrgAuditService → this one key; the concrete action lives in
  // the audit `action`). search reindexes the materialized ProjectMember scope.
  e('control.binding.changed', 'control', 'control', ['audit', 'search'], 'active'),
  e('control.org.changed', 'control', 'control', ['audit'], 'active'),
  // Org deactivation (FR-MORG-43, P2.e): distinct from a profile edit — it carries
  // an access cascade (control revokes the members' auth sessions in-process) and
  // notifies the offboarded members. audit for the trail, notification to tell them.
  e('control.org.deactivated', 'control', 'control', ['audit', 'notification'], 'active'),
  // Invitation lifecycle (P8 T5.2, X-10): created/revoked/resent/accepted funnel
  // through OrgAuditService.record → control outbox → audit chain. The former
  // registry had no invitation key, so these facts had no legal emit name.
  e('control.invitation.created', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.invitation.revoked', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.invitation.accepted', 'control', 'control', ['audit', 'notification'], 'active'),
  e('control.record.shared', 'control', 'control', ['notification', 'audit', 'search'], 'active'),
  e('control.record.unshared', 'control', 'control', ['notification', 'audit', 'search'], 'active'),
  e('control.record.reassign_required', 'control', 'control', ['notification', 'audit'], 'planned'),
  e('control.visibility.changed', 'control', 'control', ['audit', 'search'], 'active'),
  e('control.visibility.narrowed', 'control', 'control', ['audit', 'notification'], 'active'),
  // BX-MODEL-6 (§7.3): applying an access preset is an access-affecting fact that
  // must reach the tamper-evident audit chain (152-ФЗ accountability). The preset
  // ALSO fires the concrete visibility/policy changes on their own keys; this one
  // records the meta-fact "preset X was applied" so the audit trail stays legible.
  e('control.preset.applied', 'control', 'control', ['audit', 'search'], 'active'),
  // Project physical purge after the pending_deletion grace window (P2.e, FR-MPRJ-17).
  // The control-side purge (members/roles/grants/units/integrations/api-keys) is done
  // in-process; this fact tells the CRM data domains + billing/search/audit to drop
  // their own per-project data. Domain consumers are a follow-up (be-purge-job report).
  e('control.project.purged', 'control', 'control', ['audit', 'billing', 'search', 'contact', 'company', 'pipe', 'orders', 'product', 'activity', 'documents', 'automation', 'notification'], 'active'),
  // Project archive fact. The notification matrix ("Проект архивирован",
  // fanout all-members) already BINDS this key, but control does not emit it yet:
  // archive today is a plain `updateProject(isArchived)` without a lifecycle
  // event. Registered as `planned` so the expected emit has a legal name; the
  // control-side emit is an open follow-up (see round-2 FINAL-REPORT).
  e('control.project.archived', 'control', 'control', ['notification', 'audit'], 'planned'),

  // 3.3 billing (billing.*) — publisher billing
  e('billing.account.state_changed', 'billing', 'billing', ['notification', 'audit', 'control'], 'planned'),
  e('billing.module.state_changed', 'billing', 'billing', ['control', 'notification', 'audit'], 'planned'),
  e('billing.seat.evicted', 'billing', 'billing', ['notification', 'control', 'audit'], 'planned'),
  e('billing.quota.exceeded', 'billing', 'billing', ['notification', 'audit'], 'planned'),
  e('billing.grace.expiring', 'billing', 'billing', ['notification', 'audit'], 'planned'),

  // 3.4 notification (notification.*) — publisher notification
  e('notification.message.created', 'notification', 'notification', ['audit'], 'planned'),
  e('notification.message.read', 'notification', 'notification', ['audit', 'statistics'], 'planned'),
  e('notification.email.sent', 'notification', 'notification', ['audit'], 'active'),
  e('notification.preferences.changed', 'notification', 'notification', ['audit'], 'planned'),

  // 3.5 partner (partner.*) — publisher platform
  e('partner.module.installed', 'partner', 'platform', ['audit', 'billing', 'control'], 'planned'),
  e('partner.module.uninstalled', 'partner', 'platform', ['audit', 'billing', 'control'], 'planned'),
  e('partner.module.upgraded', 'partner', 'platform', ['audit', 'billing'], 'planned'),
  e('partner.token.issued', 'partner', 'platform', ['audit'], 'planned'),
  e('partner.token.revoked', 'partner', 'platform', ['audit'], 'planned'),
  e('partner.consent.granted', 'partner', 'platform', ['audit', 'notification'], 'planned'),
  e('partner.consent.revoked', 'partner', 'platform', ['audit', 'notification'], 'planned'),
  // BX-INTEG-4: activated — control's webhook-delivery consumer publishes this
  // when an outbound project webhook exhausts its retries (delivery dead-lettered).
  e('partner.webhook.dead_lettered', 'partner', 'control', ['audit', 'notification'], 'active'),
  e('partner.access.denied', 'partner', 'platform', ['audit'], 'planned'),
  e('partner.quota.exceeded', 'partner', 'platform', ['audit', 'notification'], 'planned'),

  // 3.6 automation (automation.*) — publisher automation
  e('automation.rule.created', 'automation', 'automation', ['audit'], 'active'),
  e('automation.rule.updated', 'automation', 'automation', ['audit'], 'active'),
  e('automation.rule.deleted', 'automation', 'automation', ['audit'], 'active'),
  e('automation.rule.executed', 'automation', 'automation', ['audit', 'statistics'], 'active'),
  e('automation.rule.frozen', 'automation', 'automation', ['audit'], 'active'),
  e('automation.rule.unfrozen', 'automation', 'automation', ['audit'], 'active'),
  e('automation.event.hooked', 'automation', 'automation', ['audit'], 'active'),
  e('automation.action.failed', 'automation', 'automation', ['audit', 'notification'], 'active'),
  e('automation.dlq.exhausted', 'automation', 'automation', ['audit', 'notification'], 'active'),
  e('automation.connection.breaker_opened', 'automation', 'automation', ['audit', 'notification'], 'active'),

  // 3.7 gateway (gateway.*) — publisher gateway (incl. auth login/logout)
  e('gateway.auth.login', 'gateway', 'gateway', ['audit', 'statistics'], 'active'),
  e('gateway.auth.logout', 'gateway', 'gateway', ['audit'], 'active'),
  e('gateway.auth.login_failed', 'gateway', 'gateway', ['audit', 'notification'], 'active'),
  e('gateway.auth.registered', 'gateway', 'gateway', ['audit', 'notification'], 'planned'),
  e('gateway.auth.mfa_changed', 'gateway', 'gateway', ['audit', 'notification'], 'active'),
  e('gateway.auth.password_changed', 'gateway', 'gateway', ['audit', 'notification'], 'active'),
  e('gateway.profile.updated', 'gateway', 'gateway', ['audit'], 'active'),
  e('gateway.profile.avatar_updated', 'gateway', 'gateway', ['audit'], 'active'),
  e('gateway.profile.email_change_requested', 'gateway', 'gateway', ['audit', 'notification'], 'active'),
  e('gateway.profile.email_changed', 'gateway', 'gateway', ['audit', 'notification'], 'active'),
  e('gateway.profile.session_revoked', 'gateway', 'gateway', ['audit'], 'active'),
  e('gateway.event.depth_exceeded', 'gateway', 'gateway', ['audit'], 'active'),

  // 3.8 report (report.*) / statistics (statistics.*) — publisher reports
  // OQ-R2-1 (resolved): canonical 2-segment namespace keys per RFC-4 §3.8/§3.9.
  // The former dup-segment forms (`report.report.generated` etc.) are removed;
  // the regex now permits the optional 3rd segment, so 2-segment keys validate.
  e('report.generated', 'report', 'reports', ['audit'], 'active'),
  e('report.scheduled_run', 'report', 'reports', ['audit'], 'active'),
  e('statistics.exported', 'statistics', 'reports', ['audit'], 'active'),

  // 3.9 document (document.*) / template (template.*) — publisher documents
  // OQ-R2-1 (resolved): canonical 2-segment namespace keys per RFC-4 §3.9/§Р-6.
  e('document.generated', 'document', 'documents', ['audit', 'notification'], 'active'),
  // BX-OFFB-2 offboard cascade: documents reassigns every live group owned by a
  // departing member (documents.service.ts reassignOwnedRecords) and emits one
  // fact per group. audit chains it via `document.#`. Registered post-factum by
  // the round-2 sweep — the emit predates the registry entry.
  e('document.owner_reassigned', 'document', 'documents', ['audit'], 'active'),
  // I1b: real document.* emits via outbox (contracts/documents.md §5.1, RFC-4 §3.9).
  e('document.regenerated', 'document', 'documents', ['audit', 'automation', 'reports'], 'active'),
  e('document.uploaded', 'document', 'documents', ['audit', 'search'], 'active'),
  e('document.deleted', 'document', 'documents', ['audit', 'search'], 'active'),
  e('document.drift_detected', 'document', 'documents', ['notification', 'automation', 'reports'], 'planned'),
  e('document.template_published', 'document', 'documents', ['audit'], 'active'),
  e('document.template_archived', 'document', 'documents', ['audit'], 'active'),
  e('template.created', 'template', 'documents', ['audit'], 'planned'),
  e('template.updated', 'template', 'documents', ['audit'], 'planned'),
  e('template.deleted', 'template', 'documents', ['audit'], 'planned'),

  // 3.10 chat (chat.*) — publisher chat (contracts/chat.md §5).
  // Own namespace owner (B-1: NOT a `crm` alias — chat is not the CRM cluster).
  // @mention is a field (isMention/mentionIds) inside chat.message.created — no
  // separate chat.mention key (B-2). Read-cursors are NOT bus facts (Redis only).
  e('chat.message.created', 'chat', 'chat', ['notification', 'audit'], 'active'),
  e('chat.message.edited', 'chat', 'chat', ['audit'], 'planned'),
  e('chat.message.deleted', 'chat', 'chat', ['audit'], 'planned'),
  e('chat.conversation.created', 'chat', 'chat', ['audit'], 'planned'),
  e('chat.member.added', 'chat', 'chat', ['audit'], 'planned'),
  e('chat.member.removed', 'chat', 'chat', ['audit'], 'planned'),
  e('chat.isolation.denied', 'chat', 'chat', ['audit'], 'planned'),
];

/**
 * Set of all registered routing-keys (fast membership check).
 */
export const ROUTING_KEYS: ReadonlySet<string> = new Set(
  ROUTING_KEY_REGISTRY.map((entry) => entry.key),
);

/** Lookup index by routing-key. */
const REGISTRY_BY_KEY: ReadonlyMap<string, RoutingKeyEntry> = new Map(
  ROUTING_KEY_REGISTRY.map((entry) => [entry.key, entry]),
);

/** Resolve a registry entry by routing-key, or `undefined` if unregistered. */
export function getRoutingKeyEntry(key: string): RoutingKeyEntry | undefined {
  return REGISTRY_BY_KEY.get(key);
}

/** Whether a routing-key is registered in the canonical RFC-4 §Р-3 registry. */
export function isRegisteredRoutingKey(key: string): boolean {
  return ROUTING_KEYS.has(key);
}

/** Whether a routing-key syntactically satisfies the RFC-4 §Р-3 regex. */
export function isWellFormedRoutingKey(key: string): boolean {
  return ROUTING_KEY_REGEX.test(key);
}

/**
 * Build a canonical routing-key, validating the result. Supports both forms
 * (OQ-R2-1): 3-segment `<domain>.<entity>.<action>` (pass `action`) and
 * 2-segment `<namespace>.<action>` (omit `action`). Throws if the produced key
 * does not satisfy `ROUTING_KEY_REGEX`.
 */
export function buildRoutingKey(domain: string, entity: string, action?: string): string {
  const key = action === undefined ? `${domain}.${entity}` : `${domain}.${entity}.${action}`;
  if (!isWellFormedRoutingKey(key)) {
    throw new Error(
      `Invalid routing-key "${key}": must match ${ROUTING_KEY_REGEX} (RFC-4 §Р-3, OQ-R2-1).`,
    );
  }
  return key;
}

/**
 * Result of {@link validatePublishKey}.
 */
export interface RoutingKeyValidation {
  ok: boolean;
  /** Machine-readable reason when `ok === false`. */
  reason?: 'malformed' | 'unregistered';
  /** Human-readable message when `ok === false`. */
  message?: string;
  entry?: RoutingKeyEntry;
}

/**
 * Publish-time validator (RFC-4 §Р-5 invariant): a routing-key may be published
 * only if it is well-formed (regex) AND registered in the canonical registry.
 *
 * This is the typing/registry guard for the outbox (E3-01) — it does not itself
 * publish anything.
 */
export function validatePublishKey(key: string): RoutingKeyValidation {
  if (!isWellFormedRoutingKey(key)) {
    return {
      ok: false,
      reason: 'malformed',
      message: `Routing-key "${key}" is malformed; must match ${ROUTING_KEY_REGEX} (RFC-4 §Р-3, exactly 3 segments, no .vN suffix).`,
    };
  }
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry) {
    return {
      ok: false,
      reason: 'unregistered',
      message: `Routing-key "${key}" is not registered in the RFC-4 §Р-3 registry; register it before publishing.`,
    };
  }
  return { ok: true, entry };
}

/**
 * Assert a routing-key is publishable, throwing on failure. Convenience wrapper
 * around {@link validatePublishKey} for outbox producers (E3-01).
 */
export function assertPublishKey(key: string): RoutingKeyEntry {
  const result = validatePublishKey(key);
  if (!result.ok || !result.entry) {
    throw new Error(result.message ?? `Invalid routing-key "${key}".`);
  }
  return result.entry;
}
