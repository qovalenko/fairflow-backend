import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  projectRoleCanKey,
  projectRoleAtLeast,
  serializeVisibilityScope,
  ensureLockedModules,
  resolveDependencies,
  SHAREABLE_RESOURCES as SHAREABLE_RESOURCE_LIST,
  SHAREABLE_RESOURCE_ENTITY_TYPES,
  CROSS_ENTITY_SUBJECT_ENTITY_TYPES,
  VISIBILITY_SCOPE_MAX_IDS,
  type ShareableResource,
  type VisibilityScope,
  type VisibilityScopeDescriptor,
  type VisibilityLevel,
  type VisibilityRuleKind,
  type AbacEvalContext,
} from '@fairflow/shared';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { decodeGrpcModulePolicies } from '../bff/project-grpc.codec';
import { REQUIRED_PERMISSION_KEY, type RequiredPermission } from './require-permission.decorator';
import { REQUIRED_SYSTEM_ROLE_KEY } from './require-system-role.decorator';
import { MEMBERSHIP_ONLY_KEY } from './membership-only.decorator';
import { REQUIRED_DONOR_SUBJECTS_KEY } from './require-donor-subjects.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';
import {
  compileAccessPredicateResult,
  compileCrossEntityAccessPredicate,
  hasAbacCondition,
  hasConditionalDenyForAction,
  type AbacPolicyRule,
  type CompileAccessPredicateResult,
} from './access-predicate';
import {
  compileAggregateAccessPredicate,
  isAggregateRouteSubject,
} from './access-predicate.aggregate';

/** BOX edition omits cloud billing; default edition is box on integration/box-gap. */
function isBoxEdition(): boolean {
  const edition = (process.env.FAIRFLOW_EDITION ?? 'box').trim().toLowerCase();
  return edition !== 'cloud';
}

/**
 * Lifecycle write routes exempt from the FR-PROJ-120 read-only phase guard.
 * Anchored to /projects/:id/<transition> — record-level routes that happen to
 * share the suffix (POST /v1/deals/:id/restore etc.) must stay blocked on an
 * archived project.
 */
const PROJECT_LIFECYCLE_ROUTE_RE = /\/projects\/[^/]+\/(restore|unarchive|request-deletion)$/;

type ResolveVisibilityResult = {
  allowed?: boolean;
  role?: string;
  level?: string;
  mode?: string;
  owner_ids?: string[];
  ownerIds?: string[];
  shared_record_ids?: string[];
  sharedRecordIds?: string[];
  viewer_department_ids?: string[];
  viewerDepartmentIds?: string[];
  department_ids?: string[];
  departmentIds?: string[];
  // K3-invalidation (Д-4): access epoch this decision was resolved at.
  epoch?: number | string;
  // [#19] Oversized-scope deferral: control leaves the flat lists empty and returns
  // a compact descriptor for the domain to resolve server-side.
  deferred?: boolean;
  descriptor?: WireScopeDescriptor;
  viewer_unit_ids?: string[];
  viewerUnitIds?: string[];
};

/** Wire shape of VisibilityScopeDescriptor (control response; snake_case, keepCase-tolerant). */
type WireScopeDescriptor = {
  unit_ids?: string[];
  unitIds?: string[];
  led_unit_ids?: string[];
  ledUnitIds?: string[];
  selected_group_ids?: string[];
  selectedGroupIds?: string[];
  rule_kinds?: string[];
  ruleKinds?: string[];
  uses_sharing?: boolean;
  usesSharing?: boolean;
  org_id?: string;
  orgId?: string;
};

/** CRM resources that support per-record sharing (scope is resolved per-resource).
 * The list itself is the shared contract (= control's RecordShare.resource values);
 * the local Set keeps the membership-test shape every call site already uses. */
const SHAREABLE_RESOURCES = new Set<string>(SHAREABLE_RESOURCE_LIST);

/**
 * Subjects whose route is NOT itself a data subject but returns rows of MANY data
 * subjects in one call (global search). Both record-level PEP layers have to be
 * fanned out for them, because both are resolved per data subject:
 *
 *  - [TODO-109] sharing — a per-resource scope is meaningless here, so the guard
 *    resolves the shares of every shareable resource and stamps them per entity
 *    type (`VisibilityScope.sharedRecordIdsByType`). Without it a record shared
 *    with the viewer is findable on its own list route but never in global search.
 *  - [review-1] ABAC + blanket DENY — rules are written for `deals`/`contacts`/…,
 *    so compiling them against the route subject (`search`) matched nothing and
 *    the whole ABAC layer was bypassed by the search box. See
 *    `compileCrossEntityAccessPredicate`.
 */
const CROSS_ENTITY_SUBJECTS = new Set(['search']);

/**
 * Actions for which the fan-outs above are relevant: only a call that RETURNS
 * records can be widened by a share or has rows to narrow. Ops actions on the same
 * subject (`search:manage` — status, reindex) return no records, so they keep the
 * single primary resolution / single-subject predicate.
 */
const RECORD_RETURNING_ACTIONS = new Set(['read', 'export']);

/**
 * [review-1] `[data-subject, entityType]` pairs a cross-entity route's predicate is
 * compiled over, derived from the shared PEP↔index contract so the gateway can
 * never omit a type the search index actually stores (an omitted type would match
 * no disjunct and silently disappear from results).
 */
const CROSS_ENTITY_SUBJECT_TYPE_PAIRS: ReadonlyArray<readonly [string, string]> = Object.entries(
  CROSS_ENTITY_SUBJECT_ENTITY_TYPES,
).map(([subject, entityType]) => [subject, entityType] as const);

/**
 * TODO-089. Subject'ы, у которых `export` — АНАЛИТИЧЕСКАЯ выгрузка (сводка по
 * всему проекту), а не выгрузка рабочих записей. Каталог прав таких пар
 * member/viewer не выдаёт (`ELEVATED_EXPORT_SUBJECTS` в
 * shared/src/permission-rbac.ts → `isElevatedForLowRole`), поэтому и PEP обязан
 * их закрывать: иначе `allowed[]` (фронт) и гейт (gateway) расходятся.
 *
 * Список зеркалит shared намеренно: `isElevatedForLowRole` не входит в публичный
 * API @fairflow/shared, а тянуть ради двух строк новый экспорт в общий пакет —
 * правка чужого слоя. При добавлении subject'а в ELEVATED_EXPORT_SUBJECTS его
 * нужно добавить и сюда (пара закреплена тестом
 * project-access.elevated-export.spec.ts и shared/src/permission-statistics-export.spec.ts).
 */
const ELEVATED_ANALYTIC_EXPORT_SUBJECTS = new Set(['reports', 'statistics']);

/**
 * `true` для пар, которые низкие роли (member/viewer) не получают из каталога.
 * Ограничено `export`: `manage`/`delete`/`import` низкие роли не держат уже по
 * плоской матрице (PROJECT_ROLE_ACTIONS), так что расширять проверку нечем —
 * это был бы мёртвый код.
 */
function isElevatedAnalyticExport(subject: string, action: string): boolean {
  return action === 'export' && ELEVATED_ANALYTIC_EXPORT_SUBJECTS.has(subject);
}

/** Minimal view of a stored module-policy rule (wire shape; single-word fields). */
type ModulePolicyRule = {
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  /** ABAC predicate tree (AbacNode JSON) — present on conditional rules only. */
  condition?: Record<string, unknown>;
};

type ProjectAccessClient = {
  resolveRecordVisibility: (x: unknown, m?: unknown) => Observable<ResolveVisibilityResult>;
  getProjectAccessEpoch: (
    x: { project_id: string },
    m?: unknown,
  ) => Observable<{ epoch?: number | string }>;
  getProject: (
    x: { id: string },
    m?: unknown,
  ) => Observable<{
    module_policies?: unknown[];
    effective_modules?: string[];
    modules?: string[];
    status?: string;
    module_configs?: Array<{ module_id?: string; enabled?: boolean }>;
  }>;
};

