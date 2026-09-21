import { Inject, Injectable } from '@nestjs/common';
import { pickAbacFields } from './abac-fields';
import { buildTokens } from './tokenize';
import { pickSourceFields } from './source-fields';

/**
 * Search projection mapper (I1b) — split out of {@link SearchProjectionService}
 * into its own module so the two classes no longer live in one file.
 *
 * Why this file exists (F1-search / R2 fix): when `ProjectionApply` and
 * `SearchProjectionService` shared one module, the consumer class was declared
 * BEFORE `ProjectionApply` yet referenced it in its constructor metadata
 * (`design:paramtypes` emitted by `emitDecoratorMetadata`). `class` declarations
 * are not hoisted — they sit in the temporal dead zone until their definition
 * line runs — so decorating the earlier class touched `ProjectionApply` before
 * it was initialized, crashing boot with
 * `ReferenceError: Cannot access 'ProjectionApply' before initialization`.
 * Living in its own file, `ProjectionApply` is fully initialized at import time
 * before the consumer module's decorator metadata is evaluated.
 *
 * Maps an RFC-4 routing-key + envelope to an index upsert/tombstone, deriving
 * title/subtitle/tokens/owner from the event payload alone (no source-DB reads —
 * WN-MSRCH-2). Keeping the mapping here also keeps it unit-testable and the
 * consumer transport-only.
 */

/** DI token for the {@link SearchDeltaWriter} backing the projection. */
export const SEARCH_DELTA_WRITER = Symbol('SEARCH_DELTA_WRITER');

/** Thin write port over SearchService so the projection has no Mongo specifics. */
export interface SearchDeltaWriter {
  upsert(d: ProjectionDoc): Promise<void>;
  /**
   * Terminal erase for `crm.<entity>.purged` — see {@link ProjectionApply.isPurge}.
   * Optional so a test double may omit it; the real writer implements it and the
   * degraded path falls back to {@link SearchDeltaWriter.tombstone}.
   */
  purge?(
    projectId: string,
    entityType: string,
    entityId: string,
    version: number,
  ): Promise<void>;
  tombstone(
    projectId: string,
    entityType: string,
    entityId: string,
    version: number,
  ): Promise<void>;
  /**
   * TODO-264: last known projection inputs of an already indexed record, or
   * `null` when the record has no index document at all. Optional so a test
   * double may omit it (the projection then degrades to payload-only, i.e. the
   * pre-fix behaviour) — the real writer implements it.
   */
  sourceFields?(
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null>;
}

export interface ProjectionDoc {
  projectId: string;
  entityType: string;
  entityId: string;
  title?: string;
  subtitle?: string;
  tokens?: string;
  ownerId?: string;
  departmentId?: string;
  /** Debug copy of the materialized ABAC attributes (kept for troubleshooting). */
  abacAttrs?: Record<string, unknown>;
  /** Flat, top-level ABAC attributes the compiled predicate matches (TODO-483). */
  abacFields?: Record<string, unknown>;
  /** Whitelisted projection inputs persisted for the next partial diff (TODO-264). */
  sourceFields?: Record<string, unknown>;
  sourceUpdatedAt: number;
  version: number;
}

@Injectable()
export class ProjectionApply {
  constructor(
    @Inject(SEARCH_DELTA_WRITER) private readonly delta: SearchDeltaWriter,
  ) {}

  /** entityType derived from the routing-key second segment. */
  private static entityType(routingKey: string): string | null {
    const seg = routingKey.split('.');
    if (seg.length < 3 || seg[0] !== 'crm') return null;
    // crm.<entity>.<action> — `<entity>` is the index entityType.
    const entity = seg[1];
    const known = ['contact', 'company', 'deal', 'order', 'product', 'activity'];
    return known.includes(entity) ? entity : null;
  }

  /**
   * `crm.<entity>.purged` — the «удалить навсегда» fact (FR-COMPANIES-040,
   * 152-ФЗ), emitted when the source domain PHYSICALLY deleted the record
   * (companies.service.ts `purge()`). It must NOT be folded into the `.deleted`
   * branch: a tombstone keeps `title` / `subtitle` (ИНН · e-mail) / `tokens` in
   * `search_index` so that a later `.restored` can bring the row back — but a
   * purged record can never be restored, so leaving its denormalized PII in the
   * index would make the one operation whose entire purpose is irreversible
   * erasure not erase anything. Routed to the dedicated write port instead.
   */
  private static isPurge(routingKey: string): boolean {
    return routingKey.endsWith('.purged');
  }

