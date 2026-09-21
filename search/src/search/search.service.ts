import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ObjectId, type Collection } from 'mongodb';
import {
  buildCrossEntityVisibilityFilter,
  CROSS_ENTITY_TYPE_SUBJECTS,
  type VisibilityScope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { abacCompletenessFilter, pickAbacFields, searchAbacIndexSpecs } from './abac-fields';
import { buildTokens } from './tokenize';
import { pickSourceFields } from './source-fields';

/** Canonical index document. `projectId` is the ONLY isolation key (single DB,
 * predicate isolation — see contract §1 [SEC-BLOCKER]). owner/department/abac are
 * required for the read-time PEP predicate (no orphan records). */
type SearchIndexDoc = {
  _id: ObjectId;
  projectId: string;
  entityType: string;
  entityId: string;
  title: string;
  subtitle: string;
  path: string;
  tokens: string;
  ownerId: string | null;
  departmentId: string | null;
  ownerField: string;
  abacAttrs: Record<string, unknown>;
  /** Whitelisted projection inputs, merged into by partial events (TODO-264). */
  sourceFields: Record<string, unknown>;
  sourceUpdatedAt: number;
  deletedAt: number | null;
  version: number;
  updatedAt: number;
};

/** A document as written by the reindex path: the canonical fields plus the flat
 * materialized ABAC attributes of the entity type (TODO-483). */
type SearchIndexWrite = Omit<SearchIndexDoc, '_id'> & Record<string, unknown>;

/** One indexable source collection for the recovery reindex. */
interface ReindexSource {
  /** index entityType. */
  type: string;
  /** Mongo collection name — reported in ReindexResponse.sources. */
  collection: string;
  coll: () => Collection;
  map: (row: Record<string, unknown>, projectId: string, now: number) => SearchIndexWrite;
}

/** Owner/department extraction tolerant to the per-domain field name. */
const ownerOfRow = (row: Record<string, unknown>): string | null =>
  (row.ownerId as string) ??
  (row.owner_id as string) ??
  (row.assigneeId as string) ??
  (row.assignee_id as string) ??
  null;
const deptOfRow = (row: Record<string, unknown>): string | null =>
  (row.departmentId as string) ?? (row.department_id as string) ?? null;
const rowId = (row: Record<string, unknown>): string => String((row._id as ObjectId).toString());
const rowStr = (row: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const v = row[key];
    if (v != null && String(v) !== '') return String(v);
  }
  return '';
};

/** Per-request access context resolved on the gateway and propagated as metadata.
 * The domain (PEP) only applies it — it never parses JWT (contract §1 PDP/PEP). */
export interface SearchAccessContext {
  scope?: VisibilityScope;
  /** Effective enabled module ids (x-enabled-modules); undefined → no filtering. */
  enabledModules?: string[];
  /** Compiled ABAC predicate (x-access-predicate.mongo); applied AND, fail-closed
   * for attributes absent from the index — draft, depends on v1/ABAC (RFC-5). */
  accessPredicate?: Record<string, unknown>;
  /** The gateway transmitted an x-access-predicate that could not be decoded/shaped
   * (broken deny-rule). Fail-closed: the read must match NOTHING — never silently
   * drop the narrowing (RFC-ABAC §4, P8 T3.2b). */
  accessMalformed?: boolean;
  /** The viewer's own user id (`x-visibility-scope.selfId`, else `x-user-id`).
   * Only used to resolve the `my` scope preset — never to widen a read. */
  selfId?: string;
}

/** TODO-262 / FR-SEARCH-140: the UI scope preset, as it reaches the domain.
 * `all`/absent = no extra filter (today's behaviour). */
export type OwnerScopePreset = 'my' | 'dept' | 'all';

export function normalizeOwnerScope(raw: unknown): OwnerScopePreset | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'my' || v === 'dept' || v === 'all' ? v : undefined;
}

const MAX_QUERY_LEN = 256;
const DEFAULT_MIN_QUERY_CHARS = 2;
const DEFAULT_PER_TYPE_LIMIT = 5;
const ALLOWED_PAGE_SIZES = [25, 50, 100];
const DEFAULT_FRESHNESS_SLA_MS = 5000;

/** entityType → module id, for the enabled-modules type filter (FR-MSRCH-11).
 *
 * [review-1] Derived from the shared PEP↔index contract, NOT hand-written: the
 * gateway compiles the cross-entity ABAC predicate as one `entityType`-guarded
 * disjunct per subject of that same map, and a type indexed here but missing there
 * would match no disjunct and silently vanish from every ABAC-narrowed search. One
 * constant makes the two vocabularies incapable of drifting. */
const TYPE_TO_MODULE: Record<string, string> = { ...CROSS_ENTITY_TYPE_SUBJECTS };
/** Exported so specs can pin the reindex-source coverage invariant: every
 * indexable type MUST have a source in `reindexSources()` (TODO-487 —
 * `activity` was indexable and delta-maintained yet never rebuilt). */
export const ALL_INDEXABLE_TYPES = Object.keys(TYPE_TO_MODULE);