/**
 * TODO-027 (PEP↔PDP) — wire shape of `control.RoleGrpc.CheckPermissions`.
 * keepCase is on for this channel, so fields arrive snake_case; the camelCase
 * neighbours are tolerated defensively (the loader options are the project's
 * classic rake: keepCase/longs).
 */
type PdpDecisionWire = {
  subject?: string;
  action?: string;
  decision?: string;
  reason?: string;
  not_applicable?: boolean;
  notApplicable?: boolean;
};

type PermissionDecisionClient = {
  checkPermissions: (
    x: {
      project_id: string;
      user_id: string;
      checks: Array<{ subject: string; action: string }>;
    },
    m?: unknown,
  ) => Observable<{ decisions?: PdpDecisionWire[]; role?: string; epoch?: number | string }>;
  resolveEffectivePermissions: (
    x: { project_id: string; user_id: string },
    m?: unknown,
  ) => Observable<{ allow?: string[]; epoch?: number | string }>;
};

/**
 * A granular verdict for one (subject, action) pair.
 *
 *  - `applicable=false` — the project's catalog has no key for this pair, so the
 *    granular engine has no opinion and the flat-matrix verdict stands. This is
 *    NOT a failure path: it is only ever produced by an explicit, successful
 *    control response (see `not_applicable` in control.proto).
 *  - otherwise `allowed` is authoritative and a `false` produces a 403.
 */
type PermissionVerdict = { applicable: boolean; allowed: boolean; reason: string };

/**
 * Per-donor access bundle for composite (card) routes — see
 * `@RequireDonorSubjects`. `null` means "this caller may not read that donor"
 * (not a member, RBAC denies, project policy denies, or the resolution failed):
 * the composite MUST render that block empty instead of reusing its own scope.
 */
export type DonorAccess = {
  /** Serialized VisibilityScope resolved for THE DONOR subject. */
  scope: string;
  /** Serialized ABAC predicate compiled for THE DONOR subject (may be absent). */
  predicate?: string;
};

/** Request augmented by this guard so downstream metadata carries the real role + scope. */
export type ProjectScopedRequest = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, unknown>;
  user?: { userId?: string };
  /**
   * The projectId this guard actually authorized on (membership, role, scope,
   * ABAC predicate). Controllers MUST read this instead of re-deriving the id
   * from query/header on their own: any divergence between the guard's order
   * (params → query → header) and a controller's order authorizes project A
   * while reading project B (cross-project leak). Set as soon as the id is
   * resolved, before any early return.
   */
  __projectId?: string;
  __projectRole?: string;
  /** Serialized VisibilityScope for x-visibility-scope (phase 4d). */
  __visibilityScope?: string;
  /** Serialized CompiledPredicate for x-access-predicate (RFC-5, ABAC push-down). */
  __accessPredicate?: string;
  /** Per-donor-subject scope/predicate for composite routes (@RequireDonorSubjects). */
  __donorAccess?: Record<string, DonorAccess | null>;
  /** Comma-separated effective allow keys for x-permissions (FR-PERM-8). */
  __effectivePermissions?: string;
};

type AccessResolution = {
  allowed: boolean;
  role: string;
  scope: string;
  /** [TODO-109] The same scope BEFORE serialization — cross-resource routes rebuild
   * a widened scope from it without a parse round-trip. Never mutated (cached). */
  visibility?: VisibilityScope;
};
/**
 * K3-invalidation (Д-4): each cached access decision is stamped with the project
 * access `epoch` it was resolved at. A cached entry is only served when it is both
 * within its TTL AND its epoch still matches the project's current epoch — so any
 * access-affecting mutation (role/member/policy/visibility/share/grant) in control
 * bumps the epoch and instantly invalidates every stale decision (~0 lag).
 */
const ACCESS_CACHE = new Map<
  string,
  { value: AccessResolution; epoch: number; expiresAt: number }
>();
const POLICY_CACHE = new Map<
  string,
  { rules: ModulePolicyRule[]; enabledModules: string[]; epoch: number; expiresAt: number }
>();
/**
 * error-report (fail-closed policies): last-known-good project-wide policy/module
 * overlay. Never used while control is reachable; consulted ONLY when getProject
 * fails. TTL + project access epoch gate stale replay (TODO-304 / FR-ACCESS-270).
 */
const POLICY_LKG = new Map<
  string,
  { rules: ModulePolicyRule[]; enabledModules: string[]; epoch: number; expiresAt: number }
>();
/**
 * Short-lived cache of the per-project current epoch. One cheap control round-trip
 * (PK lookup) is shared across all users/resources of a project, so the epoch check
 * does not add a round-trip per request. The epoch-cache TTL bounds the worst-case
 * revocation lag (default 2s; set GATEWAY_EPOCH_CACHE_TTL_MS=0 for ~0 lag at the
 * cost of one control call per request).
 */
const EPOCH_CACHE = new Map<string, { epoch: number; expiresAt: number }>();
/**
 * TODO-027: granular PDP verdicts, keyed `${projectId}:${userId}:${subject}:${action}`
 * and gated by the SAME access epoch as every other layer here (K3-invalidation,
 * Д-4) — an admin editing a role / adding a deny-grant bumps the epoch in control
 * and every cached verdict of that project is stale on the next request. No new
 * invalidation mechanism was introduced.
 *
 * Cost: a typical request adds ZERO round-trips on a hit and exactly ONE on a
 * miss (one batched CheckPermissions for the route's required pairs). Misses are
 * per (project,user,pair,epoch), so they amortise across every request of a
 * session, not per request.
 */
const PDP_CACHE = new Map<
  string,
  { verdict: PermissionVerdict; epoch: number; expiresAt: number }
>();
/** Effective allow-set for x-permissions, keyed `${projectId}:${userId}`. */
const EFFECTIVE_PERMS_CACHE = new Map<
  string,
  { allow: string; epoch: number; expiresAt: number }
>();

/**
 * Route subjects whose serving domain applies `x-access-predicate` on list/get AND
 * on mutating RPCs that gate through the same record read (TODO-112). Extend in
 * lock-step as domains gain predicate support.
 *
 * KNOWN GAP: create RPCs have no existing record to read, so a conditional deny
 * is NOT evaluated against the create payload anywhere (needs_owner — requires a
 * `create` action in the decorator taxonomy or payload-side predicate evaluation).
 */
const PREDICATE_READ_ENFORCING_SUBJECTS = new Set([
  'contacts',
  'companies',
  'deals',
  'products',
  'documents',
]);
const PREDICATE_DOMAIN_WRITE_ACTIONS = new Set(['write', 'delete', 'move']);

function isAccessPredicateEnforcedInDomain(subject: string, action: string): boolean {
  if (!PREDICATE_READ_ENFORCING_SUBJECTS.has(subject)) return false;
  if (action === 'read') return true;
  return PREDICATE_DOMAIN_WRITE_ACTIONS.has(action);
}

/** Effective-enabled module ids from a control GetProject payload (R4-E1-07). */
function extractEffectiveModules(project: {
  effective_modules?: string[];
  modules?: string[];
  module_configs?: Array<{ module_id?: string; enabled?: boolean }>;
}): string[] {
  const eff = project?.effective_modules;
  if (Array.isArray(eff) && eff.length > 0) {
    // Fmig-modulegate: re-ensure locked/system modules so a partial payload can
    // never drop one (e.g. `deals`) from the set propagated to domains.
    return ensureLockedModules(eff.filter((m): m is string => typeof m === 'string'));
  }
  const cfgs = project?.module_configs;
  if (Array.isArray(cfgs) && cfgs.length > 0) {
    const ids = cfgs
      .filter(
        (c): c is { module_id: string; enabled?: boolean } => typeof c?.module_id === 'string',
      )
      .filter((c) => c.enabled !== false)
      .map((c) => c.module_id);
    return resolveDependencies(ids);
  }
  const mods = Array.isArray(project?.modules)
    ? project.modules.filter((m): m is string => typeof m === 'string')
    : [];
  return resolveDependencies(mods);
}