  private static isDelete(routingKey: string): boolean {
    return routingKey.endsWith('.deleted');
  }

  /** `crm.<entity>.<action>` → `<action>` ('' for a malformed key). */
  private static action(routingKey: string): string {
    return routingKey.split('.')[2] ?? '';
  }

  async apply(
    routingKey: string,
    projectId: string,
    envelope: { payload: Record<string, unknown>; timestamp: string; version?: number },
  ): Promise<'upsert' | 'tombstone' | 'purged' | 'unmapped'> {
    const entityType = ProjectionApply.entityType(routingKey);
    if (!entityType) return 'unmapped';

    const raw = envelope.payload ?? {};
    const action = ProjectionApply.action(routingKey);
    // The `to*` aliases MUST be resolved before the merge below, otherwise the
    // stored (old) `stageId`/`status` would shadow the new value the transition
    // event actually carries.
    const payload = canonicalizeTransition(entityType, action, normalizePayload(raw));

    // Version = source mutation time (monotonic), falling back to the event
    // timestamp. Drives out-of-order drop (incoming.version > stored.version).
    const sourceUpdatedAt =
      asNumber(payload.updatedAt) ??
      asNumber(payload.sourceUpdatedAt) ??
      (Date.parse(envelope.timestamp) || Date.now());
    const version = envelope.version
      ? Math.max(envelope.version, sourceUpdatedAt)
      : sourceUpdatedAt;

    // TODO-265: merge payloads name the participants by ROLE, never by the plain
    // `<entity>Id` key `pickId` understands, so `crm.contact.merged` /
    // `crm.company.merged` used to fall through to 'unmapped' and the losing
    // record stayed findable forever (a visible duplicate of its survivor).
    if (action === 'merged' || action === 'merge_reverted') {
      return this.applyMerge(entityType, action, projectId, payload, sourceUpdatedAt, version);
    }

    const entityId = pickId(entityType, payload);
    if (!entityId) return 'unmapped';

    if (ProjectionApply.isDelete(routingKey)) {
      await this.delta.tombstone(projectId, entityType, entityId, version);
      return 'tombstone';
    }
    if (ProjectionApply.isPurge(routingKey)) {
      // The erase port is optional — a writer double without it degrades to the
      // tombstone, which at least takes the record out of every result set.
      if (this.delta.purge) {
        await this.delta.purge(projectId, entityType, entityId, version);
        return 'purged';
      }
      await this.delta.tombstone(projectId, entityType, entityId, version);
      return 'tombstone';
    }

    // TODO-264: a CRM event describes a CHANGE, not a snapshot — and that holds
    // far beyond the `changes[]`/`changedFields[]` diffs. The transition keys
    // carry ONLY the fields that moved: `crm.deal.stage_changed` is
    // `{dealId, fromStageId, toStageId, movedBy}` (pipe.service.ts), so a
    // projection rebuilt from the payload alone erased the deal amount from the
    // subtitle and the deal name from the tokens on every move along the
    // pipeline; `crm.deal.updated` names its changed fields in `changed[]`
    // (values-less) and was equally unprotected. Therefore EVERY non-create
    // event is merged over the projection inputs stored on the index document —
    // the payload still wins on conflict, absent ≠ blank. `created` is the one
    // true snapshot, so it needs no read (and must not resurrect stale inputs of
    // a recycled id). Cost: one indexed findOne per event, see
    // {@link SearchService.indexSourceFields} (projected to `sourceFields`).
    const fields =
      action === 'created'
        ? payload
        : { ...(await this.knownFields(projectId, entityType, entityId)), ...payload };

    const projection = buildProjection(entityType, projectId, entityId, fields);
    const sourceFields = pickSourceFields(fields);
    await this.delta.upsert({
      projectId,
      entityType,
      entityId,
      ...projection,
      ...(Object.keys(sourceFields).length ? { sourceFields } : {}),
      sourceUpdatedAt,
      version,
    });
    return 'upsert';
  }