@Injectable()
export class SearchService implements OnModuleInit {
  /** Sentinel entityType that never exists in the index → matches no document.
   * Used to force a fail-closed empty result on a malformed ABAC predicate
   * (a broken deny-rule must never widen access; P8 T3.2b, RFC-ABAC §4). */
  private static readonly DENY_ALL_TYPE = '__deny_all__';
  /** Project-level catalogue rows legitimately have no ownerId (product.md S6). */
  private static readonly OWNER_OPTIONAL_ENTITY_TYPES = new Set(['product']);

  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureIndexes();
    // The event delta projection (crm.* → upsert/tombstone) is now a real
    // consumer (E4-19), wired in SearchProjectionService — it replaces the
    // wave-3 scaffold and the historic DoS pattern (full reindex on every
    // event, contract §3.3 [SEC], §5.2 [AS-IS-ДЕФЕКТ]). Search continues to
    // expose the manual Reindex RPC as the recovery path.
  }

  private async ensureIndexes(): Promise<void> {
    const index = this.mongo.searchIndex();
    const specs: Array<{
      coll: Collection;
      key: Record<string, 1 | -1>;
      name: string;
      unique?: boolean;
      sparse?: boolean;
    }> = [
      // Idempotent upsert key (one doc per source record).
      { coll: index, key: { projectId: 1, entityType: 1, entityId: 1 }, name: 'uq_project_type_entity', unique: true },
      // Visibility / tombstone scan path.
      { coll: index, key: { projectId: 1, deletedAt: 1, ownerId: 1 }, name: 'ix_project_deleted_owner' },
      // Per-type read path: equality on projectId/entityType/deletedAt plus the
      // updatedAt sort of the group query (search(): find + sort({updatedAt:-1})).
      { coll: index, key: { projectId: 1, entityType: 1, deletedAt: 1, updatedAt: -1 }, name: 'ix_project_type_deleted_updated' },
      // TODO-483: project-scoped compound indexes for the flat materialized ABAC
      // attributes, so the compiled predicate ANDed in buildBaseFilter is
      // index-backed instead of a residual scan.
      ...searchAbacIndexSpecs().map((spec) => ({ coll: index, key: spec.key, name: spec.name, sparse: true })),
      // TODO-491: `search_index_state` MUST hold exactly one bookkeeping row per
      // project — the whole reindex single-flight lock is a CAS over that one
      // row (acquireReindexLock), and backfill/status read it with a bare
      // findOne({projectId}). Without a unique key two concurrent upserts of a
      // missing row both insert (a normal Mongo race, and the race happens
      // exactly where the lock matters: the first two queries against an empty
      // project), after which each CAS matches its own copy and both rebuilds
      // run — the very thing the lock exists to prevent.
      { coll: this.mongo.searchIndexState(), key: { projectId: 1 }, name: 'uq_state_project', unique: true },
    ];
    for (const spec of specs) {
      try {
        await spec.coll.createIndex(spec.key, {
          name: spec.name,
          ...(spec.unique ? { unique: true } : {}),
          ...(spec.sparse ? { sparse: true } : {}),
        });
      } catch {
        // Index creation is best-effort at boot; a duplicate/legacy index must not
        // crash the service (and must not stop the remaining specs). Real
        // migration tooling owns the canonical state.
      }
    }
  }

  private assertProjectId(projectId: string): void {
    if (!projectId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'project_id is required' });
    }
  }

  /** TODO-260: single tokenizer shared with the event-delta projection. */
  private toTokens(parts: Array<string | undefined | null>): string {
    return buildTokens(parts);
  }

  /**
   * Relevance score, evaluated INSIDE Mongo (`$addFields` in {@link search}).
   *
   * TODO-261: the score used to be computed in the process over a "4×
   * per_type_limit most recently updated matches" candidate window, which made a
   * page impossible to cut honestly — the window always started at the newest
   * document, so page 2 re-served page 1. Ordering by a DB-side expression lets
   * `$sort` + `$skip` + `$limit` produce a real, disjoint slice of a globally
   * ordered result set (Mongo turns `$sort`+`$limit` into a memory-bounded
   * top-k, so this is not a full in-memory sort).
   *
   * The weights and their semantics are 1:1 with the previous in-memory scorer
   * (lowercased equality / prefix / substring); `q` is already lowercased and
   * length-capped by the caller. Kept as ONE definition so the ordering cannot
   * silently diverge between paths.
   */
  private static readonly SCORE_RULES: ReadonlyArray<{
    field: 'title' | 'subtitle' | 'tokens';
    mode: 'eq' | 'prefix' | 'includes';
    weight: number;
  }> = [
    { field: 'title', mode: 'eq', weight: 120 },
    { field: 'title', mode: 'prefix', weight: 80 },
    { field: 'title', mode: 'includes', weight: 50 },
    { field: 'subtitle', mode: 'includes', weight: 25 },
    { field: 'tokens', mode: 'includes', weight: 10 },
  ];

  private scoreExpr(q: string): Record<string, unknown> {
    const branches = SearchService.SCORE_RULES.map((rule) => {
      // $ifNull first: a missing subtitle/tokens must score 0, not error.
      const target = { $toLower: { $ifNull: [`$${rule.field}`, ''] } };
      const cond =
        rule.mode === 'eq'
          ? { $eq: [target, q] }
          : rule.mode === 'prefix'
            ? { $eq: [{ $indexOfCP: [target, q] }, 0] }
            : { $gte: [{ $indexOfCP: [target, q] }, 0] };
      return { $cond: [cond, rule.weight, 0] };
    });
    return { $add: branches };
  }

  private buildHit(doc: SearchIndexDoc, score: number) {
    return {
      id: doc._id.toString(),
      entity_type: doc.entityType,
      entity_id: doc.entityId,
      title: doc.title,
      subtitle: doc.subtitle,
      path: doc.path,
      score,
      updated_at: doc.updatedAt,
    };
  }

  /** Effective set of entity types = indexable ∩ requested entityTypes ∩
   * enabled-modules (FR-MSRCH-11). Empty array means "no types" → empty result.
   *
   * [review-1] The module set is THREE-state, and the difference is a security
   * boundary, not a nicety: `/search/query` deliberately carries no
   * @RequireModule('search') (T-018, search is cross-cutting), so this type
   * intersection is the ONLY module gate on the read. Therefore
   *   - `undefined` = the gateway sent no `x-enabled-modules` at all (pre-header
   *     caller / non-project-scoped path) → old contract, no module narrowing;
   *   - `[]` = the gateway resolved the set and it is EMPTY → nothing is enabled,
   *     so nothing is searchable (types = [] → empty result, fail-closed).
   * Treating `[]` as "don't filter" made the gate vanish exactly when the gateway
   * degraded — the one moment every other route fails closed. The gateway now
   * always emits the header for a project-scoped route (outbound-metadata +
   * ProjectAccessGuard invariant), so `undefined` here means "no header", never
   * "empty set". */
  private effectiveTypes(ctx: SearchAccessContext, requested?: string[]): string[] {
    let types = ALL_INDEXABLE_TYPES;
    if (requested && requested.length) {
      const wanted = new Set(requested);
      types = types.filter((t) => wanted.has(t));
    }
    if (ctx.enabledModules) {
      const enabled = new Set(ctx.enabledModules);
      types = types.filter((t) => enabled.has(TYPE_TO_MODULE[t]));
    }
    return types;
  }

  /** PEP filter: {projectId} AND {deletedAt:null} AND visibility AND abac AND
   * {entityType in effectiveTypes} — assembled BEFORE materialization. projectId
   * is the trusted value resolved from x-project-id by the controller.
   *
   * A malformed x-access-predicate is a broken deny-rule → the whole read is
   * denied (fail-closed, RFC-ABAC §4). DENY_ALL_TYPE never matches a real
   * entityType, so the filter matches nothing across ALL search paths (main list,
   * total_by_type / groups / total_by_owner aggregations all derive from this
   * base) without leaking existence.
   *
   * TODO-262: the UI scope preset (`my`/`dept`) is ANDed here as an EXTRA
   * narrowing on top of the visibility predicate — after it, never instead of it.
   * That ordering is the whole safety argument: the preset can only ever remove
   * rows the viewer was already allowed to see, so a bogus/forged value cannot
   * widen a read. It lives in the base filter (not in the per-group find) so the
   * `total_by_type` / groups / `total_by_owner` aggregations, which all derive
   * from this filter, stay consistent with the rendered list. */
  private buildBaseFilter(
    projectId: string,
    ctx: SearchAccessContext,
    types: string[],
    preset?: { ownerScope?: OwnerScopePreset; departmentIds?: string[] },
  ): Record<string, unknown> {
    if (ctx.accessMalformed) {
      // Fail-closed: broken predicate ⇒ match nothing (still projectId-scoped).
      return { $and: [{ projectId }, { entityType: SearchService.DENY_ALL_TYPE }] };
    }
    const and: Record<string, unknown>[] = [
      { projectId },
      { deletedAt: null },
      { entityType: { $in: types } },
    ];
    // TODO-109: the index is CROSS-ENTITY — a record is (entityType, entityId), not
    // the index document's own `_id`. The plain buildVisibilityFilter share disjunct
    // (`_id ∈ sharedRecordIds`) therefore never matched, so records shared with the
    // viewer were invisible in global search while visible on their own list route.
    // The cross-entity builder matches shares per type from `sharedRecordIdsByType`
    // (resolved cross-resource by the gateway) and keeps the same fail-closed owner
    // branch. Shares stay inside the `entityType ∈ types` / `deletedAt: null` AND
    // above: a share never resurrects a deleted record nor a disabled module's type.
    const vis = buildCrossEntityVisibilityFilter(ctx.scope, 'ownerId', {
      typeField: 'entityType',
      idField: 'entityId',
    });
    if (vis) and.push(vis);
    if (ctx.accessPredicate && Object.keys(ctx.accessPredicate).length) {
      and.push(ctx.accessPredicate);
      // [review-1] …and only judge a document on ABAC attributes it actually has.
      // Producers ship a hand-picked payload, so an event-projected document is
      // missing most declared attributes, while the same record after Reindex has
      // them all. Without this clause the two write paths disagree in the UNSAFE
      // direction: the deny form the gateway emits (`$nor: [{region:'EU'}]`)
      // MATCHES a document that has no `region`, so a record a deny-rule forbids
      // would be handed out by search. Pure narrowing, ANDed after the predicate —
      // see `abacCompletenessFilter`.
      const complete = abacCompletenessFilter(types, ctx.accessPredicate);
      if (complete) and.push(complete);
    }
    const narrowing = this.scopePresetFilter(ctx, preset);
    if (narrowing) and.push(narrowing);
    return and.length === 1 ? and[0] : { $and: and };
  }

  /** TODO-262 / FR-SEARCH-140: «Мои» → own records only, «Мой отдел» → the
   * viewer's departments. Both fail closed on a missing input (`$in: []` matches
   * nothing) rather than degrading to "no filter" — a preset that cannot be
   * resolved must show less, never more. `all`/absent → no filter at all, i.e.
   * byte-identical to the pre-TODO-262 request. */
  private scopePresetFilter(
    ctx: SearchAccessContext,
    preset?: { ownerScope?: OwnerScopePreset; departmentIds?: string[] },
  ): Record<string, unknown> | null {
    const ownerScope = preset?.ownerScope;
    if (!ownerScope || ownerScope === 'all') return null;
    if (ownerScope === 'my') {
      const selfId = ctx.scope?.selfId || ctx.selfId || '';
      return { ownerId: { $in: selfId ? [selfId] : [] } };
    }
    const depts = (preset?.departmentIds ?? []).filter((d) => typeof d === 'string' && d !== '');
    return { departmentId: { $in: depts } };
  }

  /**
   * Source collections the recovery reindex rebuilds from, and how a raw row is
   * projected onto an index document.
   *
   * NOTE: WN-MSRCH-2 violation persists here AS-IS — reindex reads the source
   * collections directly. The TO-BE channel (gRPC List* / event delta) is
   * blocked on E3-02 (contract §3.3, OQ-MSRCH-13, TODO-487). Kept as the manual
   * recovery path; owner/department/ABAC attributes are denormalized for the
   * read PEP.
   */
  private reindexSources(): ReindexSource[] {
    return [
      {
        type: 'contact',
        collection: 'contacts',
        coll: () => this.mongo.contacts(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const firstName = rowStr(row, 'firstName', 'first_name');
          const lastName = rowStr(row, 'lastName', 'last_name');
          const fullName = `${firstName} ${lastName}`.trim() || `Contact ${id.slice(-6)}`;
          const email = rowStr(row, 'email');
          const phone = rowStr(row, 'phone');
          return this.makeDoc(projectId, 'contact', id, fullName, email || phone, `/p/${projectId}/contacts/${id}`, this.toTokens([fullName, email, phone]), ownerOfRow(row), deptOfRow(row), now, pickAbacFields('contact', row, { complete: true }), pickSourceFields(row));
        },
      },
      {
        type: 'company',
        collection: 'companies',
        coll: () => this.mongo.companies(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const name = rowStr(row, 'name') || `Company ${id.slice(-6)}`;
          const email = rowStr(row, 'email');
          const inn = rowStr(row, 'inn');
          return this.makeDoc(projectId, 'company', id, name, inn || email, `/p/${projectId}/companies/${id}`, this.toTokens([name, inn, email]), ownerOfRow(row), deptOfRow(row), now, pickAbacFields('company', row, { complete: true }), pickSourceFields(row));
        },
      },
      {
        type: 'deal',
        collection: 'crm_deals',
        coll: () => this.mongo.deals(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const name = rowStr(row, 'name') || `Deal ${id.slice(-6)}`;
          const stage = rowStr(row, 'stageId', 'stage_id');
          const amount = Number((row as { amount?: number }).amount ?? 0);
          return this.makeDoc(projectId, 'deal', id, name, `${stage} ${amount}`.trim(), `/p/${projectId}/deals/${id}`, this.toTokens([name, stage, String(amount)]), ownerOfRow(row), deptOfRow(row), now, pickAbacFields('deal', row, { complete: true }), pickSourceFields(row));
        },
      },
      {
        type: 'order',
        collection: 'crm_orders',
        coll: () => this.mongo.orders(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const number = rowStr(row, 'number') || `ORD-${id.slice(-6)}`;
          const stage = rowStr(row, 'stageId', 'stage_id');
          const st = rowStr(row, 'status');
          return this.makeDoc(projectId, 'order', id, number, `${stage} ${st}`.trim(), `/p/${projectId}/orders/${id}`, this.toTokens([number, stage, st]), ownerOfRow(row), deptOfRow(row), now, pickAbacFields('order', row, { complete: true }), pickSourceFields(row));
        },
      },
      {
        type: 'product',
        collection: 'crm_products',
        coll: () => this.mongo.products(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const name = rowStr(row, 'name') || `Product ${id.slice(-6)}`;
          const sku = rowStr(row, 'sku');
          const category = rowStr(row, 'category');
          // Products are project-level: no ownerId; ownerDepartmentId is the
          // domain's department field (product.md S6) → index departmentId.
          const dept = deptOfRow(row) ?? ((row as { ownerDepartmentId?: string }).ownerDepartmentId ?? null);
          return this.makeDoc(projectId, 'product', id, name, sku || category, `/p/${projectId}/products/${id}`, this.toTokens([name, sku, category]), ownerOfRow(row), dept, now, pickAbacFields('product', row, { complete: true }), pickSourceFields(row));
        },
      },
      {
        // TODO-487 (partial): activities are an indexable type (ALL_INDEXABLE_TYPES)
        // and the delta consumer maintains them, but the recovery reindex used to
        // skip the collection entirely — so a freshly backfilled project could not
        // find ANY activity. Rebuilt from the source like the other five.
        type: 'activity',
        collection: 'crm_activities',
        coll: () => this.mongo.activities(),
        map: (row, projectId, now) => {
          const id = rowId(row);
          const title = rowStr(row, 'title', 'subject') || `Activity ${id.slice(-6)}`;
          const type = rowStr(row, 'type');
          const st = rowStr(row, 'status');
          return this.makeDoc(projectId, 'activity', id, title, [type, st].filter(Boolean).join(' '), `/p/${projectId}/activities/${id}`, this.toTokens([title, type, st]), ownerOfRow(row), deptOfRow(row), now, pickAbacFields('activity', row, { complete: true }), pickSourceFields(row));
        },
      },
    ];
  }

  /**
   * Full rebuild of the derived index for one project (manual recovery RPC and
   * the lazy backfill behind it).
   *
   * TODO-256: streamed with a CURSOR in bounded batches instead of the old
   * `.limit(10000).toArray()` per collection — a project with more rows silently
   * lost everything past the cap, and the caller had no way to learn about it.
   * A cut-off pass (only possible with an explicit `SEARCH_REINDEX_MAX_DOCS`
   * budget) is reported back as `truncated` + `skipped_types`, and the lazy
   * backfill refuses to stamp `backfilledAt` for it.
   *
   * TODO-257: soft-deleted source rows are excluded, and after a COMPLETE pass
   * over a type every index document the pass did not touch is tombstoned — a
   * record deleted while the delta consumer was down no longer resurrects.
   *
   * TODO-491: the pass takes a per-project LOCK. The tombstone sweep above turned
   * "two concurrent rebuilds" from merely wasteful into destructive — pass B
   * rewrites the documents, pass A then sweeps everything it does not recognise
   * and live records silently vanish from search. Since the lazy backfill calls
   * reindex from the READ path, any project member could trigger that. A second
   * caller is now rejected with gRPC ABORTED (gateway renders it as HTTP 409),
   * and the sweep additionally keys on this run's id instead of a timestamp.
   */
  async reindex(projectId: string, entityTypes?: string[]) {
    this.assertProjectId(projectId);
    const runId = await this.acquireReindexLock(projectId);
    if (!runId) {
      throw new RpcException({
        code: status.ABORTED,
        message: 'Переиндексация этого проекта уже выполняется',
      });
    }
    try {
      return await this.reindexLocked(projectId, runId, entityTypes);
    } finally {
      await this.releaseReindexLock(projectId, runId);
    }
  }

  private async reindexLocked(projectId: string, runId: string, entityTypes?: string[]) {
    const now = Date.now();
    const index = this.mongo.searchIndex();
    const wantTypes = entityTypes && entityTypes.length ? new Set(entityTypes) : null;
    // 0 (default) = no cap: the cursor keeps memory bounded, so a budget is only
    // an ops safety valve, never a silent data-loss default.
    const maxDocs = Math.max(0, Number(process.env.SEARCH_REINDEX_MAX_DOCS ?? 0) || 0);
    const batchSize = Math.max(1, Number(process.env.SEARCH_REINDEX_BATCH ?? 500) || 500);

    let indexed = 0;
    const sources: string[] = [];
    const skipped: string[] = [];

    for (const source of this.reindexSources()) {
      if (wantTypes && !wantTypes.has(source.type)) continue;
      sources.push(source.collection);
      const res = await this.reindexSource(index, source, projectId, now, batchSize, maxDocs, runId);
      indexed += res.count;
      if (res.truncated) {
        skipped.push(source.type);
        continue;
      }
      // A pass that outlived its lock TTL is no longer authoritative: another
      // rebuild may already own the project, so sweeping here would tombstone
      // ITS fresh documents. Renew (and thereby verify) ownership first; losing
      // it downgrades the type to "not swept" instead of destroying data.
      if (!(await this.renewReindexLock(projectId, runId))) {
        skipped.push(source.type);
        this.logger.warn(
          `reindex ${runId} lost the lock on project ${projectId} — skipping the ${source.type} sweep`,
        );
        continue;
      }
      // Complete pass → anything of this type still marked live in the index but
      // absent from the source (hard- or soft-deleted) must stop being findable.
      // Only types that were fully rebuilt are swept, so a type this run did not
      // read (partial reindex / truncation) is never touched. The marker is this
      // run's id, not `updatedAt < now`: a wall-clock comparison cannot tell "the
      // pass did not touch it" from "another writer touched it with a different
      // clock", which is exactly how the sweep could eat live records.
      await index.updateMany(
        {
          projectId,
          entityType: source.type,
          deletedAt: null,
          lastReindexRunId: { $ne: runId },
        },
        { $set: { deletedAt: now, updatedAt: now } },
      );
    }

    return {
      indexed_count: indexed,
      sources,
      truncated: skipped.length > 0,
      skipped_types: skipped,
    };
  }

  /**
   * TODO-491: single-flight lock over a project's rebuild, kept in
   * `search_index_state` (the collection the backfill bookkeeping already uses —
   * no new store, and it survives a restart unlike an in-process mutex, which
   * would not help at all with more than one search replica).
   *
   * A stale lock (holder crashed) expires after `SEARCH_REINDEX_LOCK_TTL_MS`.
   * Returns the run id on success, `null` when another rebuild holds it.
   */
  private static lockTtlMs(): number {
    return Math.max(1000, Number(process.env.SEARCH_REINDEX_LOCK_TTL_MS ?? 15 * 60_000) || 15 * 60_000);
  }

  private async acquireReindexLock(projectId: string): Promise<string | null> {
    const state = this.mongo.searchIndexState();
    const now = Date.now();
    const runId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // Ensure the state row exists so the conditional take below is a pure
    // single-document CAS (an upsert with the $or guard would race on insert).
    // `uq_state_project` (ensureIndexes) keeps that row unique, so when two
    // callers upsert a missing row at once the loser gets E11000 instead of
    // silently creating a second row (which would give both of them a CAS of
    // their own and let two rebuilds run). Losing the insert only means the row
    // now exists — fall through to the CAS below, which picks the single winner.
    try {
      await state.updateOne({ projectId }, { $setOnInsert: { projectId } }, { upsert: true });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    const res = await state.updateOne(
      {
        projectId,
        $or: [
          { reindexLockAt: null },
          { reindexLockAt: { $lt: now - SearchService.lockTtlMs() } },
        ],
      },
      { $set: { reindexLockAt: now, reindexRunId: runId } },
    );
    return res.matchedCount === 1 ? runId : null;
  }

  /** Heartbeat + ownership check in one atomic write (false = lock lost). */
  private async renewReindexLock(projectId: string, runId: string): Promise<boolean> {
    const res = await this.mongo
      .searchIndexState()
      .updateOne({ projectId, reindexRunId: runId }, { $set: { reindexLockAt: Date.now() } });
    return res.matchedCount === 1;
  }

  /** Release only OUR lock — a run that lost it must not free the new holder's. */
  private async releaseReindexLock(projectId: string, runId: string): Promise<void> {
    await this.mongo
      .searchIndexState()
      .updateOne({ projectId, reindexRunId: runId }, { $set: { reindexLockAt: null } });
  }

  /** Stream one source collection into the index in bounded batches. */
  private async reindexSource(
    index: Collection,
    source: ReindexSource,
    projectId: string,
    now: number,
    batchSize: number,
    maxDocs: number,
    runId: string,
  ): Promise<{ count: number; truncated: boolean }> {
    // TODO-257: never index a soft-deleted source row. Domains store the marker
    // as Date (contact/company/activity) or number (pipe/orders), and orders
    // additionally treats a legacy `0` as "live" (orders.service.ts: `deletedAt:
    // { $in: [null, 0] }`). `$in:[null, undefined, 0]` therefore covers "absent",
    // "explicitly null" and that legacy zero, while excluding every real
    // tombstone (a Date or a non-zero epoch) regardless of its type.
    const filter = { projectId, deletedAt: { $in: [null, undefined, 0] } };
    const cursor = source.coll().find(filter);
    let batch: SearchIndexWrite[] = [];
    let count = 0;
    let truncated = false;
    try {
      for await (const row of cursor) {
        if (maxDocs > 0 && count >= maxDocs) {
          truncated = true;
          break;
        }
        // TODO-491: stamp the run so the sweep can recognise "this pass wrote it"
        // without relying on a wall clock shared with the delta consumer.
        batch.push({
          ...source.map(row as Record<string, unknown>, projectId, now),
          lastReindexRunId: runId,
        });
        count += 1;
        if (batch.length >= batchSize) {
          await this.flushIndexBatch(index, batch);
          batch = [];
        }
      }
      if (batch.length > 0) await this.flushIndexBatch(index, batch);
    } finally {
      await cursor.close();
    }
    return { count, truncated };
  }

  /**
   * Idempotent bulk upsert by the unique {projectId,entityType,entityId} — no
   * delete+insert churn that regenerated _id and duplicated on races
   * (contract §3.3 [SEC-BLOCKER] mitigation 3). version monotonic via $max.
   *
   * T-018 fix: `version` MUST stay out of `$set` — it is owned by `$max`. Having
   * it in BOTH operators makes Mongo reject the whole bulkWrite ("Updating the
   * path 'version' would create a conflict at 'version'"), so reindex wrote
   * NOTHING and the index stayed empty.
   */
  private async flushIndexBatch(index: Collection, docs: SearchIndexWrite[]): Promise<void> {
    if (docs.length === 0) return;
    await index.bulkWrite(
      docs.map((d) => {
        const { version, ...rest } = d;
        return {
          updateOne: {
            filter: { projectId: d.projectId, entityType: d.entityType, entityId: d.entityId },
            update: {
              // The row exists in the source and is not soft-deleted → it is
              // live: clearing a stale tombstone here is correct (a record that
              // is gone from the source is tombstoned by the sweep instead).
              $set: { ...rest, deletedAt: null },
              $max: { version },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }

  private makeDoc(
    projectId: string,
    entityType: string,
    entityId: string,
    title: string,
    subtitle: string,
    path: string,
    tokens: string,
    ownerId: string | null,
    departmentId: string | null,
    now: number,
    abacFields: Record<string, unknown> = {},
    sourceFields: Record<string, unknown> = {},
  ): SearchIndexWrite {
    return {
      projectId,
      entityType,
      entityId,
      title,
      subtitle,
      path,
      tokens,
      ownerId,
      departmentId,
      ownerField: 'ownerId',
      // Debug copy of the materialized attributes; the predicate matches the
      // FLAT fields spread below (TODO-483).
      abacAttrs: abacFields,
      // TODO-264: the projection inputs a later PARTIAL event merges its diff
      // over — without them the first `*.updated` after a rebuild would rebuild
      // a composite title from the diff alone and drop the untouched half.
      sourceFields,
      sourceUpdatedAt: now,
      deletedAt: null,
      version: now,
      updatedAt: now,
      ...abacFields,
    };
  }

  async search(
    projectId: string,
    rawQuery: string,
    pageIndex: number,
    pageSize: number,
    opts: {
      entityTypes?: string[];
      perTypeLimit?: number;
      groupBy?: string;
      ctx?: SearchAccessContext;
      /** TODO-262: UI scope preset — narrowing only (see buildBaseFilter). */
      ownerScope?: OwnerScopePreset;
      /** Viewer's departments, resolved by the gateway; only used for `dept`. */
      scopeDepartmentIds?: string[];
      /** TODO-492: gateway-resolved project setting; floor 2 when absent. */
      minQueryChars?: number;
    } = {},
  ) {
    this.assertProjectId(projectId);
    const ctx = opts.ctx ?? {};

    if (pageSize && !ALLOWED_PAGE_SIZES.includes(pageSize)) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: `Недопустимый pageSize: ${pageSize}` });
    }
    const groupBy = (opts.groupBy ?? '').trim();
    if (groupBy && groupBy !== 'ownerId' && groupBy !== 'departmentId') {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: `Недопустимый groupBy: ${groupBy}` });
    }

    // Guard against regex-bomb: hard-cap query length before building RegExp.
    const q = (rawQuery ?? '').trim().slice(0, MAX_QUERY_LEN).toLowerCase();
    const perTypeLimit = Math.max(1, Math.min(opts.perTypeLimit || DEFAULT_PER_TYPE_LIMIT, 100));
    // TODO-261: pageIndex now reaches the DB ($skip), so a negative/NaN value
    // must be clamped here — Mongo rejects a negative $skip with an error.
    const page = Number.isFinite(pageIndex) ? Math.max(0, Math.trunc(pageIndex)) : 0;
    const types = this.effectiveTypes(ctx, opts.entityTypes);

    const minQueryChars = Math.max(
      1,
      Math.min(
        Number.isFinite(opts.minQueryChars) ? Math.trunc(opts.minQueryChars!) : DEFAULT_MIN_QUERY_CHARS,
        32,
      ),
    );
    // minQueryChars: below threshold → empty without scanning the index.
    if (q.length < minQueryChars || types.length === 0) {
      return {
        list: [],
        total: 0,
        groups: [],
        total_by_type: {},
        has_more: false,
        ...(groupBy ? { total_by_owner: {} } : {}),
      };
    }

    // Self-heal (T-018): the event delta projection only captures facts emitted
    // AFTER its durable queue was bound. Records created before that (demo seed /
    // pre-existing data) never produced a delivered event, so their project's
    // index stays empty and search "ничего не находит". On the FIRST real query
    // against an empty project we run a one-shot reindex from the source
    // collections (idempotent, version-guarded), marked in search_index_state so
    // it never repeats. New writes keep flowing through the delta consumer.
    await this.backfillIfEmpty(projectId);

    const index = this.mongo.searchIndex();
    const base = this.buildBaseFilter(projectId, ctx, types, {
      ownerScope: opts.ownerScope,
      departmentIds: opts.scopeDepartmentIds,
    });
    // TODO-490 (open, owner decision): substring matching is an un-anchored
    // case-insensitive RegExp, which no B-tree index can serve — the scan is
    // bounded by the project + type + deletedAt prefix (ix_project_type_deleted_
    // updated, ensureIndexes) but still walks that project's documents. Making it
    // index-backed without losing today's substring recall needs an ngram token
    // field plus a backfill migration of every existing document; a Mongo $text
    // index is NOT a drop-in (word matching would silently lose prefix hits).
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matchFilter: Record<string, unknown> = {
      $and: [base, { $or: [{ title: rx }, { subtitle: rx }, { tokens: rx }] }],
    };

    // Counts via Mongo aggregation AFTER the predicate (never in-memory length —
    // avoids leaking existence of invisible records, contract §3.1 [SEC-BLOCKER]).
    const byTypeAgg = (await index
      .aggregate([{ $match: matchFilter }, { $group: { _id: '$entityType', n: { $sum: 1 } } }])
      .toArray()) as Array<{ _id: string; n: number }>;
    const total_by_type: Record<string, number> = {};
    let total = 0;
    for (const g of byTypeAgg) {
      total_by_type[g._id] = g.n;
      total += g.n;
    }

    // Per-type groups: page `page` of that type's matches, `perTypeLimit` per
    // page (TODO-261). `perTypeLimit` IS the per-type page size — the results
    // screen sends its pageSize there, the overlay sends the settings value with
    // page 0, so the overlay behaviour is unchanged (skip = 0).
    //
    // The slice is cut in the DB from a globally ordered (score, updatedAt, _id)
    // sequence, so pages are disjoint and jointly cover every visible match; the
    // previous "4× newest candidates, score in memory, take the head" window had
    // no honest continuation and made page 2 repeat page 1.
    const skip = page * perTypeLimit;
    const groups: Array<{ entity_type: string; list: ReturnType<SearchService['buildHit']>[]; type_total: number }> = [];
    for (const type of types) {
      const typeTotal = total_by_type[type] ?? 0;
      // This type ran out before the requested page — no empty section for it.
      if (typeTotal <= skip) continue;
      const rows = (await index
        .aggregate([
          { $match: { $and: [matchFilter, { entityType: type }] } },
          { $addFields: { _score: this.scoreExpr(q) } },
          // _id is the tiebreaker that makes the order total, i.e. stable across
          // page requests (without it equal (score, updatedAt) rows could swap
          // between pages and a hit would be shown twice or never).
          { $sort: { _score: -1, updatedAt: -1, _id: -1 } },
          { $skip: skip },
          { $limit: perTypeLimit },
        ])
        .toArray()) as Array<SearchIndexDoc & { _score?: number }>;
      if (rows.length === 0) continue;
      groups.push({
        entity_type: type,
        type_total: typeTotal,
        list: rows.map((row) => this.buildHit(row, Number(row._score ?? 0))),
      });
    }

    // TODO-261: whether a NEXT page exists is a backend fact (it depends on
    // per-type totals and on the per-type page size the gateway resolved from the
    // project settings, neither of which the client can derive). The FE used to
    // guess it as `(page+1)*pageSize < total`, which kept "Вперёд" enabled almost
    // always; it now renders this flag.
    const has_more = types.some((type) => (total_by_type[type] ?? 0) > skip + perTypeLimit);

    let total_by_owner: Record<string, number> | undefined;
    if (groupBy) {
      const field = groupBy === 'departmentId' ? '$departmentId' : '$ownerId';
      const ownerAgg = (await index
        .aggregate([{ $match: matchFilter }, { $group: { _id: field, n: { $sum: 1 } } }])
        .toArray()) as Array<{ _id: string | null; n: number }>;
      total_by_owner = {};
      for (const g of ownerAgg) {
        if (g._id == null) continue;
        total_by_owner[g._id] = g.n;
      }
    }

    // Legacy flat list (BFF backward compat): the groups above are ALREADY the
    // requested page, so this only flattens and caps them — re-slicing by
    // pageIndex here would paginate the same request twice and hand out an empty
    // list from page 1 on.
    const limit = Math.max(1, Math.min(pageSize || 25, 100));
    const list = groups
      .flatMap((g) => g.list)
      .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
      .slice(0, limit);

    return {
      list,
      total,
      groups,
      total_by_type,
      has_more,
      ...(total_by_owner ? { total_by_owner } : {}),
    };
  }

  /**
   * One-shot lazy backfill (T-018) for a project whose index is empty. The event
   * delta projection only indexes facts emitted AFTER its durable queue was bound;
   * anything created before (demo seed / historical data) is missing. When a real
   * query hits a project with ZERO indexed docs we rebuild it once from the source
   * collections (the existing idempotent, version-guarded {@link reindex}) and
   * stamp `backfilledAt` in `search_index_state` so it never runs again — future
   * writes are covered by the delta consumer. Best-effort: a reindex failure must
   * never fail the search response (the query proceeds against whatever exists).
   *
   * Disabled with `SEARCH_LAZY_BACKFILL=false`. Skipped for already-populated
   * projects (a single indexed doc means the delta path is live) and for projects
   * already stamped — so the source-collection scan runs at most once per project.
   *
   * TODO-491: a project that CANNOT complete (truncated by
   * `SEARCH_REINDEX_MAX_DOCS`, or a failing rebuild) is never stamped, so without
   * a brake every keystroke of every viewer — search is debounced per keypress and
   * `search:read` is the lowest role — would launch a full six-collection scan of
   * the shared Mongo. The catch-up attempt is therefore rate-limited per project
   * (`SEARCH_BACKFILL_RETRY_MS`, default 15 min) and serialized by the reindex
   * lock; the window is armed BEFORE the rebuild so a crash cannot hot-loop either.
   */
  private async backfillIfEmpty(projectId: string): Promise<void> {
    if (process.env.SEARCH_LAZY_BACKFILL === 'false') return;
    try {
      const state = (await this.mongo.searchIndexState().findOne({ projectId })) as {
        backfilledAt?: number;
        backfillTruncatedAt?: number;
        backfillNextAttemptAt?: number;
      } | null;
      if (state?.backfilledAt) return; // already completed → never repeat.

      const now = Date.now();
      // A catch-up pass is already scheduled for later — do not scan on this read.
      if (state?.backfillNextAttemptAt && state.backfillNextAttemptAt > now) return;

      // TODO-256: a previous attempt was cut off by SEARCH_REINDEX_MAX_DOCS, so
      // the index is non-empty but INCOMPLETE. The "index has rows → stamp and
      // skip" shortcut below would freeze exactly that half-built state forever,
      // so a pending truncation goes straight to another rebuild attempt.
      if (!state?.backfillTruncatedAt) {
        const already = await this.mongo
          .searchIndex()
          .countDocuments({ projectId }, { limit: 1 });
        if (already > 0) {
          // Index is live (delta consumer or a prior backfill) — just stamp so we
          // skip the count on every subsequent query for this project.
          await this.mongo
            .searchIndexState()
            .updateOne({ projectId }, { $set: { backfilledAt: Date.now() } }, { upsert: true });
          return;
        }
      }

      // Arm the retry window before touching the sources: whatever happens next
      // (truncation, throw, process kill), the next reader waits instead of
      // starting another full scan.
      const retryMs = Math.max(
        0,
        Number(process.env.SEARCH_BACKFILL_RETRY_MS ?? 15 * 60_000) || 0,
      );
      await this.mongo
        .searchIndexState()
        .updateOne(
          { projectId },
          { $set: { backfillNextAttemptAt: now + retryMs } },
          { upsert: true },
        );

      // Rebuild from source, then stamp only on SUCCESS: a transient reindex
      // failure must not permanently disable backfill for this project (a
      // pre-claim stamp would). A rebuild started by a second simultaneous first
      // query is rejected by the per-project lock with ABORTED (TODO-491) and
      // handled by the catch below — it no longer races this one's sweep.
      //
      // TODO-256: a TRUNCATED pass (a source cut off by SEARCH_REINDEX_MAX_DOCS)
      // is not a rebuild — stamping it would freeze the project half-indexed
      // forever, since the stamp is what prevents any further backfill.
      const res = await this.reindex(projectId);
      if (res.truncated) {
        this.logger.warn(
          `lazy backfill for project ${projectId} was truncated (types: ${res.skipped_types.join(', ')}); ` +
            'not stamping backfilledAt so a later run can complete it',
        );
        await this.mongo
          .searchIndexState()
          .updateOne(
            { projectId },
            { $set: { backfillTruncatedAt: Date.now() } },
            { upsert: true },
          );
        return;
      }
      await this.mongo
        .searchIndexState()
        .updateOne(
          { projectId },
          {
            $set: {
              backfilledAt: Date.now(),
              backfillTruncatedAt: null,
              backfillNextAttemptAt: null,
            },
          },
          { upsert: true },
        );
    } catch (e) {
      // Never let a backfill hiccup break the read; the query returns what exists.
      this.logger.warn(`lazy backfill for project ${projectId} failed: ${String(e)}`);
    }
  }

  /** Index freshness for admins (FR-MSRCH-29). last_event_processed_at/lag are 0
   * until the delta consumer is wired (E3-02) — Status reports this honestly. */
  async status(projectId: string) {
    this.assertProjectId(projectId);
    const indexedCount = await this.mongo.searchIndex().countDocuments({ projectId, deletedAt: null });
    const state = (await this.mongo
      .searchIndexState()
      .findOne({ projectId })) as { lastEventProcessedAt?: number; deadLetterCount?: number } | null;
    const last = state?.lastEventProcessedAt ?? 0;
    const lag = last > 0 ? Math.max(0, Date.now() - last) : 0;
    return {
      last_event_processed_at: last,
      lag_ms: lag,
      indexed_count: indexedCount,
      freshness_sla_ms: Number(process.env.SEARCH_FRESHNESS_SLA_MS ?? DEFAULT_FRESHNESS_SLA_MS),
      dead_letter_count: state?.deadLetterCount ?? 0,
    };
  }

  /** Internal service-only point upsert (contract §3.5). owner/department/abac
   * required (no orphans). Out-of-order safe: applied only if version > stored. */
  async indexUpsert(d: {
    projectId: string;
    entityType: string;
    entityId: string;
    title?: string;
    subtitle?: string;
    path?: string;
    tokens?: string;
    ownerId?: string;
    departmentId?: string;
    ownerField?: string;
    abacAttrs?: Record<string, unknown>;
    sourceUpdatedAt?: number;
    version?: number;
  }) {
    this.assertProjectId(d.projectId);
    if (!d.entityType || !d.entityId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'entity_type and entity_id are required' });
    }
    if (!d.ownerId || !d.departmentId) {
      // No orphans: a record without owner/department is either invisible or
      // (on fail-open) a leak — reject (contract §3.5 [SEC]).
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'owner_id and department_id are required (no orphan index records)' });
    }
    const now = Date.now();
    const version = d.version && d.version > 0 ? d.version : now;
    await this.mongo.searchIndex().updateOne(
      { projectId: d.projectId, entityType: d.entityType, entityId: d.entityId, version: { $lt: version } },
      {
        $set: {
          projectId: d.projectId,
          entityType: d.entityType,
          entityId: d.entityId,
          title: d.title ?? '',
          subtitle: d.subtitle ?? '',
          path: d.path ?? `/p/${d.projectId}/${d.entityType}s/${d.entityId}`,
          tokens: d.tokens ?? '',
          ownerId: d.ownerId,
          departmentId: d.departmentId,
          ownerField: d.ownerField ?? 'ownerId',
          abacAttrs: d.abacAttrs ?? {},
          // [review-1] …and FLAT, like the other two write paths. The operator
          // recovery RPC used to store the attributes only nested under
          // `abacAttrs`, which the compiled predicate (flat `record.<field>` refs)
          // can never match — a third spelling of the same materialization drift
          // TODO-483 closed for reindex and the event delta.
          ...pickAbacFields(d.entityType, d.abacAttrs ?? {}),
          sourceUpdatedAt: d.sourceUpdatedAt ?? now,
          deletedAt: null,
          version,
          updatedAt: now,
        },
      },
      { upsert: true },
    ).catch((e: unknown) => {
      // Duplicate-key on the version<incoming filter means a newer doc already
      // exists → drop silently (NFR-MSRCH-4 out-of-order), not an error.
      if ((e as { code?: number }).code === 11000) return;
      throw e;
    });
    return { ok: true };
  }

  private async recordOrphanProjection(
    projectId: string,
    entityType: string,
    entityId: string,
    message: string,
  ): Promise<void> {
    this.logger.warn(message);
    await this.mongo
      .searchIndexState()
      .updateOne(
        { projectId },
        { $inc: { orphanProjectionCount: 1 }, $set: { lastOrphanProjectionAt: Date.now() } },
        { upsert: true },
      )
      .catch((e: unknown) => {
        this.logger.warn(`failed to record orphan projection metric: ${String(e)}`);
      });
  }

  /**
   * Delta-projection partial upsert (E4-19, contract §5.2). Unlike
   * {@link indexUpsert} (full service-only replace), this MERGES only the fields
   * present in the event payload — a `crm.deal.stage_changed` carrying just a
   * stage must not blank the deal's title/owner. Version-guarded: applied only
   * when `version > stored.version` (NFR-MSRCH-4 out-of-order drop). On insert
   * it backfills `path`/`ownerField` defaults so the read-time PEP has a row.
   * `projectId` is the trusted scope from the event envelope (contract §1).
   */
  async projectUpsert(d: {
    projectId: string;
    entityType: string;
    entityId: string;
    title?: string;
    subtitle?: string;
    tokens?: string;
    ownerId?: string;
    departmentId?: string;
    abacAttrs?: Record<string, unknown>;
    /** Flat materialized ABAC attributes (TODO-483) — matched by the predicate. */
    abacFields?: Record<string, unknown>;
    /** Whitelisted projection inputs kept for the NEXT partial diff (TODO-264). */
    sourceFields?: Record<string, unknown>;
    sourceUpdatedAt: number;
    version: number;
  }): Promise<void> {
    const now = Date.now();
    const set: Record<string, unknown> = {
      version: d.version,
      sourceUpdatedAt: d.sourceUpdatedAt,
      updatedAt: now,
      deletedAt: null, // re-create after delete clears the tombstone (when version wins).
    };
    if (d.title !== undefined) set.title = d.title;
    if (d.subtitle !== undefined) set.subtitle = d.subtitle;
    if (d.tokens !== undefined) set.tokens = d.tokens;
    if (d.ownerId !== undefined) set.ownerId = d.ownerId;
    if (d.departmentId !== undefined) set.departmentId = d.departmentId;
    if (d.abacAttrs !== undefined) set.abacAttrs = d.abacAttrs;
    // TODO-264: already merged with the stored inputs by the projection mapper,
    // so a plain $set is the complete new state (a cleared field arrives as null).
    if (d.sourceFields !== undefined) set.sourceFields = d.sourceFields;
    // TODO-483: the compiled ABAC predicate matches FLAT top-level fields
    // (`record.<attr>` → `{ <attr>: ... }`), so the materialized attributes are
    // written as real document fields, not only inside `abacAttrs`.
    for (const [field, value] of Object.entries(d.abacFields ?? {})) {
      set[field] = value;
    }

    // TODO-263: symmetric to indexUpsert for NEW records — an insert with
    // ownerId:null is invisible to every scope but mode='all' (index garbage).
    // Partial follow-up events may omit owner (merge over an existing doc).
    // Products are project-level and legitimately have no ownerId.
    if (
      d.ownerId === undefined &&
      !SearchService.OWNER_OPTIONAL_ENTITY_TYPES.has(d.entityType)
    ) {
      const existing = await this.mongo.searchIndex().findOne(
        { projectId: d.projectId, entityType: d.entityType, entityId: d.entityId },
        { projection: { _id: 1 } },
      );
      if (!existing) {
        await this.recordOrphanProjection(
          d.projectId,
          d.entityType,
          d.entityId,
          `orphan search projection: ${d.entityType}/${d.entityId} (project ${d.projectId}) ` +
            'rejected insert without ownerId — fix the producer payload',
        );
        return;
      }
    }

    await this.mongo
      .searchIndex()
      .updateOne(
        {
          projectId: d.projectId,
          entityType: d.entityType,
          entityId: d.entityId,
          $or: [{ version: { $lt: d.version } }, { version: { $exists: false } }],
        },
        {
          $set: set,
          $setOnInsert: {
            projectId: d.projectId,
            entityType: d.entityType,
            entityId: d.entityId,
            path: `/p/${d.projectId}/${d.entityType}s/${d.entityId}`,
            ownerField: 'ownerId',
            ...(d.title === undefined ? { title: '' } : {}),
            ...(d.subtitle === undefined ? { subtitle: '' } : {}),
            ...(d.tokens === undefined ? { tokens: '' } : {}),
            ...(d.departmentId === undefined ? { departmentId: null } : {}),
            ...(d.abacAttrs === undefined ? { abacAttrs: {} } : {}),
            ...(d.sourceFields === undefined ? { sourceFields: {} } : {}),
          },
        },
        { upsert: true },
      )
      .catch((e: unknown) => {
        // Duplicate-key on the version-guarded upsert means a newer doc already
        // exists → drop (out-of-order, NFR-MSRCH-4), not an error.
        if ((e as { code?: number }).code === 11000) return undefined;
        throw e;
      });
  }

  /**
   * Internal service-only tombstone (contract §3.6) — also the live delete path
   * of the event delta projection (SearchDeltaWriterImpl.tombstone).
   *
   * TODO-485: written with `upsert: true`, so a `deleted` event delivered BEFORE
   * the matching `created` (bus re-ordering) leaves a tombstone row instead of
   * matching nothing; the later, older create then loses the version guard and
   * the record stays deleted. Version-guard and 11000 suppression mirror
   * {@link projectUpsert}.
   */
  /**
   * TODO-264: projection inputs last written for an indexed record, so the delta
   * projection can merge a PARTIAL event (`changes[]`/`changedFields[]`) over the
   * known state instead of rebuilding a composite title from the diff alone.
   *
   * Returns `null` when the record has NO index document (the caller must not
   * invent one), and `{}` when the document predates this field.
   */
  async indexSourceFields(
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!projectId || !entityType || !entityId) return null;
    // Runs on EVERY projected event (the merge is no longer diff-only), so the
    // read is kept to the covered `sourceFields` field on the unique index key.
    const doc = (await this.mongo
      .searchIndex()
      .findOne(
        { projectId, entityType, entityId },
        { projection: { sourceFields: 1, _id: 0 } },
      )) as { sourceFields?: unknown } | null;
    if (!doc) return null;
    const fields = doc.sourceFields;
    return fields && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : {};
  }

  async indexDelete(d: { projectId: string; entityType: string; entityId: string; version?: number }) {
    this.assertProjectId(d.projectId);
    if (!d.entityType || !d.entityId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'entity_type and entity_id are required' });
    }
    const now = Date.now();
    const version = d.version && d.version > 0 ? d.version : now;
    await this.mongo
      .searchIndex()
      .updateOne(
        {
          projectId: d.projectId,
          entityType: d.entityType,
          entityId: d.entityId,
          $or: [{ version: { $lt: version } }, { version: { $exists: false } }],
        },
        {
          $set: { deletedAt: now, version, updatedAt: now },
          $setOnInsert: {
            projectId: d.projectId,
            entityType: d.entityType,
            entityId: d.entityId,
            path: `/p/${d.projectId}/${d.entityType}s/${d.entityId}`,
            ownerField: 'ownerId',
            title: '',
            subtitle: '',
            tokens: '',
            ownerId: null,
            departmentId: null,
            abacAttrs: {},
          },
        },
        { upsert: true },
      )
      .catch((e: unknown) => {
        // A newer doc already exists (unique key) → the tombstone is stale, drop it.
        if ((e as { code?: number }).code === 11000) return;
        throw e;
      });
    return { ok: true };
  }

  /**
   * Terminal erase of one index row (FR-COMPANIES-040 / 152-ФЗ «удалить
   * навсегда»). Driven by `crm.<entity>.purged`, whose source record was
   * PHYSICALLY deleted — unlike {@link indexDelete}, which only sets `deletedAt`
   * and deliberately keeps title/subtitle/tokens so a `.restored` can bring the
   * record back. After a purge there is nothing to restore, so every
   * denormalized field derived from the source record (name, ИНН, e-mail, owner,
   * abac attributes) must leave the store.
   *
   * Why the key row survives as a scrubbed marker instead of `deleteOne`:
   * the projection consumer prefetches 20 messages (rabbitmq.service.ts:126) and
   * handles them concurrently, and any nack re-delivers, so a `.created` /
   * `.updated` for the same entity can still be in flight when the purge lands.
   * `projectUpsert` runs with `upsert: true`, so against a physically absent row
   * that straggler would silently RE-INSERT the very PII this operation exists to
   * destroy — permanently, since no further event will ever arrive for a purged
   * record. Keeping a PII-free row `{projectId, entityType, entityId, deletedAt,
   * purgedAt, version}` makes the unique index `uq_project_type_entity` the
   * guard: the version-guarded update matches nothing (`$max` never lets the
   * stored version drop below the purge) and the fallback insert dies on 11000,
   * which `projectUpsert` already treats as an out-of-order drop. The marker is
   * invisible to every read — `buildBaseFilter` requires `deletedAt: null`.
   */
  async indexPurge(d: { projectId: string; entityType: string; entityId: string; version?: number }) {
    this.assertProjectId(d.projectId);
    if (!d.entityType || !d.entityId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'entity_type and entity_id are required' });
    }
    const now = Date.now();
    const version = d.version && d.version > 0 ? d.version : now;
    const key = { projectId: d.projectId, entityType: d.entityType, entityId: d.entityId };
    const update = {
      $set: {
        title: '',
        subtitle: '',
        tokens: '',
        ownerId: null,
        departmentId: null,
        abacAttrs: {},
        deletedAt: now,
        purgedAt: now,
        updatedAt: now,
      },
      $unset: { sourceFields: '', abacFields: '' },
      $max: { version },
    };
    try {
      await this.mongo.searchIndex().updateOne(key, update, { upsert: true });
    } catch (e: unknown) {
      if ((e as { code?: number }).code !== 11000) throw e;
      await this.mongo.searchIndex().updateOne(key, update);
    }
    return { ok: true };
  }

  /**
   * FR-ORG-530: records with no owner in the project search index (`ownerId` null
   * or empty). Project admins use this as the «Без владельца» virtual view.
   */
  async listUnassigned(
    projectId: string,
    resource: string,
    limit = 50,
    cursor?: string,
  ): Promise<{
    list: Array<{ entityType: string; entityId: string; title: string; updatedAt: string }>;
    nextCursor: string;
    total: number;
  }> {
    this.assertProjectId(projectId);
    const types = resolveUnassignedResourceTypes(resource);
    const ownerMissing = { $in: [null, ''] };
    const base: Record<string, unknown> = {
      projectId,
      deletedAt: null,
      ownerId: ownerMissing,
      entityType: types.length === 1 ? types[0] : { $in: types },
    };
    const total = await this.mongo.searchIndex().countDocuments(base);
    const parsed = parseUnassignedCursor(cursor);
    const filter =
      parsed == null
        ? base
        : {
            ...base,
            $or: [
              { updatedAt: { $lt: parsed.updatedAt } },
              { updatedAt: parsed.updatedAt, entityId: { $lt: parsed.entityId } },
            ],
          };
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.mongo
      .searchIndex()
      .find(filter)
      .sort({ updatedAt: -1, entityId: -1 })
      .limit(take + 1)
      .project({ entityType: 1, entityId: 1, title: 1, updatedAt: 1 })
      .toArray();
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    const tail = hasMore ? slice[slice.length - 1] : null;
    return {
      list: slice.map((r) => ({
        entityType: String(r.entityType ?? ''),
        entityId: String(r.entityId ?? ''),
        title: String(r.title ?? ''),
        updatedAt: r.updatedAt != null ? new Date(r.updatedAt as number).toISOString() : '',
      })),
      nextCursor:
        tail != null
          ? `${new Date(tail.updatedAt as number).toISOString()}|${String(tail.entityId)}`
          : '',
      total,
    };
  }
}

function resolveUnassignedResourceTypes(resource: string): string[] {
  const r = (resource ?? 'all').trim().toLowerCase();
  const map: Record<string, string[]> = {
    contact: ['contact'],
    contacts: ['contact'],
    deal: ['deal'],
    deals: ['deal'],
    order: ['order'],
    orders: ['order'],
    company: ['company'],
    companies: ['company'],
    activity: ['activity'],
    activities: ['activity'],
    document: ['document'],
    documents: ['document'],
    all: ['contact', 'deal', 'order', 'company', 'activity', 'document'],
  };
  return map[r] ?? map.all;
}

function parseUnassignedCursor(
  cursor?: string,
): { updatedAt: number; entityId: string } | null {
  const raw = (cursor ?? '').trim();
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const updatedAt = new Date(raw.slice(0, sep)).getTime();
  const entityId = raw.slice(sep + 1);
  if (!Number.isFinite(updatedAt) || !entityId) return null;
  return { updatedAt, entityId };
}
