import type { DomainGrpcTarget } from './grpc-action-executor';

/** CRM entity kinds an entity-generic automation action can target. */
export type EntityKind = 'deal' | 'contact' | 'company' | 'order' | 'activity';

/** How one updatable field maps onto its domain's Update request / Get response. */
export interface FieldSpec {
  /** Field name in the domain's `Update<Entity>Request` (proto, snake_case). */
  write: string;
  /** Field name in the domain's read response — used for the "already applied?" compare. */
  read: string;
  kind: 'string' | 'number' | 'string_list';
}

export interface EntityDomain {
  kind: EntityKind;
  target: DomainGrpcTarget;
  getMethod: string;
  updateMethod: string;
  /** Payload keys (snake_case + camelCase) that carry this entity's id. */
  payloadKeys: string[];
  /** The field an `assign_user` action writes. */
  assigneeField: FieldSpec;
  /** Whitelist for `update_field` — anything else is a terminal config error. */
  fields: Record<string, FieldSpec>;
  /**
   * True when the domain stores per-order-type custom fields in a JSON blob; an
   * unknown `update_field` name is then merged into that blob instead of being
   * rejected (orders' `fields_json`).
   */
  customFieldsJson?: { write: string; read: string };
}

function s(write: string, read = write): FieldSpec {
  return { write, read, kind: 'string' };
}
function n(write: string, read = write): FieldSpec {
  return { write, read, kind: 'number' };
}
function list(write: string, read = write): FieldSpec {
  return { write, read, kind: 'string_list' };
}

const DEAL_ASSIGNEE = s('assignee_id');
const CONTACT_ASSIGNEE: FieldSpec = { write: 'assignee_id', read: 'owner_id', kind: 'string' };
const COMPANY_ASSIGNEE: FieldSpec = { write: 'assignee_id', read: 'owner_id', kind: 'string' };
const ORDER_ASSIGNEE = s('assignee_id');
const ACTIVITY_ASSIGNEE = s('assignee_id');

/**
 * Per-entity wiring for the entity-generic executors (TODO-039).
 *
 * Every entry is an EXISTING domain gRPC contract — automation never opens a
 * REST path of its own and never touches another domain's database (§1 invariant
 * "домены общаются только по gRPC"). `stage_id` is deliberately ABSENT from the
 * deal field list: a stage transition is normalized through the move path
 * (`MoveDealToStage`, which writes stageLog/history), see `DealStageExecutor`.
 *
 * The `read` name of a field is not always its `write` name — contact/company
 * report the owner as `owner_id` but accept it as `assignee_id`. Getting that
 * pair wrong would silently turn every `assign_user` into "not applied yet" and
 * re-issue the write on each retry, so the pair is declared once, here.
 */
export const ENTITY_DOMAINS: Record<EntityKind, EntityDomain> = {
  deal: {
    kind: 'deal',
    target: {
      urlEnv: 'PIPE_GRPC_URL',
      package: 'fairflow.pipe.v1',
      service: 'PipeGrpc',
      protoSegments: ['fairflow', 'pipe', 'v1', 'pipe.proto'],
    },
    getMethod: 'GetDeal',
    updateMethod: 'UpdateDeal',
    payloadKeys: ['deal_id', 'dealId'],
    assigneeField: DEAL_ASSIGNEE,
    fields: {
      name: s('name'),
      amount: n('amount'),
      currency: s('currency'),
      pipeline_id: s('pipeline_id'),
      contact_id: s('contact_id'),
      company_id: s('company_id'),
      product_id: s('product_id'),
      source: s('source'),
      notes: s('notes'),
      assignee_id: DEAL_ASSIGNEE,
      department_id: s('department_id'),
      probability: n('probability'),
      expected_close_date: n('expected_close_date'),
      tags: list('tags'),
    },
  },
  contact: {
    kind: 'contact',
    target: {
      urlEnv: 'CONTACT_GRPC_URL',
      package: 'fairflow.contact.v1',
      service: 'ContactGrpc',
      protoSegments: ['fairflow', 'contact', 'v1', 'contact.proto'],
    },
    getMethod: 'GetContact',
    updateMethod: 'UpdateContact',
    payloadKeys: ['contact_id', 'contactId'],
    assigneeField: CONTACT_ASSIGNEE,
    fields: {
      first_name: s('first_name'),
      last_name: s('last_name'),
      phone: s('phone'),
      email: s('email'),
      position: s('position'),
      source: s('source'),
      company_id: s('company_id', 'company_ids'),
      assignee_id: CONTACT_ASSIGNEE,
    },
  },
  company: {
    kind: 'company',
    target: {
      urlEnv: 'COMPANY_GRPC_URL',
      package: 'fairflow.company.v1',
      service: 'CompanyGrpc',
      protoSegments: ['fairflow', 'company', 'v1', 'company.proto'],
    },
    getMethod: 'GetCompany',
    updateMethod: 'UpdateCompany',
    payloadKeys: ['company_id', 'companyId'],
    assigneeField: COMPANY_ASSIGNEE,
    fields: {
      name: s('name'),
      inn: s('inn'),
      kpp: s('kpp'),
      ogrn: s('ogrn'),
      phone: s('phone'),
      email: s('email'),
      website: s('website'),
      industry: s('industry'),
      status: s('status'),
      region: s('region'),
      legal_address: s('legal_address'),
      notes: s('notes'),
      department_id: s('department_id'),
      tags: list('tags'),
      assignee_id: COMPANY_ASSIGNEE,
    },
  },
  order: {
    kind: 'order',
    target: {
      urlEnv: 'ORDERS_GRPC_URL',
      package: 'fairflow.orders.v1',
      service: 'OrdersGrpc',
      protoSegments: ['fairflow', 'orders', 'v1', 'orders.proto'],
    },
    getMethod: 'GetOrder',
    updateMethod: 'UpdateOrder',
    payloadKeys: ['order_id', 'orderId'],
    assigneeField: ORDER_ASSIGNEE,
    fields: { assignee_id: ORDER_ASSIGNEE, notes: s('notes') },
    // Everything else on an order is an order-type custom field living in the
    // `fields_json` blob; UpdateOrder replaces the blob, so the executor merges.
    customFieldsJson: { write: 'fields_json', read: 'fields_json' },
  },
  activity: {
    kind: 'activity',
    target: {
      urlEnv: 'ACTIVITY_GRPC_URL',
      package: 'fairflow.activity.v1',
      service: 'ActivityGrpc',
      protoSegments: ['fairflow', 'activity', 'v1', 'activity.proto'],
    },
    getMethod: 'GetActivity',
    updateMethod: 'UpdateActivity',
    payloadKeys: ['activity_id', 'activityId'],
    assigneeField: ACTIVITY_ASSIGNEE,
    fields: {
      title: s('title'),
      description: s('description'),
      status: s('status'),
      priority: s('priority'),
      direction: s('direction'),
      location: s('location'),
      due_date: n('due_date'),
      start_date: n('start_date'),
      end_date: n('end_date'),
      duration: n('duration'),
      assignee_id: ACTIVITY_ASSIGNEE,
    },
  },
};