  /** Last known projection inputs of an indexed record ({} when unavailable). */
  private async knownFields(
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.delta.sourceFields) return {};
    return (await this.delta.sourceFields(projectId, entityType, entityId)) ?? {};
  }

  /**
   * TODO-265: `*.merged` / `*.merge_reverted` projection.
   *
   * `crm.contact.merged` ships `{ sourceContactIds[], targetContactId }` and
   * `crm.company.merged` ships `{ masterId, loserId }` — the loser is soft-deleted
   * in its own domain but emits no `*.deleted`, so only this branch removes it
   * from search. `crm.company.merge_reverted` is the exact inverse: the loser is
   * alive again, and clearing the tombstone is enough because
   * {@link SearchService.indexDelete} keeps title/subtitle/tokens on the document.
   *
   * The SURVIVOR is only re-projected when the payload actually carries
   * projectable values (it normally does not — merge emits role ids and field
   * DECISIONS, not field values). Upserting it blind would insert an ownerless
   * orphan for a survivor that was never indexed, which no scope but 'all' can
   * see; its stale fields are instead repaired by the next `*.updated` or by the
   * recovery reindex.
   */
  private async applyMerge(
    entityType: string,
    action: 'merged' | 'merge_reverted',
    projectId: string,
    payload: Record<string, unknown>,
    sourceUpdatedAt: number,
    version: number,
  ): Promise<'upsert' | 'tombstone' | 'unmapped'> {
    const losers = pickMergeLosers(entityType, payload);
    if (!losers.length) return 'unmapped';

    if (action === 'merge_reverted') {
      let revived = 0;
      for (const entityId of losers) {
        // A record that was never indexed has nothing to revive — inserting an
        // empty document here would create an ownerless orphan.
        if (this.delta.sourceFields) {
          const prev = await this.delta.sourceFields(projectId, entityType, entityId);
          if (prev === null) continue;
        }
        await this.delta.upsert({ projectId, entityType, entityId, sourceUpdatedAt, version });
        revived += 1;
      }
      return revived ? 'upsert' : 'unmapped';
    }

    for (const entityId of losers) {
      await this.delta.tombstone(projectId, entityType, entityId, version);
    }

    const survivor = pickMergeSurvivor(entityType, payload);
    if (survivor) {
      const projection = buildProjection(entityType, projectId, survivor, payload);
      if (Object.keys(projection).length) {
        await this.delta.upsert({
          projectId,
          entityType,
          entityId: survivor,
          ...projection,
          sourceUpdatedAt,
          version,
        });
      }
    }
    return 'tombstone';
  }
}

// ── payload helpers ────────────────────────────────────────────────────────

/**
 * Normalize producer payload variants to the flat shape `pickId`/`buildProjection`
 * expect (TODO-049: products were never indexed — `apply()` returned 'unmapped').
 * Two nested formats are unwrapped WITHOUT touching the event contract itself
 * (audit `crm.#` and automation consume the same events as-is):
 *  - `{ after: { id, ... } }`  — `crm.product.created` nests all fields;
 *  - `{ id, changes: [{ field, old, new }] }` — `crm.product.updated` ships a diff.
 * Top-level keys ALWAYS win over unwrapped ones, so already-flat payloads of the
 * other entity types (contact/company/deal/order/activity) behave exactly as before.
 *
 * TODO-264: the diff arrays are producer-specific and only ONE of the three value
 * spellings was understood, so two of the three real producers projected nothing:
 *  - `changes: [{field, old, new}]`             — product (product.service.ts);
 *  - `changes: [{field, oldValue, newValue}]`   — contact (contacts.service.ts:389);
 *  - `changedFields: [{field, old, new}]`       — company (companies.service.ts:491).
 * All three are read now. An entry that names a field WITHOUT carrying a value
 * (a names-only diff) is skipped rather than written as `undefined`, so it can
 * never blank a projected field.
 */
const DIFF_KEYS = ['changes', 'changedFields'] as const;

