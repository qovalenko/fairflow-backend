import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { busQueueName } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import type { DealDoc, DealSnapshot } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-keys this consumer reacts to (pipe.md §5 «Слушает», FR-26/27). */
export const CONTACT_UPDATED_KEY = 'crm.contact.updated';
export const COMPANY_UPDATED_KEY = 'crm.company.updated';

/**
 * A field change normalized across the two source payload shapes:
 *  - `crm.contact.updated`: `{ contactId, changes: [{field, oldValue, newValue, changedBy, changedAt}] }`
 *  - `crm.company.updated`: `{ companyId, changedFields: [{field, old, new}], userId }`
 * The diff functions consume this uniform shape.
 */
export interface NormalizedChange {
  field: string;
  newValue: unknown;
  changedBy?: string;
  changedAt?: number;
}

/** A single drifted snapshot field, ready to persist into `driftDetail`. */
export interface DriftEntry {
  /** Snapshot key: `name|phone|email` for contact, `company.name` for company. */
  field: string;
  snapshotValue: string;
  currentValue: string;
  changedBy: string;
  changedAt: number;
}

/** Null-safe string coercion — snapshot values are always compared as strings. */
function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * Pure diff: contact PII snapshot ↔ the live values carried by
 * `crm.contact.updated`. Returns only the snapshot fields that actually diverged.
 *
 * Field mapping (contact field → snapshot key):
 *  - `phone` → `phone`, `email` → `email` (direct 1:1).
 *  - `firstName`/`lastName` → `name`. The snapshot stores the COMBINED display
 *    name (gateway builds it as `firstName lastName`), so the new full name is
 *    reconstructed from the changed part(s), keeping the unchanged part from the
 *    snapshot name tokens (first token = firstName, rest = lastName). This mirrors
 *    the contact domain's `displayName([firstName, lastName].join(' '))`.
 */
export function computeContactDrift(
  snapshot: DealSnapshot,
  changes: NormalizedChange[],
): DriftEntry[] {
  const out: DriftEntry[] = [];
  const byField = new Map(changes.map((c) => [c.field, c]));

  for (const key of ['phone', 'email'] as const) {
    const ch = byField.get(key);
    if (!ch) continue;
    const current = str(ch.newValue);
    const snapVal = str(snapshot[key]);
    if (current !== snapVal) out.push(toEntry(key, snapVal, current, ch));
  }

  const fn = byField.get('firstName');
  const ln = byField.get('lastName');
  if (fn || ln) {
    const snapName = str(snapshot.name).trim();
    const tokens = snapName.split(/\s+/).filter(Boolean);
    const snapFirst = tokens[0] ?? '';
    const snapLast = tokens.slice(1).join(' ');
    const curFirst = fn ? str(fn.newValue).trim() : snapFirst;
    const curLast = ln ? str(ln.newValue).trim() : snapLast;
    const curName = [curFirst, curLast].filter(Boolean).join(' ').trim();
    if (curName !== snapName) {
      out.push(toEntry('name', snapName, curName, latest(fn, ln)));
    }
  }
  return out;
}

/**
 * Pure diff: company snapshot ↔ `crm.company.updated`. The company snapshot carries
 * `name` and `inn`; fields are prefixed `company.` to match {@link PipeService.getDealDrift}.
 */
export function computeCompanyDrift(
  snapshot: DealSnapshot,
  changes: NormalizedChange[],
): DriftEntry[] {
  const out: DriftEntry[] = [];
  for (const key of ['name', 'inn'] as const) {
    const ch = changes.find((c) => c.field === key);
    if (!ch) continue;
    const current = str(ch.newValue);
    const snapVal = str(snapshot[key]);
    if (current === snapVal) continue;
    const field = key === 'name' ? 'company.name' : 'company.inn';
    out.push(toEntry(field, snapVal, current, ch));
  }
  return out;
}

function toEntry(
  field: string,
  snapshotValue: string,
  currentValue: string,
  ch: NormalizedChange | undefined,
): DriftEntry {
  return {
    field,
    snapshotValue,
    currentValue,
    changedBy: ch?.changedBy ?? '',
    changedAt: ch?.changedAt ?? 0,
  };
}

/** The change with the later `changedAt` (attribution for a combined `name`). */
function latest(
  a: NormalizedChange | undefined,
  b: NormalizedChange | undefined,
): NormalizedChange | undefined {
  if (!a) return b;
  if (!b) return a;
  return (b.changedAt ?? 0) >= (a.changedAt ?? 0) ? b : a;
}

/**
 * Drift-detection listener (pipe.md §5 «Слушает», FR-26/27). On
 * `crm.contact.updated` / `crm.company.updated` it finds this project's OPEN
 * deals that snapshot the changed contact/company, diffs the snapshot against the
 * new values, and flags the diverged fields on the deal so `GET /deals/:id/drift`
 * returns a real diff (previously always empty — the listener was missing).
 *
 * Isolation: the event carries `projectId`; deals are matched ONLY within that
 * project (`{projectId, contactId}` filter) — a foreign event can never touch
 * another tenant's deals.
 *
 * Idempotency: each messageId is recorded in `crm_drift_inbox` (unique index);
 * a redelivery short-circuits. The Mongo writes are themselves idempotent
 * (`$addToSet` on driftFields, `$set` overwrites driftDetail), so a crash between
 * write and ledger-mark simply reprocesses harmlessly.
 */