/**
 * Priority when nothing tells us which record an action targets and the payload
 * carries several ids (a deal event payload also names its contact/company).
 * The record the event is ABOUT wins.
 */
const PAYLOAD_SCAN_ORDER: EntityKind[] = ['deal', 'order', 'activity', 'contact', 'company'];

const KIND_ALIASES: Record<string, EntityKind> = {
  deal: 'deal',
  deals: 'deal',
  contact: 'contact',
  contacts: 'contact',
  company: 'company',
  companies: 'company',
  order: 'order',
  orders: 'order',
  activity: 'activity',
  activities: 'activity',
  task: 'activity',
};

export function normalizeEntityKind(raw: unknown): EntityKind | null {
  const key = String(raw ?? '').trim().toLowerCase();
  return KIND_ALIASES[key] ?? null;
}

export interface EntityTarget {
  domain: EntityDomain;
  id: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function idFromPayload(domain: EntityDomain, payload: Record<string, unknown>): string {
  for (const key of domain.payloadKeys) {
    const value = str(payload[key]);
    if (value) return value;
  }
  return '';
}

/**
 * Resolve WHICH record an entity-generic action operates on.
 *
 * Order of authority:
 *  1. the action config (`entity_type` + `entity_id`) — an explicit rule;
 *  2. the config's `entity_type` + the matching id from the trigger payload;
 *  3. the trigger's own entity type (`ctx.entityType`, from the trigger catalog);
 *  4. a payload scan in {@link PAYLOAD_SCAN_ORDER}.
 *
 * Returns `null` when nothing resolves — the caller reports a TERMINAL config
 * error. Guessing here would be worse than failing: a wrong guess mutates the
 * wrong record.
 */
export function resolveEntityTarget(
  cfg: Record<string, unknown>,
  payload: Record<string, unknown>,
  triggerEntityType?: string,
): EntityTarget | null {
  const explicitKind = normalizeEntityKind(cfg.entity_type ?? cfg.entityType);
  const explicitId = str(cfg.entity_id ?? cfg.entityId);
  if (explicitKind) {
    const domain = ENTITY_DOMAINS[explicitKind];
    const id = explicitId || idFromPayload(domain, payload);
    return id ? { domain, id } : null;
  }
  const triggerKind = normalizeEntityKind(triggerEntityType ?? payload.entity_type ?? payload.entityType);
  if (triggerKind) {
    const domain = ENTITY_DOMAINS[triggerKind];
    const id = explicitId || idFromPayload(domain, payload);
    if (id) return { domain, id };
  }
  for (const kind of PAYLOAD_SCAN_ORDER) {
    const domain = ENTITY_DOMAINS[kind];
    const id = idFromPayload(domain, payload);
    if (id) return { domain, id };
  }
  return null;
}

/** `assigneeId` → `assignee_id`; leaves already-snake names alone. */
export function snakeCaseField(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}
