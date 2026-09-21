/**
 * In-code trigger/action registry (contract §3.12, §5.6, FR-MAUT-5/17).
 *
 * Not stored in Mongo. GetRegistry filters this catalog by the project's
 * effective `enabled_modules` (provided by gateway metadata, never trusted from
 * the client). Schemas are JSON-stringified for the gRPC wire (string fields).
 */

export interface TriggerDefRaw {
  id: string;
  requiredModule: string;
  entityType: string;
  eventName: string;
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface ActionDefRaw {
  id: string;
  requiredModule: string;
  externalEffect: boolean;
  configSchema: Record<string, unknown>;
}

/** Trigger catalog — keyed by the `crm.*` event the rule listens to. */
export const TRIGGER_CATALOG: TriggerDefRaw[] = [
  { id: 'crm.contact.created', requiredModule: 'contacts', entityType: 'contact', eventName: 'crm.contact.created', configSchema: {}, outputSchema: {} },
  { id: 'crm.contact.updated', requiredModule: 'contacts', entityType: 'contact', eventName: 'crm.contact.updated', configSchema: {}, outputSchema: {} },
  { id: 'crm.deal.created', requiredModule: 'deals', entityType: 'deal', eventName: 'crm.deal.created', configSchema: {}, outputSchema: {} },
  { id: 'crm.deal.stage_changed', requiredModule: 'deals', entityType: 'deal', eventName: 'crm.deal.stage_changed', configSchema: { fromStage: 'string', toStage: 'string' }, outputSchema: {} },
  // reopen is now a distinct fact (be-event-keys-rfc4): kept as its own trigger so a
  // closed→open transition is no longer silently conflated with an ordinary stage_changed.
  { id: 'crm.deal.reopened', requiredModule: 'deals', entityType: 'deal', eventName: 'crm.deal.reopened', configSchema: { toStage: 'string' }, outputSchema: {} },
  { id: 'crm.deal.won', requiredModule: 'deals', entityType: 'deal', eventName: 'crm.deal.won', configSchema: {}, outputSchema: {} },
  { id: 'crm.deal.lost', requiredModule: 'deals', entityType: 'deal', eventName: 'crm.deal.lost', configSchema: {}, outputSchema: {} },
  { id: 'crm.order.status_changed', requiredModule: 'orders', entityType: 'order', eventName: 'crm.order.status_changed', configSchema: { toStatus: 'string' }, outputSchema: {} },
  { id: 'crm.activity.created', requiredModule: 'activities', entityType: 'activity', eventName: 'crm.activity.created', configSchema: {}, outputSchema: {} },
  { id: 'crm.activity.completed', requiredModule: 'activities', entityType: 'activity', eventName: 'crm.activity.completed', configSchema: {}, outputSchema: {} },
];

/** Action catalog. `externalEffect:true` requires `automation:manage` to enable. */
export const ACTION_CATALOG: ActionDefRaw[] = [
  { id: 'create_activity', requiredModule: 'activities', externalEffect: false, configSchema: { type: 'string', title: 'string' } },
  // The four schemas below are what `CrmEntityExecutor` / `NotificationExecutor`
  // actually read (TODO-039 remainder). `entityType`/`entityId` are optional
  // overrides: by default the action targets the record the trigger fired on,
  // resolved from the trigger's entity type + payload — a rule that names
  // another project's record is refused, not silently retargeted.
  {
    id: 'assign_user',
    requiredModule: 'automation',
    externalEffect: false,
    configSchema: { userId: 'string', entityType: 'string?', entityId: 'string?' },
  },
  {
    id: 'change_stage',
    requiredModule: 'deals',
    externalEffect: false,
    // Applied through the MOVE path (MoveDealToStage / MoveOrderToStage) so
    // stage history and crm.*.stage_changed stay consistent.
    configSchema: { stageId: 'string', entityType: 'string?', entityId: 'string?' },
  },
  {
    id: 'update_field',
    requiredModule: 'automation',
    externalEffect: false,
    configSchema: { field: 'string', value: 'string', entityType: 'string?', entityId: 'string?' },
  },
  {
    id: 'send_notification',
    requiredModule: 'automation',
    externalEffect: false,
    // `template` is kept as the body alias: the classic form has been saving it
    // since day one. Recipient defaults to the triggering record's assignee.
    configSchema: {
      userId: 'string?',
      title: 'string?',
      body: 'string',
      channel: 'string?',
      template: 'string?',
    },
  },
  {
    id: 'qualify_deal',
    requiredModule: 'deals',
    externalEffect: false,
    configSchema: { target: 'string?', forceCreate: 'boolean?' },
  },
  { id: 'send_webhook', requiredModule: 'automation', externalEffect: true, configSchema: { connectionId: 'string' } },
  // `subject` is part of the contract, not decoration: the order-type form has
  // saved `config.subject` since day one and it used to be silently dropped —
  // the executor renders it into the mail subject (TODO-039 / review minor).
  { id: 'send_email', requiredModule: 'automation', externalEffect: true, configSchema: { to: 'string', subject: 'string', template: 'string' } },
  {
    id: 'generate_document',
    requiredModule: 'documents',
    externalEffect: false,
    configSchema: {
      template_id: 'string',
      context_type: 'string?',
      record_id: 'string?',
      trigger_event_id: 'string?',
    },
  },
];

/** Action ids that produce an external/irreversible effect (privileged enable). */
export const EXTERNAL_EFFECT_ACTIONS = new Set(
  ACTION_CATALOG.filter((a) => a.externalEffect).map((a) => a.id),
);