@Injectable()
export class DriftConsumerService implements OnModuleInit {
  private readonly logger = new Logger(DriftConsumerService.name);
  private readonly enabled = process.env.PIPE_DRIFT_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('pipe drift consumer disabled (PIPE_DRIFT_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = process.env.PIPE_DRIFT_QUEUE ?? busQueueName('pipe.drift');
    const keys = [CONTACT_UPDATED_KEY, COMPANY_UPDATED_KEY];
    try {
      // Bounded initial-bind attempts so a broker outage at boot doesn't block
      // the gRPC API; the consumer's own reconnect loop keeps retrying after.
      await this.rabbit.consume(
        queue,
        keys,
        (payload, routingKey) => this.handle(payload, routingKey),
        Number(process.env.PIPE_DRIFT_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`pipe drift consumer bound queue=${queue} to ${keys.join(', ')}`);
    } catch (err) {
      this.logger.error(
        `pipe drift consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Handle one bus event. Throwing routes the message through the retry ladder →
   * DLQ (never a silent drop); a clean return acks.
   */
  private async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      // No project scope → cannot isolate; drop rather than touch a shared bucket.
      this.logger.warn(`${routingKey} without projectId — skipped`);
      return;
    }
    const messageId = str(env.messageId);
    if (messageId && (await this.alreadyProcessed(messageId))) return;

    const p = (env.payload ?? {}) as Record<string, unknown>;
    const eventChangedAt = env.timestamp ? Date.parse(env.timestamp) : Date.now();

    if (routingKey === CONTACT_UPDATED_KEY) {
      await this.applyContactDrift(projectId, p, env, eventChangedAt);
    } else if (routingKey === COMPANY_UPDATED_KEY) {
      await this.applyCompanyDrift(projectId, p, env, eventChangedAt);
    }

    if (messageId) await this.markProcessed(messageId, routingKey);
  }

  private async applyContactDrift(
    projectId: string,
    p: Record<string, unknown>,
    env: EventEnvelope<Record<string, unknown>>,
    eventChangedAt: number,
  ): Promise<void> {
    const contactId = str(p.contactId);
    if (!contactId) return;
    const rawChanges = Array.isArray(p.changes) ? (p.changes as Record<string, unknown>[]) : [];
    const changes: NormalizedChange[] = rawChanges.map((c) => ({
      field: str(c.field),
      newValue: c.newValue,
      changedBy: str(c.changedBy) || str(env.userId) || undefined,
      changedAt: typeof c.changedAt === 'number' ? c.changedAt : eventChangedAt,
    }));

    const deals = await this.openDealsFor(projectId, 'contactId', contactId);
    for (const deal of deals) {
      const snapshot = (deal.contactSnapshot ?? {}) as DealSnapshot;
      const drift = computeContactDrift(snapshot, changes);
      await this.persistDrift(projectId, deal, drift);
    }
  }

  private async applyCompanyDrift(
    projectId: string,
    p: Record<string, unknown>,
    env: EventEnvelope<Record<string, unknown>>,
    eventChangedAt: number,
  ): Promise<void> {
    const companyId = str(p.companyId);
    if (!companyId) return;
    const rawChanges = Array.isArray(p.changedFields)
      ? (p.changedFields as Record<string, unknown>[])
      : [];
    const actor = str(p.userId) || str(env.userId) || undefined;
    const changes: NormalizedChange[] = rawChanges.map((c) => ({
      field: str(c.field),
      newValue: c.new,
      changedBy: actor,
      changedAt: eventChangedAt,
    }));

    const deals = await this.openDealsFor(projectId, 'companyId', companyId);
    for (const deal of deals) {
      const snapshot = (deal.companySnapshot ?? {}) as DealSnapshot;
      const drift = computeCompanyDrift(snapshot, changes);
      await this.persistDrift(projectId, deal, drift);
    }
  }

  /** Non-closed, non-deleted deals of THIS project linked to the given contact/company. */
  private openDealsFor(
    projectId: string,
    field: 'contactId' | 'companyId',
    value: string,
  ): Promise<DealDoc[]> {
    return this.mongo
      .deals()
      .find({
        projectId,
        [field]: value,
        status: { $nin: ['won', 'lost'] },
        deletedAt: { $in: [null, undefined] },
      })
      .toArray();
  }

  /**
   * Merge drift entries onto the deal: set `driftFlag`, union the field names into
   * `driftFields` ($addToSet, no dups), and write each field's `driftDetail`.
   * The `{_id, projectId}` filter re-asserts isolation on the write.
   */
  private async persistDrift(projectId: string, deal: DealDoc, drift: DriftEntry[]): Promise<void> {
    if (drift.length === 0) return;
    const set: Record<string, unknown> = { driftFlag: true, updatedAt: Date.now() };
    for (const d of drift) {
      set[`driftDetail.${d.field}`] = {
        snapshotValue: d.snapshotValue,
        currentValue: d.currentValue,
        changedBy: d.changedBy,
        changedAt: d.changedAt,
      };
    }
    await this.mongo
      .deals()
      .updateOne(
        { _id: deal._id, projectId },
        { $set: set, $addToSet: { driftFields: { $each: drift.map((d) => d.field) } } },
      );
    this.logger.debug(
      `deal ${str(deal._id)} drift: ${drift.map((d) => d.field).join(',')} (${projectId})`,
    );
  }

  private async alreadyProcessed(messageId: string): Promise<boolean> {
    const row = await this.mongo.driftInbox().findOne({ messageId });
    return !!row;
  }

  private async markProcessed(messageId: string, routingKey: string): Promise<void> {
    try {
      await this.mongo.driftInbox().insertOne({ messageId, routingKey, processedAt: new Date() });
    } catch (err) {
      // Duplicate key = concurrent delivery already recorded it; benign.
      if ((err as { code?: number }).code !== 11000) {
        this.logger.warn(`failed to record drift messageId ${messageId}: ${String(err)}`);
      }
    }
  }
}