/**
 * Д-4 (Stage-2): the access decision (membership/role/visibility scope) is the
 * revocation-critical cache. The Stage-0 mitigation (Д-6) merely capped the TTL so
 * a revoked user/role survived "only" a few seconds. K3-invalidation replaces that
 * with EVENT-DRIVEN invalidation: every cached decision is stamped with the project
 * access epoch; control bumps that epoch on any access-affecting mutation; the
 * gateway re-resolves the moment the epoch diverges. The TTL below is now just a
 * safety upper bound (the epoch handles correctness), so it can stay relatively
 * relaxed without reintroducing stale-access risk.
 *
 * Tunables (ms, >= 0; 0 disables the respective cache → re-resolve every request):
 *   GATEWAY_ACCESS_CACHE_TTL_MS  (default 30000) — per-(project,user,resource) decision.
 *   GATEWAY_POLICY_CACHE_TTL_MS  (default 30000) — project-wide policy/module overlay.
 *   GATEWAY_EPOCH_CACHE_TTL_MS   (default 2000)  — current-epoch read; bounds worst-case lag.
 */
function readTtlMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function accessCacheTtlMs(): number {
  return readTtlMs('GATEWAY_ACCESS_CACHE_TTL_MS', 30_000);
}
function policyCacheTtlMs(): number {
  return readTtlMs('GATEWAY_POLICY_CACHE_TTL_MS', 30_000);
}
function epochCacheTtlMs(): number {
  return readTtlMs('GATEWAY_EPOCH_CACHE_TTL_MS', 2_000);
}
/** TODO-027: TTL of a granular PDP verdict (epoch still gates correctness). */
function pdpCacheTtlMs(): number {
  return readTtlMs('GATEWAY_PDP_CACHE_TTL_MS', 30_000);
}
/**
 * TODO-027: hard deadline for the PDP call. A control that hangs must NOT hang
 * the request and must NOT be able to soften the decision — the timeout raises,
 * and the catch turns it into a denial.
 */
function pdpTimeoutMs(): number {
  return readTtlMs('GATEWAY_PDP_TIMEOUT_MS', 2_000) || 2_000;
}
/** Upper bound on distinct keys per in-memory project-access cache (TODO-305). */
function projectAccessCacheMax(): number {
  return readTtlMs('GATEWAY_PROJECT_ACCESS_CACHE_MAX', 5_000);
}
function policyLkgTtlMs(): number {
  return readTtlMs('GATEWAY_POLICY_LKG_TTL_MS', 300_000);
}

function touchMapEntry<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function evictMapToMaxSize(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function setBoundedCacheEntry<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  touchMapEntry(map, key, value);
  evictMapToMaxSize(map as Map<string, unknown>, max);
}

function storePolicyLkg(
  projectId: string,
  rules: ModulePolicyRule[],
  enabledModules: string[],
  epoch: number,
): void {
  const ttl = policyLkgTtlMs();
  if (ttl <= 0) return;
  setBoundedCacheEntry(
    POLICY_LKG,
    projectId,
    { rules, enabledModules, epoch, expiresAt: Date.now() + ttl },
    projectAccessCacheMax(),
  );
}