function normalizePayload(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DIFF_KEYS) {
    const arr = p[key];
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      const change = c as {
        field?: unknown;
        new?: unknown;
        newValue?: unknown;
        after?: unknown;
        value?: unknown;
      };
      if (typeof change.field !== 'string') continue;
      const next =
        change.new !== undefined
          ? change.new
          : change.newValue !== undefined
            ? change.newValue
            : change.after !== undefined
              ? change.after
              : change.value;
      if (next === undefined) continue;
      out[change.field] = next;
    }
  }
  if (p.after && typeof p.after === 'object' && !Array.isArray(p.after)) {
    Object.assign(out, p.after as Record<string, unknown>);
  }
  return Object.assign(out, p);
}

/**
 * TODO-264: transition events name the NEW value by a `to*` alias
 * (`crm.deal.stage_changed` → `toStageId`, `crm.deal.reopened` → `toStageId`,
 * `crm.order.status_changed` → `to`), while the canonical projection input is
 * `stageId` / `status`. Resolve the alias onto the canonical key so that
 *  (a) the merge over the stored inputs cannot let the OLD value shadow it, and
 *  (b) the new value is persisted back into `sourceFields` for the next partial.
 * The bare `from`/`to` pair is only interpreted for the one key that defines it
 * as a status transition — it is too generic to read anywhere else.
 */
