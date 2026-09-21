import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { EventEnvelope } from '@fairflow/shared';
import { BOX_MONGODB_URI } from './conn';
import { waitFor, type WaitForOptions } from './wait-for';

export type SearchOutboxMatch = {
  orderId?: string;
  productId?: string;
  idempotencyKey?: string;
  /** Observable search_index fallback when dedup row is slow under the box stand bus load. */
  searchFallback?: {
    entityType: string;
    entityId: string;
    ready?: (doc: Record<string, unknown>) => boolean;
  };
};

/** Read-only Mongo accessor for assertions against the box stand shared stores. */
export class BoxMongoReader {
  private constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}

  static async connect(): Promise<BoxMongoReader> {
    const client = new MongoClient(BOX_MONGODB_URI);
    await client.connect();
    return new BoxMongoReader(client, client.db('fairflow'));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async findContact(projectId: string, contactId: string) {
    return this.db.collection('contacts').findOne({
      projectId,
      _id: new ObjectId(contactId),
    });
  }

  async findCompany(projectId: string, companyId: string) {
    return this.db.collection('companies').findOne({
      projectId,
      _id: new ObjectId(companyId),
    });
  }

  async findDeal(projectId: string, dealId: string) {
    return this.db.collection('crm_deals').findOne({
      projectId,
      _id: new ObjectId(dealId),
    });
  }

  async findOrder(projectId: string, orderId: string) {
    return this.db.collection('crm_orders').findOne({
      projectId,
      _id: new ObjectId(orderId),
    });
  }

  async findOrderByDealId(projectId: string, dealId: string) {
    return this.db.collection('crm_orders').findOne({ projectId, dealId });
  }

  async findActivity(projectId: string, activityId: string) {
    return this.db.collection('crm_activities').findOne({
      projectId,
      _id: new ObjectId(activityId),
    });
  }

  async findDocumentGroup(projectId: string, groupId: string) {
    return this.db.collection('document_groups').findOne({
      projectId,
      _id: new ObjectId(groupId),
    });
  }

  async findSearchDoc(projectId: string, entityType: string, entityId: string) {
    return this.db.collection('search_index').findOne({
      projectId,
      entityType,
      entityId,
    });
  }

  async countByProject(collection: string, projectId: string): Promise<number> {
    return this.db.collection(collection).countDocuments({ projectId });
  }

  /** Poll search_index until `ready(doc)` — observable projection contract (no outbox coupling). */
  async waitForSearchDoc(
    projectId: string,
    entityType: string,
    entityId: string,
    ready: (doc: Record<string, unknown>) => boolean,
    opts: WaitForOptions = {},
  ) {
    return waitFor(
      async () => {
        const doc = await this.findSearchDoc(projectId, entityType, entityId);
        return doc && ready(doc as Record<string, unknown>) ? doc : false;
      },
      { label: `search_index ${entityType}/${entityId}`, ...opts },
    );
  }

  async findAutomationExecution(projectId: string, ruleId: string) {
    return this.db.collection('automation_rule_executions').findOne(
      { project_id: projectId, rule_id: ruleId },
      { sort: { created_at: -1 } },
    );
  }

  async findAutomationExecutions(projectId: string, ruleId: string) {
    return this.db
      .collection('automation_rule_executions')
      .find({ project_id: projectId, rule_id: ruleId })
      .sort({ created_at: -1 })
      .limit(5)
      .toArray();
  }

  async listAutomationExecutions(projectId: string, ruleId: string) {
    return this.db
      .collection('automation_rule_executions')
      .find({ project_id: projectId, rule_id: ruleId })
      .sort({ created_at: -1 })
      .limit(10)
      .toArray();
  }

  async deleteAutomationExecutions(projectId: string, ruleId: string): Promise<number> {
    const res = await this.db.collection('automation_rule_executions').deleteMany({
      project_id: projectId,
      rule_id: ruleId,
    });
    return res.deletedCount ?? 0;
  }

  /** Outbox row for a domain event (relay publishes to RabbitMQ from `crm_event_outbox`). */
  async findOutboxEvent(
    projectId: string,
    routingKey: string,
    match: Pick<SearchOutboxMatch, 'orderId' | 'productId' | 'idempotencyKey'> = {},
  ) {
    const filter: Record<string, unknown> = { projectId, routingKey, status: 'published' };
    if (match.orderId) filter['envelope.payload.orderId'] = match.orderId;
    if (match.productId) {
      filter.$or = [
        { 'envelope.payload.productId': match.productId },
        { 'envelope.payload.after.id': match.productId },
        { 'envelope.subject': `product/${match.productId}` },
      ];
    }
    if (match.idempotencyKey) filter['envelope.idempotencyKey'] = match.idempotencyKey;
    return this.db.collection('crm_event_outbox').findOne(filter, { sort: { createdAt: -1 } });
  }

  /** Wait until the local orders outbox relay marks the event published. */
  async waitForOutboxPublished(
    projectId: string,
    routingKey: string,
    match: Pick<SearchOutboxMatch, 'orderId' | 'productId' | 'idempotencyKey'> = {},
    opts: WaitForOptions = {},
  ) {
    return waitFor(
      async () => {
        const row = await this.findOutboxEvent(projectId, routingKey, match);
        return row ?? false;
      },
      { label: `outbox ${routingKey} published`, timeoutMs: 60_000, ...opts },
    );
  }

  /** Wait until the box stand search projection claims the transport dedup key. */
  async waitForSearchDedup(
    projectId: string,
    idempotencyKey: string,
    opts: WaitForOptions = {},
  ) {
    const dedupId = `${projectId}:${idempotencyKey}`;
    return waitFor(
      async () => {
        const row = await this.db.collection('search_event_dedup').findOne({ _id: dedupId as never });
        return row ? row : false;
      },
      { label: `search dedup ${idempotencyKey}`, ...opts },
    );
  }

  /**
   * Outbox relay published the event; wait until the box stand search consumer claims dedup
   * or the search_index reflects the projection (observable fallback under bus load).
   */
  async waitForSearchAfterOutbox(
    projectId: string,
    routingKey: string,
    match: SearchOutboxMatch = {},
    opts: WaitForOptions = {},
  ) {
    const { timeoutMs = 120_000, ...rest } = opts;
    const outboxTimeoutMs = Math.min(timeoutMs, 90_000);
    const outbox = await this.waitForOutboxPublished(projectId, routingKey, match, {
      timeoutMs: outboxTimeoutMs,
      ...rest,
    });
    const idempotencyKey =
      match.idempotencyKey ??
      (typeof outbox.envelope?.idempotencyKey === 'string'
        ? outbox.envelope.idempotencyKey
        : undefined);
    if (!idempotencyKey) {
      throw new Error(`outbox ${routingKey} missing envelope.idempotencyKey`);
    }
    const dedupId = `${projectId}:${idempotencyKey}`;
    const fallback = match.searchFallback;
    await waitFor(
      async () => {
        const dedupRow = await this.db
          .collection('search_event_dedup')
          .findOne({ _id: dedupId as never });
        if (dedupRow) return dedupRow;

        if (fallback) {
          const doc = await this.findSearchDoc(projectId, fallback.entityType, fallback.entityId);
          if (doc && (!fallback.ready || fallback.ready(doc as Record<string, unknown>))) {
            return doc;
          }
        }
        return false;
      },
      { label: `search projection after ${routingKey}`, timeoutMs, ...rest },
    );
    return outbox;
  }

  /**
   * Wait until the box stand automation persisted a rule execution.
   * When `routingKey` is set, first gates on local orders outbox relay publish
   * (same pattern as search — avoids polling automation before the bus event exists).
   */
  async waitForAutomationExecution(
    projectId: string,
    ruleId: string,
    opts: WaitForOptions & {
      routingKey?: string;
      match?: { orderId?: string; productId?: string; idempotencyKey?: string };
    } = {},
  ) {
    const { routingKey, match = {}, ...waitOpts } = opts;
    if (routingKey) {
      await this.waitForOutboxPublished(projectId, routingKey, match, waitOpts);
    }
    return waitFor(
      async () => {
        const rows = await this.findAutomationExecutions(projectId, ruleId);
        return rows.length > 0 ? rows : false;
      },
      {
        label: routingKey
          ? `automation execution after ${routingKey}`
          : 'automation execution',
        timeoutMs: 120_000,
        ...waitOpts,
      },
    );
  }

  /** Read a published outbox envelope for bus-trigger recovery (pipe/contact `_outbox`). */
  async findOutboxEnvelope(
    projectId: string,
    routingKey: string,
    entityId?: string,
  ): Promise<EventEnvelope | null> {
    const rows = await this.db
      .collection('_outbox')
      .find({ projectId, routingKey })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    if (!entityId) return (rows[0]?.envelope as EventEnvelope | undefined) ?? null;
    for (const row of rows) {
      const envelope = row.envelope as EventEnvelope | undefined;
      if (!envelope) continue;
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const subject = String(envelope.subject ?? '');
      if (
        payload.dealId === entityId ||
        payload.deal_id === entityId ||
        payload.contactId === entityId ||
        payload.contact_id === entityId ||
        payload.orderId === entityId ||
        payload.order_id === entityId ||
        payload.activityId === entityId ||
        payload.activity_id === entityId ||
        subject === `deal/${entityId}` ||
        subject === `contact/${entityId}` ||
        subject === `order/${entityId}` ||
        subject === `activity/${entityId}`
      ) {
        return envelope;
      }
    }
    return null;
  }

  /** Reconstruct a bus envelope from automation_event_hooks (orders omit `_outbox`). */
  async findEventHookEnvelope(
    projectId: string,
    routingKey: string,
    entityId?: string,
  ): Promise<EventEnvelope | null> {
    const rows = await this.db
      .collection('automation_event_hooks')
      .find({ project_id: projectId, event_name: routingKey })
      .sort({ created_at: -1 })
      .limit(30)
      .toArray();
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (entityId) {
        const orderId = String(payload.orderId ?? payload.order_id ?? '');
        const dealId = String(payload.dealId ?? payload.deal_id ?? '');
        const contactId = String(payload.contactId ?? payload.contact_id ?? '');
        const activityId = String(payload.activityId ?? payload.activity_id ?? '');
        if (
          entityId !== orderId &&
          entityId !== dealId &&
          entityId !== contactId &&
          entityId !== activityId
        ) {
          continue;
        }
      }
      const messageId = String(row.message_id ?? row.id ?? '').trim();
      if (!messageId) continue;
      return {
        type: routingKey,
        version: 1,
        messageId,
        timestamp: new Date(Number(row.created_at ?? Date.now())).toISOString(),
        source: String(row.source ?? 'event'),
        projectId,
        traceId: String(row.trace_id ?? messageId),
        causationId: String(row.causation_id ?? ''),
        depth: Number(row.depth ?? 0),
        payload,
      };
    }
    return null;
  }

  private auditPayloadMatchesEntity(
    row: Record<string, unknown>,
    entityId: string,
  ): boolean {
    if (String(row.entityId ?? '') === entityId) return true;
    const blobs: Record<string, unknown>[] = [];
    for (const key of ['payloadJson', 'payload_json', 'data']) {
      const raw = row[key];
      if (raw && typeof raw === 'object') {
        blobs.push(raw as Record<string, unknown>);
        continue;
      }
      if (typeof raw === 'string' && raw.trim()) {
        try {
          blobs.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          /* ignore malformed payload */
        }
      }
    }
    const keys = [
      'rule_id',
      'ruleId',
      'userId',
      'user_id',
      'subjectUserId',
      'companyId',
      'company_id',
      'contactId',
      'contact_id',
      'orderId',
      'order_id',
      'activityId',
      'activity_id',
      'dealId',
      'deal_id',
    ];
    return blobs.some((payload) => keys.some((key) => String(payload[key] ?? '') === entityId));
  }

  async findAuditEvent(projectId: string, eventName: string, entityId?: string) {
    const col = this.db.collection('audit_events');
    if (entityId) {
      const exact = await col.findOne(
        { projectId, eventName, entityId },
        { sort: { seq: -1 } },
      );
      if (exact) return exact;
      const recent = await col
        .find({ projectId, eventName })
        .sort({ seq: -1 })
        .limit(50)
        .toArray();
      return recent.find((row) => this.auditPayloadMatchesEntity(row, entityId)) ?? null;
    }
    return col.findOne({ projectId, eventName }, { sort: { seq: -1 } });
  }

  /** Project-scoped audit row since a timestamp (avoids stale rows under parallel load). */
  async findAuditEventSince(
    projectId: string,
    eventName: string,
    sinceMs: number,
    entityId?: string,
  ) {
    const rows = await this.db
      .collection('audit_events')
      .find({ projectId, eventName, createdAt: { $gte: sinceMs } })
      .sort({ seq: -1 })
      .limit(50)
      .toArray();
    if (!entityId) return rows[0] ?? null;
    return rows.find((row) => this.auditPayloadMatchesEntity(row, entityId)) ?? null;
  }

  async findSystemAuditEvent(eventName: string, actorId?: string, sinceMs?: number) {
    const col = this.db.collection('audit_events');
    const filter: Record<string, unknown> = { projectId: 'system', eventName };
    if (sinceMs) filter.createdAt = { $gte: sinceMs };
    const rows = await col.find(filter).sort({ seq: -1 }).limit(20).toArray();
    if (!actorId) return rows[0] ?? null;
    return (
      rows.find((row) => String(row.actorId ?? '') === actorId) ??
      rows.find((row) => {
        try {
          const payload = JSON.parse(String(row.payloadJson ?? row.payload_json ?? '{}')) as Record<
            string,
            unknown
          >;
          return payload.userId === actorId || payload.user_id === actorId;
        } catch {
          return false;
        }
      }) ??
      null
    );
  }

  async findProjectAuditEventSince(
    projectId: string,
    eventName: string,
    sinceMs: number,
    actorId?: string,
  ) {
    const filter: Record<string, unknown> = {
      projectId,
      eventName,
      createdAt: { $gte: sinceMs },
    };
    if (actorId) filter.actorId = actorId;
    return this.db.collection('audit_events').findOne(filter, { sort: { seq: -1 } });
  }

  async findAutomationRule(projectId: string, ruleId: string) {
    return this.db.collection('automation_rules').findOne({ project_id: projectId, id: ruleId });
  }

  async findLatestEventHook(projectId: string, eventName: string) {
    return this.db.collection('automation_event_hooks').findOne(
      { project_id: projectId, event_name: eventName },
      { sort: { created_at: -1 } },
    );
  }

  async findNotification(projectId: string, userId: string, title?: string) {
    const filter: Record<string, unknown> = { project_id: projectId, user_id: userId };
    if (title) filter.title = title;
    return this.db.collection('notification_messages').findOne(filter, { sort: { created_at: -1 } });
  }

  async findNotificationByEventType(
    projectId: string,
    userId: string,
    eventType: string,
    sinceMs?: number,
  ) {
    const filter: Record<string, unknown> = {
      project_id: projectId,
      user_id: userId,
      event_type: eventType,
    };
    if (sinceMs) filter.created_at = { $gte: sinceMs };
    return this.db.collection('notification_messages').findOne(filter, { sort: { created_at: -1 } });
  }

  async findNotificationWithEmailDelivery(
    projectId: string,
    userId: string,
    eventType: string,
  ) {
    return this.db.collection('notification_messages').findOne(
      {
        project_id: projectId,
        user_id: userId,
        event_type: eventType,
        email_status: { $in: ['sent', 'pending'] },
      },
      { sort: { created_at: -1 } },
    );
  }

  async countNotificationsByEventType(projectId: string, userId: string, eventType: string) {
    return this.db.collection('notification_messages').countDocuments({
      project_id: projectId,
      user_id: userId,
      event_type: eventType,
    });
  }

  async findNotificationPrefs(userId: string) {
    return this.db.collection('notification_prefs').findOne({ user_id: userId });
  }
}

/**
 * Read one `driftDetail` entry from a deal document.
 * Pipe drift-consumer writes dotted paths (`driftDetail.company.name`) which Mongo
 * stores as nested documents — not as literal `'company.name'` keys.
 */
export function readDriftDetailEntry(
  driftDetail: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  if (!driftDetail) return undefined;
  const literal = driftDetail[field];
  if (literal != null && typeof literal === 'object') return literal as Record<string, unknown>;
  let cur: unknown = driftDetail;
  for (const seg of field.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}