/**
 * Enforces that the authenticated user is a member of the target project, and
 * resolves their project role into `req.__projectRole` (so outbound metadata
 * carries the real role instead of a hardcoded 'USER'). When a route is
 * annotated with @RequirePermission, also checks the role against the RBAC
 * matrix. Routes without a projectId pass through untouched.
 *
 * Kill-switch: GATEWAY_PROJECT_ACCESS_ENFORCE=false disables membership denial
 * (role is still resolved + propagated). Default: enforced.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate, OnModuleInit {
  private client?: ProjectAccessClient;
  private pdpClient?: PermissionDecisionClient;
  private readonly logger = new Logger(ProjectAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject('CONTROL_GRPC') private readonly control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit(): void {
    if (!isBoxEdition()) return;
    const enforce = process.env.GATEWAY_PROJECT_ACCESS_ENFORCE?.trim();
    if (enforce === 'false') {
      throw new Error(
        'GATEWAY_PROJECT_ACCESS_ENFORCE=false is forbidden in BOX edition (FR-PROJ-065)',
      );
    }
    if (enforce !== 'true') {
      throw new Error(
        'GATEWAY_PROJECT_ACCESS_ENFORCE must be "true" in BOX edition deploy config (NFR-560)',
      );
    }
  }

  private get enforce(): boolean {
    return process.env.GATEWAY_PROJECT_ACCESS_ENFORCE !== 'false';
  }

  /** TODO-307: structured warn when the non-box kill-switch bypasses enforcement. */
  private warnEnforcementBypass(projectId: string, reason: string): void {
    if (this.enforce) return;
    this.logger.warn(`GATEWAY_PROJECT_ACCESS_ENFORCE=false: ${reason} (projectId=${projectId})`);
  }

  /** Lazily resolve the gRPC service (robust whether or not lifecycle hooks fire). */
  private getClient(): ProjectAccessClient {
    if (!this.client) {
      this.client = this.control.getService<ProjectAccessClient>('ProjectGrpc');
    }
    return this.client;
  }

  /** TODO-027: control's PDP surface (`RoleGrpc`), same channel/metadata. */
  private getPdpClient(): PermissionDecisionClient {
    if (!this.pdpClient) {
      this.pdpClient = this.control.getService<PermissionDecisionClient>('RoleGrpc');
    }
    return this.pdpClient;
  }

  /**
   * Current project access epoch (K3, Д-4). One cheap control PK lookup per project,
   * cached briefly so it does not add a round-trip per request. On failure returns a
   * unique sentinel so cached decisions are treated as stale (fail-closed: never
   * serve a possibly-revoked decision when we can't confirm freshness).
   */
  private async currentEpoch(request: ProjectScopedRequest, projectId: string): Promise<number> {
    const ttl = epochCacheTtlMs();
    if (ttl > 0) {
      const cached = EPOCH_CACHE.get(projectId);
      if (cached && cached.expiresAt > Date.now()) return cached.epoch;
    }
    try {
      const md = this.outboundMeta.build(request as never, { projectId });
      const res = await firstValueFrom(
        this.getClient().getProjectAccessEpoch({ project_id: projectId }, md),
      );
      const epoch = Number(res?.epoch ?? 0) || 0;
      if (ttl > 0)
        setBoundedCacheEntry(
          EPOCH_CACHE,
          projectId,
          { epoch, expiresAt: Date.now() + ttl },
          projectAccessCacheMax(),
        );
      return epoch;
    } catch {
      // Can't confirm freshness → force re-resolve (negative sentinel never matches
      // a stored epoch, which are >= 0). Do not cache the sentinel.
      return -1;
    }
  }

  private parseScope(
    res: ResolveVisibilityResult,
    selfId: string,
    resource: string,
    epoch: number,
  ): VisibilityScope {
    const mode = res.mode === 'all' ? 'all' : 'restricted';
    const scope: VisibilityScope = {
      mode,
      level: (res.level || 'only_own') as VisibilityLevel,
      selfId,
      ownerIds: res.owner_ids ?? res.ownerIds ?? [],
      sharedRecordIds: res.shared_record_ids ?? res.sharedRecordIds ?? [],
      viewerDepartmentIds: res.viewer_department_ids ?? res.viewerDepartmentIds ?? [],
      departmentIds: res.department_ids ?? res.departmentIds ?? [],
      // [#19] Stamp the resource + resolved epoch so a domain's deferred-scope
      // hydrator can key its cache by (projectId,userId,resource,epoch) and re-ask
      // control with the SAME resource (matches the inline path for shares). Useful
      // for diagnostics on non-deferred scopes too; only load-bearing when deferred.
      resource,
      epoch,
    };
    // [#19] Preserve the oversized-scope deferral path. Control returns
    // deferred=true + a compact descriptor when the expanded lists would blow the
    // metadata budget; carry both through so the whole scope (serialized as one
    // base64(JSON) x-visibility-scope) reaches the domain, which resolves the flat
    // lists server-side. Dropping them here would collapse every large-org scope to
    // an empty `restricted` (deny-all) and orphan the descriptor mechanism.
    // Isolation is not weakened: a deferred scope WITHOUT a usable descriptor stays
    // fail-closed (deny-all) in buildVisibilityFilter, exactly as designed.
    if (res.deferred === true) {
      scope.deferred = true;
      const descriptor = this.parseDescriptor(res.descriptor);
      if (descriptor) scope.descriptor = descriptor;
    }
    const viewerUnits = res.viewer_unit_ids ?? res.viewerUnitIds;
    if (Array.isArray(viewerUnits) && viewerUnits.length) {
      (scope as VisibilityScope & { viewerUnitIds?: string[] }).viewerUnitIds = viewerUnits.filter(
        (x): x is string => typeof x === 'string',
      );
    }
    return scope;
  }

  /** Normalise the wire descriptor (keepCase-tolerant) into VisibilityScopeDescriptor. */
  private parseDescriptor(
    wire: WireScopeDescriptor | undefined,
  ): VisibilityScopeDescriptor | undefined {
    if (!wire || typeof wire !== 'object') return undefined;
    return {
      unitIds: wire.unit_ids ?? wire.unitIds ?? [],
      ledUnitIds: wire.led_unit_ids ?? wire.ledUnitIds ?? [],
      selectedGroupIds: wire.selected_group_ids ?? wire.selectedGroupIds ?? [],
      ruleKinds: (wire.rule_kinds ?? wire.ruleKinds ?? []) as VisibilityRuleKind[],
      usesSharing: (wire.uses_sharing ?? wire.usesSharing) === true,
      orgId: wire.org_id ?? wire.orgId ?? '',
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectScopedRequest>();

    // T-001-BE: routes marked @SkipProjectScope have no current-project context
    // (e.g. create-a-new-project). The client still sends the ambient x-project-id
    // header for whatever project is open in the UI, which may be stale or someone
    // else's — using it here would resolve membership in that unrelated project and
    // wrongly 403. So for marked routes we NEVER take the projectId from the header;
    // an explicit path/query param (if any) still wins, keeping scoped routes intact.
    const skipHeaderScope = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_PROJECT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const headerProjectId = skipHeaderScope
      ? undefined
      : (request.headers?.['x-project-id'] as string | undefined);
    const projectId =
      request.params?.projectId ?? request.query?.projectId ?? headerProjectId ?? '';

    // Publish the authorized id for the handlers (see __projectId): everything
    // below — membership, role, VisibilityScope, module policy, ABAC predicate —
    // is resolved for exactly this id, so the domain call must use it too.
    if (projectId) request.__projectId = projectId;

    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    const membershipOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      MEMBERSHIP_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredSystemRole = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_SYSTEM_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!projectId) {
      // TODO-018 / FR-PROJ-030 (fail-closed): a project-scoped route with no
      // projectId anywhere (path/query/header) must not pass through silently.
      // @SkipProjectScope routes keep the pass-through (no current-project context).
      const needsProjectScope =
        !skipHeaderScope && (required || membershipOnly || requiredSystemRole);
      if (needsProjectScope) {
        throw new BadRequestException({
          code: 'PROJECT_ID_REQUIRED',
          message: 'projectId is required for this route (query param or x-project-id header)',
        });
      }
      // No project context — nothing to enforce here (org/list/create routes).
      return true;
    }

    const userId = request.user?.userId;
    if (!userId) {
      // Authenticated routes always have a user (global JWT guard). If somehow
      // absent with a projectId, deny when enforcing.
      if (this.enforce) {
        throw new ForbiddenException({
          code: 'PROJECT_ACCESS_DENIED',
          message: 'Authentication required for project-scoped access',
        });
      }
      this.warnEnforcementBypass(projectId, 'project-scoped route without userId');
      return true;
    }

    // The route's subject (when shareable) drives per-resource share resolution.
    const subject = required?.subject ?? '';
    const resource = SHAREABLE_RESOURCES.has(subject) ? subject : '';

    // K3-invalidation (Д-4): resolve the project's current access epoch once and use
    // it to validate every cached layer (decision + policy) below.
    const epoch = await this.currentEpoch(request, projectId);

    const access = await this.resolveAccess(request, projectId, userId, resource, epoch);
    const { allowed, role } = access;
    request.__projectRole = role;
    // [TODO-109] Cross-resource routes (search) get the per-entity-type share map
    // folded in; every other route keeps the single-resource scope byte-for-byte.
    request.__visibilityScope = await this.withCrossResourceShares(
      request,
      projectId,
      userId,
      epoch,
      subject,
      required?.action ?? '',
      access,
    );
    request.__effectivePermissions = await this.resolveEffectivePermissions(
      request,
      projectId,
      userId,
      epoch,
    );

    if (this.enforce && !allowed) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'You are not a member of this project',
      });
    }
    if (!this.enforce && !allowed) {
      this.warnEnforcementBypass(projectId, 'non-member would be denied');
    }

    // TODO-056: every project-scoped route must declare its gate explicitly.
    if (this.enforce && !required && !membershipOnly && !requiredSystemRole && !skipHeaderScope) {
      throw new ForbiddenException({
        code: 'ROUTE_PERMISSION_MARKER_REQUIRED',
        message:
          'This project-scoped route lacks @RequirePermission, @RequireSystemRole, or @MembershipOnly',
      });
    }

    // FR-PROJ-120: read-only phase check runs AFTER membership so a non-member
    // can never distinguish an archived foreign project (PROJECT_READ_ONLY) from
    // a plain access denial.
    await this.enforceProjectWritablePhase(request, projectId);

    // Subject-aware RBAC: flat role×action matrix + the granular per-role key
    // allow-list (member + `documents.generate:execute`, owner decision
    // 2026-08-16). The allow-list only ever ADDS specific `subject:action`
    // pairs — every deny below (module-policy overlay, ABAC) still applies.
    if (required && !projectRoleCanKey(role, required.subject, required.action)) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        subject: required.subject,
        action: required.action,
        message: `Role "${role || 'none'}" cannot ${required.action} ${required.subject}`,
      });
    }

    // TODO-089 (PEP ↔ каталог прав): плоская матрица выше знает только
    // роль×действие, поэтому member проходил на `statistics:export` /
    // `reports:export` — `export` есть в его action-set (rbac.ts
    // PROJECT_ROLE_ACTIONS). Каталог (PDP, `expandSystemRolePermissions`) этих
    // ключей member/viewer НЕ выдаёт: аналитический экспорт — элевированная пара
    // (permission-rbac.ts `isElevatedForLowRole` / ELEVATED_EXPORT_SUBJECTS).
    // Расхождение было видно пользователю: кнопка «Экспорт» по `allowed[]`
    // выключена, а прямой GET /api/v1/statistics/export отдавал файл. Здесь PEP
    // догоняется до PDP на том же наборе subject'ов. Проверка ДО decideGranular:
    // для этих пар PDP часто отвечает not_applicable, и тогда остаётся вердикт
    // плоской матрицы — member ошибочно проходил.
    if (required && isElevatedAnalyticExport(required.subject, required.action)) {
      if (!projectRoleAtLeast(role, 'manager')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          subject: required.subject,
          action: required.action,
          message: `Role "${role || 'none'}" cannot ${required.action} ${required.subject}`,
        });
      }
    }

    // TODO-027 (PEP↔PDP): the flat matrix above is only the cheap PRE-FILTER —
    // it can deny without a network call, but it must not be the last word,
    // because it knows neither the route's subject-level catalog key, nor custom
    // roles, nor department/unit role assignments, nor addressed
    // PermissionGrant{effect:'deny'}. The authoritative verdict comes from
    // control's `decideRbac` (the SAME engine the access simulator runs), so what
    // an admin configures on the permissions screen is what the live 403 does.
    //
    // Composition is a strict AND — this layer can only ever NARROW the matrix,
    // never widen it — and deny wins over allow at every level: inside the
    // effective set (compileEffectivePermissions subtracts deny grants), inside
    // decideRbac (a denied key short-circuits before the allow check), and here.
    if (required) {
      const verdict = await this.decideGranular(request, projectId, userId, required, epoch);
      if (verdict.applicable && !verdict.allowed) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          subject: required.subject,
          action: required.action,
          reason: verdict.reason,
          message: `Permission "${required.subject}:${required.action}" is denied for this user in this project`,
        });
      }
    }

    // Resolve the project's effective-enabled module set on EVERY project-scoped
    // route (not only @RequireModule ones) so `x-enabled-modules` is always
    // propagated to domains — the soft-disable enforcement layer (R4-E1-07) needs
    // the effective set present even on routes the GatewayModuleGuard skips.
    // Best-effort: never break a request on a control overlay outage.
    const rules = await this.resolvePolicies(request, projectId, epoch);

    // FR-ACCESS-220: create-RPC cannot evaluate conditional deny against a record
    // that does not exist yet — fail-closed as an unconditional deny. Existing-
    // record POSTs (restore/close/archive/…) keep domain predicate evaluation.
    // Owner is exempt (FR-ACCESS-485 / deny-grant on owner is impossible).
    const httpMethod = String((request as { method?: string }).method ?? '').toUpperCase();
    const routeParams = (request as { params?: Record<string, string> }).params ?? {};
    const isCollectionCreate =
      required?.action === 'write' &&
      httpMethod === 'POST' &&
      !routeParams.id &&
      !routeParams.groupId &&
      !routeParams.versionId &&
      !routeParams.ruleId &&
      !routeParams.roleId;
    if (
      role !== 'owner' &&
      isCollectionCreate &&
      required &&
      hasConditionalDenyForAction(rules, required.subject, 'write')
    ) {
      throw new ForbiddenException({
        code: 'MODULE_POLICY_DENIED',
        subject: required.subject,
        action: required.action,
        message: `Module policy conditional deny blocks create on ${required.subject}`,
      });
    }

    // [review-1] INVARIANT: once this guard has run WITH a project context,
    // `__enabledModules` is always defined — so `x-enabled-modules` is always on
    // the wire and a domain never has to guess. resolvePolicies is best-effort and
    // has failure branches that used to leave the field unset (control unreachable
    // and no last-known-good for this project); the header then disappeared and
    // /search/query — the one project route with no @RequireModule (T-018), whose
    // whole module gate is the domain-side entityType ∩ enabledModules
    // intersection — silently stopped filtering at the exact moment everything
    // else fails closed. The degraded value is the LOCKED/system module set, which
    // is the same fallback GatewayModuleGuard uses in this situation
    // (`ensureLockedModules([])`, gateway-module.guard.ts): locked modules are
    // enabled by definition for every project, optional ones stay fail-closed. A
    // bare `[]` would instead claim locked modules are off and re-break the routes
    // that fallback was introduced to keep alive.
    const reqRec = request as unknown as Record<string, unknown>;
    if (!Array.isArray(reqRec.__enabledModules)) {
      reqRec.__enabledModules = ensureLockedModules([]);
    }

    // Module-policy overlay (§4e): project-wide allow/deny rules on top of RBAC.
    if (required && this.isDeniedByPolicy(rules, required.subject, required.action, role)) {
      throw new ForbiddenException({
        code: 'MODULE_POLICY_DENIED',
        subject: required.subject,
        action: required.action,
        message: `Module policy denies ${required.action} on ${required.subject} for this project`,
      });
    }

    // ABAC push-down (RFC-5, FR-ABAC-6): compile the project's conditional module
    // policies into `x-access-predicate` for the domain to AND into its read filter.
    // Only when the route carries a data-subject (@RequirePermission subject); the
    // predicate is per-request/per-domain (one BFF call → one domain). Never throws:
    // an uncompilable conditional deny is fail-closed (403); uncompilable allows are
    // skipped without widening.
    //
    // [review-1] A cross-entity route (global search) carries no data-subject of its
    // own — its subject is `search`, while the rows it returns belong to
    // deals/contacts/… . Compiling against `search` matched no rule, so the whole
    // ABAC layer AND every blanket module DENY was bypassed by the search box. Such
    // routes get the per-data-subject predicate instead.
    const action = required?.action ?? 'read';
    if (CROSS_ENTITY_SUBJECTS.has(subject) && RECORD_RETURNING_ACTIONS.has(action)) {
      request.__accessPredicate = this.resolveCrossEntityAccessPredicate(
        rules,
        action,
        projectId,
        userId,
        role,
      );
    } else {
      const compiled = this.resolveAccessPredicate(rules, subject, action, projectId, userId, role);
      if (compiled.failClosed) {
        throw new ForbiddenException({
          code: 'MODULE_POLICY_DENIED',
          subject: required?.subject,
          action: required?.action,
          message:
            'Module policy contains a conditional deny that cannot be enforced on the gateway',
        });
      }
      if (compiled.denyCompiled && !isAccessPredicateEnforcedInDomain(subject, action)) {
        throw new ForbiddenException({
          code: 'MODULE_POLICY_DENIED',
          subject: required?.subject,
          action: required?.action,
          message:
            'Module policy contains a conditional deny that the target domain does not enforce for this operation',
        });
      }
      request.__accessPredicate = compiled.predicate;
    }

    // Composite (card) routes read donor modules whose subject differs from the
    // route's own. Resolve each donor subject INDEPENDENTLY so the composite can
    // build one outbound metadata per donor instead of forwarding the host
    // subject's scope to every domain (FR-COMPANIES-375: company card leaked
    // deals/contacts a user's own module scope would have hidden).
    const donorSubjects = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_DONOR_SUBJECTS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (Array.isArray(donorSubjects) && donorSubjects.length > 0) {
      request.__donorAccess = await this.resolveDonorAccess(
        request,
        projectId,
        userId,
        epoch,
        rules,
        donorSubjects,
      );
    }

    return true;
  }

  /**
   * TODO-027: ask control's PDP for the granular verdict of the route's required
   * (subject, action) pairs.
   *
   * FAIL-CLOSED BY CONSTRUCTION. Every way this can go wrong is a denial:
   *   - control unreachable / RPC error / UNIMPLEMENTED  → catch → deny;
   *   - control hangs                                    → timeout → catch → deny;
   *   - empty response, missing `decisions`, no entry for
   *     the pair, unknown/empty `decision` string        → deny (only the exact
   *     string 'allow' allows);
   * The ONLY path that leaves the flat-matrix verdict in charge is an explicit
   * `not_applicable=true` from a successful response, which means the pair has no
   * key in this project's catalog — nothing granular can be configured for it, so
   * there is nothing to enforce (and 403-ing it would take down live routes whose
   * decorator has no catalog key yet). There is deliberately NO env kill-switch
   * and NO fallback to the old behaviour on failure: that fallback is exactly the
   * hole this closes.
   */
  private async decideGranular(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    required: RequiredPermission,
    epoch: number,
  ): Promise<PermissionVerdict> {
    const { subject, action } = required;
    const cacheKey = `${projectId}:${userId}:${subject}:${action}`;
    const ttl = pdpCacheTtlMs();
    if (ttl > 0) {
      const cached = PDP_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && cached.epoch === epoch) {
        return cached.verdict;
      }
    }

    let res: { decisions?: PdpDecisionWire[]; epoch?: number | string } | undefined;
    try {
      const md = this.outboundMeta.build(request as never, { projectId });
      res = await firstValueFrom(
        this.getPdpClient()
          .checkPermissions(
            {
              project_id: projectId,
              user_id: userId,
              // Batched by contract: the guard has exactly one @RequirePermission
              // pair per route today, so a batch of one — but N pairs would still
              // be ONE round-trip and ONE effective-set resolve in control.
              checks: [{ subject, action }],
            },
            md,
          )
          .pipe(timeout(pdpTimeoutMs())),
      );
    } catch {
      // Cannot obtain a decision → DENY. Never fall back to the flat matrix.
      throw new ForbiddenException({
        code: 'PERMISSION_CHECK_FAILED',
        subject,
        action,
        message: 'Could not verify permissions for this project',
      });
    }

    const verdict = this.parseVerdict(res?.decisions, subject, action);
    const resolvedEpoch = res?.epoch !== undefined ? Number(res.epoch) || 0 : epoch;
    // Never persist a verdict we cannot prove fresh (epoch read failed → -1).
    if (ttl > 0 && epoch >= 0 && resolvedEpoch >= 0) {
      setBoundedCacheEntry(
        PDP_CACHE,
        cacheKey,
        { verdict, epoch: resolvedEpoch, expiresAt: Date.now() + ttl },
        projectAccessCacheMax(),
      );
    }
    return verdict;
  }

  /** Pick the decision for (subject, action) out of a CheckPermissions response. */
  private parseVerdict(
    decisions: PdpDecisionWire[] | undefined,
    subject: string,
    action: string,
  ): PermissionVerdict {
    const list = Array.isArray(decisions) ? decisions : [];
    const match = list.find((d) => d?.subject === subject && d?.action === action);
    if (!match) {
      // A response that does not carry a verdict for what we asked is not a
      // permit — treat a short/garbled answer exactly like an outage.
      return { applicable: true, allowed: false, reason: 'PDP_NO_DECISION' };
    }
    const notApplicable = (match.not_applicable ?? match.notApplicable) === true;
    return {
      applicable: !notApplicable,
      allowed: match.decision === 'allow',
      reason: typeof match.reason === 'string' && match.reason ? match.reason : 'PDP_DENY',
    };
  }

  /**
   * Resolve `{visibility scope, ABAC predicate}` per donor subject for a composite
   * route. Each donor goes through the SAME gates as its own list route would:
   * membership, the RBAC key `subject:read`, the project-wide policy DENY overlay
   * and the per-resource visibility scope (shares are per-resource — that is
   * exactly why the host subject's scope is not reusable here).
   *
   * Fail-closed: anything that does not resolve to an explicit allow becomes
   * `null` (⇒ empty block in the composite). No caching is added — `resolveAccess`
   * / `resolvePolicies` are already epoch-gated, so repeat card loads hit their
   * caches and the donor fan-out costs at most one control round-trip per
   * (project,user,donor) per TTL/epoch window.
   */
  private async resolveDonorAccess(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    epoch: number,
    rules: ModulePolicyRule[],
    subjects: string[],
  ): Promise<Record<string, DonorAccess | null>> {
    const out: Record<string, DonorAccess | null> = {};
    // Donor subjects are module ids (deals/contacts/orders/activities): a donor
    // whose module is disabled in this project must contribute nothing, exactly
    // as its own list route would 403 on @RequireModule. `__enabledModules` is
    // guaranteed set by canActivate before the donor fan-out runs.
    const enabledModules = (request as unknown as Record<string, unknown>).__enabledModules;
    await Promise.all(
      [...new Set(subjects)].map(async (subject) => {
        try {
          if (Array.isArray(enabledModules) && !enabledModules.includes(subject)) {
            out[subject] = null;
            return;
          }
          const resource = SHAREABLE_RESOURCES.has(subject) ? subject : '';
          const { allowed, role, scope } = await this.resolveAccess(
            request,
            projectId,
            userId,
            resource,
            epoch,
          );
          // `allowed` sits behind the same kill-switch as the route gate above;
          // RBAC and the policy overlay are NOT behind it (symmetry with canActivate).
          if (this.enforce && !allowed) {
            out[subject] = null;
            return;
          }
          if (
            !projectRoleCanKey(role, subject, 'read') ||
            this.isDeniedByPolicy(rules, subject, 'read', role)
          ) {
            out[subject] = null;
            return;
          }
          // TODO-027 symmetry: the flat matrix above is only the pre-filter. The
          // authoritative verdict for `<donor>:read` is control's PDP — otherwise
          // an addressed PermissionGrant{effect:'deny'} that 403s the donor's own
          // list route would still leak its rows into the composite card.
          // decideGranular throws on any PDP failure → caught below → null.
          const verdict = await this.decideGranular(
            request,
            projectId,
            userId,
            { subject, action: 'read' },
            epoch,
          );
          if (verdict.applicable && !verdict.allowed) {
            out[subject] = null;
            return;
          }
          const compiled = this.resolveAccessPredicate(
            rules,
            subject,
            'read',
            projectId,
            userId,
            role,
          );
          if (compiled.failClosed) {
            out[subject] = null;
            return;
          }
          // Same rule as the route gate: a compiled conditional DENY may only
          // travel to domains that enforce it on reads; for the rest (orders,
          // activities) dropping the block is the only fail-closed option.
          if (compiled.denyCompiled && !PREDICATE_READ_ENFORCING_SUBJECTS.has(subject)) {
            out[subject] = null;
            return;
          }
          out[subject] = {
            scope,
            predicate: compiled.predicate,
          };
        } catch {
          // Control outage / unexpected shape ⇒ no donor data (never the host scope).
          out[subject] = null;
        }
      }),
    );
    return out;
  }

  /**
   * Resolve the project's module-policy rules. Prefers the snapshot that
   * GatewayModuleGuard already attached when it ran first (crm-bff routes);
   * otherwise falls back to a cached getProject (v1-data routes, where this
   * guard runs before the module guard). Best-effort: empty on any failure.
   */
  private async resolvePolicies(
    request: ProjectScopedRequest,
    projectId: string,
    epoch: number,
  ): Promise<ModulePolicyRule[]> {
    const reqRec = request as Record<string, unknown>;
    const snapshot = reqRec.__policySnapshot;
    // GatewayModuleGuard ran first (crm-bff routes) — it already set both the
    // policy snapshot and __enabledModules, so reuse them as-is.
    if (typeof snapshot === 'string') {
      try {
        const parsed = JSON.parse(snapshot);
        if (Array.isArray(parsed)) {
          const rules = parsed as ModulePolicyRule[];
          // Keep last-known-good fresh from the module-guard snapshot too, so a
          // later control outage on this project replays the current DENY set.
          const existing = POLICY_LKG.get(projectId);
          // [review-1] Prefer the set GatewayModuleGuard just resolved for THIS
          // request: it is the freshest truth and it is right here. Storing a
          // bare `[]` poisoned the last-known-good, so a later control outage
          // replayed "no module enabled" for a project that has plenty — which,
          // now that an empty set travels as an explicit '[]', would blank out
          // search instead of merely degrading it.
          const known = Array.isArray(reqRec.__enabledModules)
            ? (reqRec.__enabledModules as string[])
            : undefined;
          storePolicyLkg(projectId, rules, known ?? existing?.enabledModules ?? [], epoch);
          return rules;
        }
        return [];
      } catch {
        return [];
      }
    }

    if (policyCacheTtlMs() > 0) {
      const cached = POLICY_CACHE.get(projectId);
      // K3 (Д-4): serve only if both within TTL AND the epoch still matches.
      if (cached && cached.expiresAt > Date.now() && cached.epoch === epoch) {
        // Always propagate the effective-enabled set, even on a cache hit.
        if (reqRec.__enabledModules === undefined) reqRec.__enabledModules = cached.enabledModules;
        return cached.rules;
      }
    }

    try {
      const md = this.outboundMeta.build(request as never, { projectId });
      const project = await firstValueFrom(this.getClient().getProject({ id: projectId }, md));
      const rules = Array.isArray(project?.module_policies)
        ? (decodeGrpcModulePolicies(project.module_policies) as ModulePolicyRule[])
        : [];
      const enabledModules = extractEffectiveModules(project ?? {});
      if (reqRec.__enabledModules === undefined) reqRec.__enabledModules = enabledModules;
      const ttl = policyCacheTtlMs();
      if (ttl > 0)
        setBoundedCacheEntry(
          POLICY_CACHE,
          projectId,
          { rules, enabledModules, epoch, expiresAt: Date.now() + ttl },
          projectAccessCacheMax(),
        );
      // Refresh last-known-good so a later outage can replay the current DENY set.
      storePolicyLkg(projectId, rules, enabledModules, epoch);
      return rules;
    } catch {
      // error-report (fail-closed policies): control is unreachable. RBAC is
      // already enforced, but project-wide DENY rules are safety controls we must
      // NOT drop on outage. Degrade fail-closed by replaying the last-known-good
      // DENY rules (ALLOW rules are no-ops for enforcement — see isDeniedByPolicy —
      // so replaying only DENY keeps the same effective decision without granting
      // anything). If we never saw this project's policies, fall back to [].
      //
      // Epoch gate (TODO-304): a KNOWN different epoch proves the snapshot stale —
      // never replay it. But `epoch < 0` is the "couldn't confirm freshness"
      // sentinel of a FULL control outage (getProjectAccessEpoch failed too) —
      // exactly the scenario the LKG exists for, so within the TTL window the
      // last DENY set still replays rather than silently failing open.
      const lkg = POLICY_LKG.get(projectId);
      if (lkg && lkg.expiresAt > Date.now() && (epoch < 0 || lkg.epoch === epoch)) {
        if (reqRec.__enabledModules === undefined) reqRec.__enabledModules = lkg.enabledModules;
        return lkg.rules.filter((r) => r.effect === 'deny');
      }
      return [];
    }
  }

  /**
   * A project-wide DENY rule blocks (subject, action) for everyone. ALLOW rules
   * mark the default-enabled state and never grant beyond RBAC — the rule shape
   * carries no role axis, so a blanket allow must not hand restricted roles new
   * capabilities. Hence: deny wins, allow is a no-op for enforcement.
   */
  private isDeniedByPolicy(
    rules: ModulePolicyRule[],
    subject: string,
    action: string,
    role?: string,
  ): boolean {
    // FR-ACCESS-485: project owner is never blocked by blanket module-policy deny
    // (mirrors PDP owner short-circuit — pdp.service.ts).
    if (role === 'owner') return false;
    return rules.some(
      (r) =>
        r.effect === 'deny' &&
        r.subject === subject &&
        (r.action === action || r.action === '*') &&
        (!r.resource || r.resource === '*') &&
        !hasAbacCondition(r),
    );
  }

  private async resolveEffectivePermissions(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    epoch: number,
  ): Promise<string> {
    const cacheKey = `${projectId}:${userId}`;
    const ttl = accessCacheTtlMs();
    if (ttl > 0) {
      const cached = EFFECTIVE_PERMS_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && cached.epoch === epoch) {
        return cached.allow;
      }
    }
    try {
      const md = this.outboundMeta.build(request as never, { projectId });
      const res = await firstValueFrom(
        this.getPdpClient()
          .resolveEffectivePermissions({ project_id: projectId, user_id: userId }, md)
          .pipe(timeout(pdpTimeoutMs())),
      );
      const allow = Array.isArray(res?.allow) ? res.allow.filter(Boolean).join(',') : '';
      const resolvedEpoch = res?.epoch !== undefined ? Number(res.epoch) || 0 : epoch;
      if (ttl > 0 && resolvedEpoch >= 0) {
        setBoundedCacheEntry(
          EFFECTIVE_PERMS_CACHE,
          cacheKey,
          { allow, epoch: resolvedEpoch, expiresAt: Date.now() + ttl },
          projectAccessCacheMax(),
        );
      }
      return allow;
    } catch {
      // Fail-closed for domain PEPs that read x-permissions (e.g. chat:moderate):
      // an empty header means "no elevated permissions".
      return '';
    }
  }

  /**
   * Compile the project's conditional module-policy rules into the serialized
   * `x-access-predicate` value for this (subject, action, user). Returns `undefined`
   * when nothing should be transmitted (no data-subject on the route, no applicable
   * rules, empty predicate, or any uncompilable/unresolvable rule → header omitted,
   * absent = no ABAC narrowing). NEVER throws and NEVER emits a malformed value.
   *
   * The inputs (`rules` via resolvePolicies, `role` via resolveAccess) are already
   * epoch-gated caches, so the predicate inherits the same K3 invalidation — no extra
   * cache/round-trip is introduced here (its ancestors carry the freshness contract).
   */
  private resolveAccessPredicate(
    rules: ModulePolicyRule[],
    subject: string,
    action: string,
    projectId: string,
    userId: string,
    role: string,
  ): CompileAccessPredicateResult {
    if (!subject || !userId) {
      return { predicate: undefined, failClosed: false, denyCompiled: false };
    }
    try {
      if (isAggregateRouteSubject(subject)) {
        const predicate = compileAggregateAccessPredicate({
          rules: rules as AbacPolicyRule[],
          subject,
          action,
          ctx: this.abacContext(projectId, userId, role),
        });
        return { predicate, failClosed: false, denyCompiled: false };
      }
      return compileAccessPredicateResult({
        rules: rules as AbacPolicyRule[],
        subject,
        action,
        ctx: this.abacContext(projectId, userId, role),
      });
    } catch {
      // Defensive: compileAccessPredicateResult is already fail-safe, but never let a
      // predicate-compilation surprise break a request — drop to "absent".
      return { predicate: undefined, failClosed: false, denyCompiled: false };
    }
  }

  /**
   * Partial-eval context (RFC-ABAC §2). Department/ownership attributes are NOT
   * resolvable on the gateway — the compiler defers any rule that references them
   * (UNRESOLVABLE_CONTEXT_REFS), so those placeholder values are never consumed.
   */
  private abacContext(projectId: string, userId: string, role: string): AbacEvalContext {
    return {
      user: {
        id: userId,
        departmentId: null,
        departmentChain: [],
        leaderOfDepartmentIds: [],
        role: role || '',
      },
      project: { id: projectId, ownerType: '', ownerId: '' },
    };
  }

  /**
   * [review-1] ABAC push-down for a CROSS-ENTITY route (global search): one
   * `entityType`-guarded disjunct per indexed data-subject, so each module's
   * conditional rules apply inside its own type and a subject that is
   * blanket-DENYed or whose rules cannot be compiled is dropped from the result
   * set entirely. See `compileCrossEntityAccessPredicate` for the full contract.
   *
   * Reuses the SAME `rules` / `role` inputs as the single-subject path, so it adds
   * no round-trip and inherits the same K3 (epoch) invalidation. The per-subject
   * compilations are pure and in-process.
   */
  private resolveCrossEntityAccessPredicate(
    rules: ModulePolicyRule[],
    action: string,
    projectId: string,
    userId: string,
    role: string,
  ): string | undefined {
    if (!userId) return undefined;
    try {
      return compileCrossEntityAccessPredicate({
        rules: rules as AbacPolicyRule[],
        action,
        ctx: this.abacContext(projectId, userId, role),
        subjectEntityTypes: CROSS_ENTITY_SUBJECT_TYPE_PAIRS,
        // The very DENY that 403s the module's own route must not be searchable
        // around — the blanket-deny check is the same one the RBAC layer just ran.
        isBlanketDenied: (s) => this.isDeniedByPolicy(rules, s, action, role),
      });
    } catch (e) {
      // Defensive only: every per-rule failure is already handled inside the
      // compiler as a fail-closed type drop, so reaching here means serialization
      // itself broke — in which case a deny-all could not be serialized either.
      // Log loudly instead of silently searching without ABAC.
      this.logger.error(
        `cross-entity access predicate could not be built for project ${projectId} — search runs without ABAC narrowing: ${String(e)}`,
      );
      return undefined;
    }
  }

  /**
   * [TODO-109] Widen a cross-resource route's scope with the record shares of every
   * shareable resource, keyed by entity type. Returns the serialized scope to put
   * on `x-visibility-scope`.
   *
   * Skipped (returns the primary scope untouched) when:
   *  - the subject is not cross-resource (every ordinary route),
   *  - the caller is not a member (the request is about to 403 anyway — do not
   *    spend N control round-trips on a denied request),
   *  - the scope could not be resolved (fail-closed stays fail-closed),
   *  - mode is `all` — there is no record-level narrowing to widen,
   *  - the scope is DEFERRED — its lists are empty by contract and the domain must
   *    hydrate the WHOLE scope itself; half-filling it here would produce a filter
   *    that matches shares but not the owner set (a wrong, not a safer, read).
   *
   * The fan-out reuses `resolveAccess`, so it goes through the epoch-validated
   * ACCESS_CACHE: at most one extra control round-trip per (project,user,resource)
   * per TTL/epoch, none on the steady-state per-keystroke search path.
   */
  private async withCrossResourceShares(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    epoch: number,
    subject: string,
    action: string,
    access: AccessResolution,
  ): Promise<string> {
    const base = access.visibility;
    if (!CROSS_ENTITY_SUBJECTS.has(subject) || !RECORD_RETURNING_ACTIONS.has(action)) {
      return access.scope;
    }
    if (!base || !access.allowed) return access.scope;
    if (base.mode !== 'restricted' || base.deferred) return access.scope;

    const resolved = await Promise.all(
      SHAREABLE_RESOURCE_LIST.map(
        async (res) =>
          [res, await this.sharedRecordIdsFor(request, projectId, userId, epoch, res)] as const,
      ),
    );
    const byType: Record<string, string[]> = {};
    let total = 0;
    for (const [res, ids] of resolved) {
      if (!ids.length) continue;
      byType[SHAREABLE_RESOURCE_ENTITY_TYPES[res]] = ids;
      total += ids.length;
    }
    if (Object.keys(byType).length === 0) return access.scope;
    // [#19] Metadata budget: control caps ONE resource at VISIBILITY_SCOPE_MAX_IDS,
    // so a fan-out over N resources could carry N× that and blow the ~8 KiB gRPC
    // metadata limit — which would break search outright. There is no descriptor
    // (deferred) path for cross-resource shares yet, so degrade instead: drop the
    // whole map (own-records-only search, i.e. today's behaviour) rather than
    // truncate it into a half-visible, non-deterministic result set.
    if (total > VISIBILITY_SCOPE_MAX_IDS) {
      this.logger.warn(
        `cross-resource shares for project ${projectId} exceed the metadata budget (${total} ids) — global search falls back to own records`,
      );
      return access.scope;
    }
    // New object — the cached AccessResolution.visibility is never mutated.
    return serializeVisibilityScope({ ...base, sharedRecordIdsByType: byType });
  }

  /** Record ids of ONE shareable resource shared with the viewer (best-effort). */
  private async sharedRecordIdsFor(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    epoch: number,
    resource: ShareableResource,
  ): Promise<string[]> {
    try {
      const res = await this.resolveAccess(request, projectId, userId, resource, epoch);
      // A deferred per-resource scope carries EMPTY lists by contract — treat it as
      // "no shares" (narrower than intended is safe; inventing ids is not).
      if (!res.visibility || res.visibility.deferred) return [];
      return res.visibility.sharedRecordIds;
    } catch {
      // Best-effort widening: an outage while fanning out must not 503 a route whose
      // primary decision (membership/role/own records) has already been resolved.
      return [];
    }
  }

  private isMutatingHttpMethod(method: string): boolean {
    const m = method.toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  }

  private isLifecycleWriteExempt(url: string, method: string): boolean {
    if (!this.isMutatingHttpMethod(method)) return true;
    const path = (url ?? '').split('?')[0];
    return PROJECT_LIFECYCLE_ROUTE_RE.test(path);
  }

  /**
   * FR-PROJ-120: block mutating BFF routes when the project is archived or
   * pending_deletion. Lifecycle transitions (restore/unarchive/request-deletion)
   * are exempt so admins can recover or schedule purge.
   */
  private async enforceProjectWritablePhase(
    request: ProjectScopedRequest,
    projectId: string,
  ): Promise<void> {
    const req = request as { method?: string; url?: string; raw?: { url?: string } };
    const method = req.method ?? 'GET';
    const url = req.url ?? req.raw?.url ?? '';
    if (this.isLifecycleWriteExempt(url, method)) return;

    const md = this.outboundMeta.build(request as never, { projectId });
    try {
      const project = await firstValueFrom(this.getClient().getProject({ id: projectId }, md));
      const status = String(project?.status ?? 'active').toLowerCase();
      if (status !== 'active') {
        throw new ForbiddenException({
          code: 'PROJECT_READ_ONLY',
          message: 'Project is read-only in its current lifecycle phase',
          status,
        });
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (this.isMutatingHttpMethod(method)) {
        throw new ServiceUnavailableException({
          code: 'PROJECT_PHASE_CHECK_FAILED',
          message: 'Unable to verify project lifecycle phase',
        });
      }
    }
  }

  private async resolveAccess(
    request: ProjectScopedRequest,
    projectId: string,
    userId: string,
    resource: string,
    epoch: number,
  ): Promise<AccessResolution> {
    const cacheKey = `${projectId}:${userId}:${resource}`;
    const ttl = accessCacheTtlMs();
    if (ttl > 0) {
      const cached = ACCESS_CACHE.get(cacheKey);
      // K3 (Д-4): a cached decision is valid only while its epoch matches the
      // project's current epoch — any access mutation bumps it and forces re-resolve.
      if (cached && cached.expiresAt > Date.now() && cached.epoch === epoch) {
        return cached.value;
      }
    }

    try {
      // Same metadata the working BFF calls build (service key + propagation).
      const md = this.outboundMeta.build(request as never, { projectId });
      // One round-trip resolves membership, role AND the record-visibility scope
      // (which needs the org structure that only control can see).
      const res = await firstValueFrom(
        this.getClient().resolveRecordVisibility(
          { project_id: projectId, user_id: userId, resource },
          md,
        ),
      );
      // Prefer the epoch control stamped on the decision (resolved atomically with
      // it); fall back to the epoch we read for this request. Skip caching when the
      // freshness read failed (epoch < 0) so a stale decision is never persisted.
      const resolvedEpoch = res?.epoch !== undefined ? Number(res.epoch) || 0 : epoch;
      // [#19] stamp resource + resolvedEpoch into the scope for domain hydration.
      const visibility = this.parseScope(res ?? {}, userId, resource, resolvedEpoch);
      const value: AccessResolution = {
        allowed: res?.allowed === true,
        role: res?.role ?? '',
        scope: serializeVisibilityScope(visibility),
        visibility,
      };
      if (ttl > 0 && resolvedEpoch >= 0)
        setBoundedCacheEntry(
          ACCESS_CACHE,
          cacheKey,
          { value, epoch: resolvedEpoch, expiresAt: Date.now() + ttl },
          projectAccessCacheMax(),
        );
      return value;
    } catch {
      // Fail closed when enforcing (don't silently grant access on an outage).
      if (this.enforce) {
        throw new ServiceUnavailableException({
          code: 'PROJECT_ACCESS_CHECK_FAILED',
          message: 'Could not verify project membership',
        });
      }
      return { allowed: false, role: '', scope: '' };
    }
  }
}