function canonicalizeTransition(
  entityType: string,
  action: string,
  p: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...p };
  if (p.toStageId !== undefined) out.stageId = p.toStageId;
  if (p.toStatus !== undefined) out.status = p.toStatus;
  if (entityType === 'order' && action === 'status_changed' && p.to !== undefined) {
    out.status = p.to;
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** Extract the entity id from a payload keyed by `<entity>Id` (RFC-4 contract). */
function pickId(entityType: string, p: Record<string, unknown>): string | null {
  const key = `${entityType}Id`;
  const candidates = [p[key], p.entityId, p.id];
  for (const c of candidates) {
    if (c != null && String(c)) return String(c);
  }
  return null;
}

/** `contact` → `Contact` (for the `source<Entity>Ids` / `target<Entity>Id` keys). */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Ids in a merge payload, accepting both a scalar and an array under each key. */
function collectIds(p: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const v = p[key];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item == null) continue;
      const id = String(item);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * TODO-265: records absorbed by a merge — the ones that must stop being findable.
 * `crm.contact.merged` → `sourceContactIds[]`, `crm.company.merged` → `loserId`.
 */
function pickMergeLosers(entityType: string, p: Record<string, unknown>): string[] {
  const E = capitalize(entityType);
  return collectIds(p, [
    `source${E}Ids`,
    `source${E}Id`,
    'sourceIds',
    'sourceId',
    'loserIds',
    'loserId',
  ]);
}

/** The record a merge kept: `target<Entity>Id` (contact) / `masterId` (company). */
function pickMergeSurvivor(entityType: string, p: Record<string, unknown>): string | null {
  const E = capitalize(entityType);
  return collectIds(p, [`target${E}Id`, 'targetId', 'masterId'])[0] ?? null;
}

/** Owner extraction tolerant to the per-domain field name (contract §5.2 DEP). */
function ownerOf(p: Record<string, unknown>): string | undefined {
  const v = p.ownerId ?? p.assigneeId ?? p.assignee_id ?? p.owner_id;
  return v != null && String(v) ? String(v) : undefined;
}
function deptOf(p: Record<string, unknown>): string | undefined {
  const v = p.departmentId ?? p.department_id;
  return v != null && String(v) ? String(v) : undefined;
}

/**
 * Tokenize PII-derived fields for substring/normalized matching (FR-MSRCH-24).
 * Strictly whitelisted upstream (only fields passed in) — no untrusted egress.
 *
 * TODO-260: the body moved to the SINGLE shared tokenizer (`./tokenize`) that
 * both the event-delta path (here) and the reindex path in SearchService use, so
 * the two indexes can no longer drift; it also emits digits-only phone tails and
 * the email local part so those queries actually match.
 */
const tokenize = (parts: Array<string | undefined>): string => buildTokens(parts);

/**
 * Build the denormalized index fields for an entity from its event payload.
 * Only fields present in the payload are returned — partial events (`updated`,
 * `stage_changed`) merge over the stored doc, they never blank existing fields.
 */
function buildProjection(
  entityType: string,
  projectId: string,
  entityId: string,
  p: Record<string, unknown>,
): Partial<ProjectionDoc> {
  const owner = ownerOf(p);
  const dept = deptOf(p);
  const base: Partial<ProjectionDoc> = {};
  if (owner !== undefined) base.ownerId = owner;
  if (dept !== undefined) base.departmentId = dept;

  // TODO-483: materialize the declared ABAC attributes as FLAT top-level fields
  // for EVERY type (they used to exist only for deals, and only nested under
  // `abacAttrs`, which the compiled predicate — flat `record.<field>` refs —
  // could never match). `abacAttrs` stays as a debug copy of the same map.
  // Partial events (`stage_changed`/`status_changed`) carry the new value under
  // a `to*` alias; normalize it so the attribute is refreshed, never blanked.
  const abac = pickAbacFields(entityType, {
    ...p,
    ...(p.stageId === undefined && p.toStageId !== undefined ? { stageId: p.toStageId } : {}),
    ...(p.status === undefined && p.toStatus !== undefined ? { status: p.toStatus } : {}),
  });
  if (Object.keys(abac).length) {
    base.abacFields = abac;
    base.abacAttrs = abac;
  }

  switch (entityType) {
    case 'contact': {
      const fullName = `${str(p.firstName)} ${str(p.lastName)}`.trim();
      const title = fullName || (p.name ? str(p.name) : undefined);
      const email = str(p.email);
      const phone = str(p.phone);
      const subtitleFromPayload = str(p.subtitle);
      const indexTokens = str(p.indexTokens);
      const subtitle =
        subtitleFromPayload || (email || phone ? [email, phone].filter(Boolean).join(' · ') : '');
      return {
        ...base,
        ...(title ? { title } : {}),
        ...(subtitle ? { subtitle } : {}),
        ...(indexTokens
          ? { tokens: indexTokens }
          : title || email || phone
            ? { tokens: tokenize([title, email, phone]) }
            : {}),
      };
    }
    case 'company': {
      const name = p.name ? str(p.name) : undefined;
      const inn = str(p.inn);
      const email = str(p.email);
      return {
        ...base,
        ...(name ? { title: name } : {}),
        ...(inn || email ? { subtitle: [inn, email].filter(Boolean).join(' · ') } : {}),
        ...(name || inn || email ? { tokens: tokenize([name, inn, email]) } : {}),
      };
    }
    case 'deal': {
      const name = p.name ? str(p.name) : undefined;
      const stage = str(p.stageId ?? p.toStageId);
      const amount = p.amount != null ? str(p.amount) : '';
      const sub = [stage, amount].filter(Boolean).join(' · ');
      return {
        ...base,
        ...(name ? { title: name } : {}),
        ...(sub ? { subtitle: sub } : {}),
        ...(name || stage ? { tokens: tokenize([name, stage, amount]) } : {}),
      };
    }
    case 'order': {
      const number = p.number ? str(p.number) : undefined;
      const st = str(p.status ?? p.toStatus);
      return {
        ...base,
        ...(number ? { title: number } : {}),
        ...(st ? { subtitle: st } : {}),
        ...(number || st ? { tokens: tokenize([number, st]) } : {}),
      };
    }
    case 'product': {
      const name = p.name ? str(p.name) : undefined;
      // The product domain ships `category` (crm.product.created/updated payloads);
      // `sku` is kept first for flat RFC-4 payloads that may carry it.
      const sub = str(p.sku) || str(p.category);
      return {
        ...base,
        ...(name ? { title: name } : {}),
        ...(sub ? { subtitle: sub } : {}),
        ...(name || sub ? { tokens: tokenize([name, sub]) } : {}),
      };
    }
    case 'activity': {
      const title = p.title ? str(p.title) : p.subject ? str(p.subject) : undefined;
      const st = str(p.status ?? (p.completed ? 'completed' : ''));
      return {
        ...base,
        ...(title ? { title } : {}),
        ...(st ? { subtitle: st } : {}),
        ...(title ? { tokens: tokenize([title]) } : {}),
      };
    }
    default:
      return base;
  }
}