/**
 * CANON (decision Р-3 / X-15, P8): the **epoch** (`ProjectAccessEpoch`, bumped on
 * membership/role/visibility changes and folded into every ACCESS/POLICY/EPOCH cache
 * key) is the canonical, sufficient invalidation mechanism — a stale cache entry is
 * simply never read once the epoch moves.
 *
 * This helper is an OPTIONAL optimization for bulk/immediate eviction (e.g. mass
 * revocation) that proactively drops entries instead of waiting for the epoch to
 * rotate. Zero call-sites is DELIBERATE, not a bug: correctness does not depend on
 * it. Keep it for future bulk-revoke paths; do not "wire it up" reflexively.
 */
export function invalidateProjectAccessCache(projectId: string, userId?: string) {
  // Keys are `${projectId}:${userId}:${resource}` — match by prefix.
  const prefix = userId ? `${projectId}:${userId}:` : `${projectId}:`;
  for (const key of ACCESS_CACHE.keys()) {
    if (key.startsWith(prefix)) ACCESS_CACHE.delete(key);
  }
  // TODO-027: granular verdicts share the same key prefix (project:user:…).
  for (const key of PDP_CACHE.keys()) {
    if (key.startsWith(prefix)) PDP_CACHE.delete(key);
  }
  if (userId) {
    EFFECTIVE_PERMS_CACHE.delete(`${projectId}:${userId}`);
  } else {
    for (const key of EFFECTIVE_PERMS_CACHE.keys()) {
      if (key.startsWith(prefix)) EFFECTIVE_PERMS_CACHE.delete(key);
    }
  }
  POLICY_CACHE.delete(projectId);
  POLICY_LKG.delete(projectId);
  EPOCH_CACHE.delete(projectId);
}
