import { Injectable } from '@nestjs/common';
import {
  effectiveVisibilityLevel,
  effectiveVisibilityPolicy,
  visibilityPolicyUsesSharing,
  normalizeVisibilityConfig,
  normalizeVisibilityConfigV2,
  visibilityScopeExpandedSize,
  MAX_GROUP_DEPTH,
  VISIBILITY_SCOPE_MAX_IDS,
  type VisibilityLevel,
  type VisibilityPolicy,
  type VisibilityRuleKind,
  type VisibilityScopeDescriptor,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedVisibility {
  allowed: boolean;
  role: string;
  /** Diagnostic tag only — legacy level when 1:1, else 'custom'. Domains ignore it. */
  level: VisibilityLevel | 'custom';
  mode: 'all' | 'restricted';
  ownerIds: string[];
  /** Record ids of `resource` explicitly shared with the viewer. */
  sharedRecordIds: string[];
  /** FR-CONTACTS-285: units/departments the viewer belongs to (always small). */
  viewerDepartmentIds: string[];
  /** Policy-scoped unit ids for department-owned records (FR-COMPANIES-355). */
  departmentIds: string[];
  /**
   * [#19] true when the expanded ownerIds/sharedRecordIds exceeded
   * VISIBILITY_SCOPE_MAX_IDS: the flat lists are then EMPTY and `descriptor`
   * carries the compact seeds for the domain to resolve server-side.
   */
  deferred: boolean;
  /** [#19] compact seeds, present iff `deferred`. */
  descriptor?: VisibilityScopeDescriptor;
  /** Viewer direct unit ids (department visibility for deals). */
  viewerUnitIds?: string[];
}

/** Internal access-unit shape (dual-source: AccessUnit, else legacy Department). */
interface UnitRow {
  id: string;
  scopeType: string;
  scopeId: string;
  parentId: string | null;
  leaderUserId: string | null;
}

/**
 * Phase 4d / E2-06+E2-07: resolves a user's record-visibility scope in a project.
 *
 * The gateway calls this once per request (cached) and propagates the flat result
 * to CRM domains as `x-visibility-scope`. ALL group/hierarchy traversal lives
 * here (the Postgres data is here). The output is ALWAYS a flat ownerIds[] —
 * `buildVisibilityFilter`, `serializeVisibilityScope` and the CRM domains are
 * unchanged (RFC-ACCESS-GROUPS §3.3).
 *
 * E2-07 generalizes the hard `switch(level)` into a loop over `policy.rules`
 * (own / own_groups / own_subgroups{roots} / selected_groups / all). The legacy
 * 5-value enum maps 1:1 to a policy, so a project that never edits its config
 * gets byte-for-byte the same ownerIds[] (regression invariant §9.1).
 *
 * E2-06 reads from AccessUnit/AccessUnitMember when the org has been backfilled,
 * else falls back to Department/Employee (dual-source §4 Фаза 2). Either way the
 * flat ownerIds[] is identical for the legacy-equivalent levels.
 */
@Injectable()
export class VisibilityResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * [#19] Inline-vs-defer cap. Env-override (`VISIBILITY_SCOPE_MAX_IDS`) over the
   * shared constant so tests/e2e can force deferral cheaply (cap=5) instead of
   * generating thousands of owners. Non-positive/NaN → fall back to the constant.
   */
  private maxInlineIds(): number {
    const raw = process.env.VISIBILITY_SCOPE_MAX_IDS;
    if (raw === undefined) return VISIBILITY_SCOPE_MAX_IDS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : VISIBILITY_SCOPE_MAX_IDS;
  }

  /**
   * @param opts.inline  [#19] force full (non-deferred) inline lists regardless
   *   of size. For IN-PROCESS consumers (e.g. PdpService) that don't push the
   *   result through the ~8 KiB gRPC metadata budget — they must NOT be degraded
   *   to fail-closed by the defer cap. The gateway path leaves this false so
   *   oversized scopes defer (see resolveRecordVisibility grpc handler).
   */
  async resolve(
    projectId: string,
    userId: string,
    resource = '',
    opts: { inline?: boolean } = {},
  ): Promise<ResolvedVisibility> {
    const deny: ResolvedVisibility = {
      allowed: false,
      role: '',
      level: 'only_own',
      mode: 'restricted',
      ownerIds: [],
      sharedRecordIds: [],
      viewerDepartmentIds: [],
      departmentIds: [],
      deferred: false,
    };
    if (!projectId || !userId) return deny;

    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (!member) return deny;

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, visibilityConfig: true },
    });
    if (!project) return deny;

    const role = member.role;
    const configV2 = normalizeVisibilityConfigV2(project.visibilityConfig);
    const legacyConfig = normalizeVisibilityConfig(project.visibilityConfig);
    const policy = effectiveVisibilityPolicy(role, configV2);
    // Legacy tag for diagnostics; 'custom' when the policy has no 1:1 legacy form.
    const level = this.diagnosticLevel(role, legacyConfig, policy);
    const usesSharing = visibilityPolicyUsesSharing(role, configV2);
    const onlyOwnStrict = level === 'only_own';

    // Short-circuit `all` (a policy rule containing `all`). DEORG-W1: box has no
    // personal projects — the former `ownerType!=='ORGANIZATION'` disjunct is
    // unreachable and removed; the deferred-scope path below is preserved.
    const hasAll = policy.rules.some((r) => r.kind === 'all');
    if (hasAll) {
      return {
        allowed: true,
        role,
        level,
        mode: 'all',
        ownerIds: [],
        sharedRecordIds: [],
        viewerDepartmentIds: [],
        departmentIds: [],
        deferred: false,
      };
    }

    const orgId = project.ownerId;

    // ── Load the group graph (dual-source: AccessUnit, else legacy Department). ──
    const { units, membersByUnit, unitsOfUser } = await this.loadGroupGraph(
      orgId,
      projectId,
      userId,
    );
    const allowedScopeIds = new Set([projectId, orgId]);

    const ownerIds = new Set<string>([userId]);
    // Department-owned records (`departmentId`) are visible only when the policy
    // has a department-level rule. Seeding this set with the viewer's units on
    // `only_own` would OR those departments into company filters and leak
    // colleagues' companies (FR-COMPANIES-355).
    const departmentIds = new Set<string>();

    // [#19] Capture compact seeds alongside the expansion so we can emit a
    // descriptor instead of the flat lists when the org is large.
    const ruleKinds: VisibilityRuleKind[] = [];
    const selectedGroupIds = new Set<string>();
    let usedLedSubgroups = false;

    const trackUnits = (ids: string[]) => {
      for (const id of ids) departmentIds.add(id);
    };

    for (const rule of policy.rules) {
      ruleKinds.push(rule.kind);
      switch (rule.kind) {
        case 'own':
        case 'all':
          break; // self already present / handled above
        case 'own_groups': {
          const seeds = unitsOfUser(userId);
          trackUnits(seeds);
          this.addEffectiveUsers(seeds, units, membersByUnit, allowedScopeIds, ownerIds);
          break;
        }
        case 'own_subgroups': {
          // Walks ONLY the parentId hierarchy (never composition) — §2.1.
          if (rule.roots === 'led') usedLedSubgroups = true;
          const roots =
            rule.roots === 'led'
              ? units.filter((u) => u.leaderUserId === userId).map((u) => u.id)
              : unitsOfUser(userId);
          const subtree = this.collectSubtree(units, roots);
          trackUnits(subtree);
          this.addEffectiveUsers(subtree, units, membersByUnit, allowedScopeIds, ownerIds);
          break;
        }
        case 'selected_groups': {
          // M1.2: drop cross-scope ids before expansion.
          const byId = new Map(units.map((u) => [u.id, u]));
          const inScope = rule.groupIds.filter((id) => {
            const u = byId.get(id);
            return u != null && allowedScopeIds.has(u.scopeId);
          });
          for (const id of inScope) selectedGroupIds.add(id);
          trackUnits(inScope);
          this.addEffectiveUsers(inScope, units, membersByUnit, allowedScopeIds, ownerIds);
          break;
        }
      }
    }

    const viewerUnitIds = unitsOfUser(userId);
    const viewerDepartmentIds = [...viewerUnitIds];
    const sharedRecordIds =
      onlyOwnStrict || !usesSharing
        ? []
        : await this.sharedRecordIds(projectId, resource, userId, viewerUnitIds, units);

    // ── [#19] Inline-vs-defer decision ─────────────────────────────────────
    // If the fully expanded lists fit the metadata budget, inline them (the
    // AS-IS path — byte-for-byte identical for normal orgs). Otherwise leave the
    // lists EMPTY, flip `deferred`, and emit a compact descriptor the domain
    // resolves server-side. Never truncate the lists (that would silently
    // under-scope / over-scope — fail-closed to the descriptor instead).
    const expandedIds = [...ownerIds];
    const size = visibilityScopeExpandedSize(expandedIds, sharedRecordIds);
    if (!opts.inline && size > this.maxInlineIds()) {
      const ledUnitIds = usedLedSubgroups
        ? units.filter((u) => u.leaderUserId === userId).map((u) => u.id)
        : [];
      const descriptor: VisibilityScopeDescriptor = {
        unitIds: viewerUnitIds,
        ledUnitIds,
        selectedGroupIds: [...selectedGroupIds],
        ruleKinds,
        usesSharing: !onlyOwnStrict && usesSharing,
        orgId,
      };
      return {
        allowed: true,
        role,
        level,
        mode: 'restricted',
        ownerIds: [],
        sharedRecordIds: [],
        viewerDepartmentIds,
        departmentIds: [],
        deferred: true,
        descriptor,
        viewerUnitIds: viewerUnitIds,
      };
    }

    return {
      allowed: true,
      role,
      level,
      mode: 'restricted',
      ownerIds: expandedIds,
      sharedRecordIds,
      viewerDepartmentIds,
      departmentIds: [...departmentIds],
      deferred: false,
      viewerUnitIds: viewerUnitIds,
    };
  }

  /** Best-effort legacy tag: keep the legacy level when it maps 1:1, else 'custom'. */
  private diagnosticLevel(
    role: string,
    legacyConfig: ReturnType<typeof normalizeVisibilityConfig>,
    _policy: VisibilityPolicy,
  ): VisibilityLevel | 'custom' {
    // If the stored config (for this role) was a plain legacy string, the legacy
    // normalizer kept it — report it verbatim.
    const legacy = legacyConfig[role as keyof typeof legacyConfig];
    if (legacy) return legacy;
    // No per-role override stored: report the default-derived legacy level.
    const defaulted = effectiveVisibilityLevel(role, legacyConfig);
    // A policy object override would not appear in the legacy config → 'custom'
    // unless it matches a known legacy shape.
    return defaulted;
  }

  /**
   * Dual-source group graph. Prefers AccessUnit/AccessUnitMember; if the org has
   * no AccessUnit rows (not backfilled), falls back to Department/Employee so the
   * resolver keeps working during the migration window (§4 Фаза 2).
   *
   * Returns:
   *  - units:          all non-archived units in {projectId, orgId} scope.
   *  - membersByUnit:  unitId → { users:string[], childGroups:string[] }.
   *  - unitsOfUser(u): unit ids the user is a direct member of.
   */
  /**
   * FR-ORG-235: graph source switch is gated by an explicit backfill flag on the
   * system singleton — never by the mere existence of AccessUnit rows.
   */
  private async accessUnitsBackfilled(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ access_units_backfilled: boolean }[]>`
      SELECT access_units_backfilled FROM control.system_settings WHERE id = 'system' LIMIT 1
    `;
    return rows[0]?.access_units_backfilled === true;
  }

  private async loadGroupGraph(
    orgId: string,
    projectId: string,
    _userId: string,
  ): Promise<{
    units: UnitRow[];
    membersByUnit: Map<string, { users: string[]; childGroups: string[] }>;
    unitsOfUser: (u: string) => string[];
  }> {
    const backfilled = await this.accessUnitsBackfilled();
    const accessUnits = await this.prisma.accessUnit.findMany({
      where: { scopeId: { in: [orgId, projectId] }, archivedAt: null },
      select: { id: true, scopeType: true, scopeId: true, parentId: true, leaderUserId: true },
    });

    if (backfilled && accessUnits.length > 0) {
      const members = await this.prisma.accessUnitMember.findMany({
        where: { unitId: { in: accessUnits.map((u) => u.id) } },
        select: { unitId: true, memberType: true, memberId: true },
      });
      const membersByUnit = new Map<string, { users: string[]; childGroups: string[] }>();
      const userMemberships = new Map<string, string[]>();
      for (const u of accessUnits) {
        membersByUnit.set(u.id, { users: [], childGroups: [] });
      }
      for (const m of members) {
        const bucket = membersByUnit.get(m.unitId);
        if (!bucket) continue;
        if (m.memberType === 'group') {
          bucket.childGroups.push(m.memberId);
        } else {
          bucket.users.push(m.memberId);
          const list = userMemberships.get(m.memberId) ?? [];
          list.push(m.unitId);
          userMemberships.set(m.memberId, list);
        }
      }
      return {
        units: accessUnits,
        membersByUnit,
        unitsOfUser: (u: string) => userMemberships.get(u) ?? [],
      };
    }

    return this.loadDepartmentGroupGraph(orgId);
  }

  /** Legacy Department + Employee graph (pre-AccessUnit migration window). */
  private async loadDepartmentGroupGraph(orgId: string): Promise<{
    units: UnitRow[];
    membersByUnit: Map<string, { users: string[]; childGroups: string[] }>;
    unitsOfUser: (u: string) => string[];
  }> {
    const [employees, departments] = await Promise.all([
      this.prisma.employee.findMany({
        where: { organizationId: orgId },
        select: { userId: true, departmentId: true },
      }),
      this.prisma.department.findMany({
        where: { organizationId: orgId },
        select: { id: true, parentId: true, leaderUserId: true },
      }),
    ]);
    const units: UnitRow[] = departments.map((d) => ({
      id: d.id,
      scopeType: 'ORGANIZATION',
      scopeId: orgId,
      parentId: d.parentId,
      leaderUserId: d.leaderUserId,
    }));
    const membersByUnit = new Map<string, { users: string[]; childGroups: string[] }>();
    const userMemberships = new Map<string, string[]>();
    for (const d of departments) membersByUnit.set(d.id, { users: [], childGroups: [] });
    for (const e of employees) {
      if (!e.departmentId) continue;
      const bucket = membersByUnit.get(e.departmentId);
      if (!bucket) continue;
      bucket.users.push(e.userId);
      const list = userMemberships.get(e.userId) ?? [];
      list.push(e.departmentId);
      userMemberships.set(e.userId, list);
    }
    return {
      units,
      membersByUnit,
      unitsOfUser: (u: string) => userMemberships.get(u) ?? [],
    };
  }

  /**
   * `effectiveUsers` (RFC §3.3): expand a seed set of unit ids into all member
   * user ids, following composition (memberType=group) recursively.
   *
   * M2.2 hard-stop (NORMATIVE, lives INSIDE this function): on EVERY BFS node,
   * before expanding a unit, skip it if its scopeId is not in allowedScopeIds.
   * This closes transitive cross-scope leaks on 2nd+ composition hops, not just
   * on the input filter.
   */
  private addEffectiveUsers(
    seedUnitIds: string[],
    units: UnitRow[],
    membersByUnit: Map<string, { users: string[]; childGroups: string[] }>,
    allowedScopeIds: Set<string>,
    into: Set<string>,
  ): void {
    if (!seedUnitIds.length) return;
    const byId = new Map(units.map((u) => [u.id, u]));
    const visited = new Set<string>();
    const queue = [...seedUnitIds];
    let depth = 0;
    while (queue.length) {
      if (depth++ > units.length * (MAX_GROUP_DEPTH + 1) + 1) break; // failsafe
      const unitId = queue.shift()!;
      if (visited.has(unitId)) continue;
      visited.add(unitId);
      const unit = byId.get(unitId);
      // M2.2 per-node cross-scope hard-stop (also drops dangling ids — R7 tolerant).
      if (!unit || !allowedScopeIds.has(unit.scopeId)) continue;
      const bucket = membersByUnit.get(unitId);
      if (!bucket) continue;
      for (const u of bucket.users) into.add(u);
      for (const child of bucket.childGroups) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }

  /** Record ids of `resource` shared with the viewer directly or via their unit chain. */
  private async sharedRecordIds(
    projectId: string,
    resource: string,
    userId: string,
    viewerUnitIds: string[],
    units: UnitRow[],
  ): Promise<string[]> {
    if (!resource) return [];
    // A grant to any of the viewer's units (or any ancestor) reaches the viewer.
    const chain = new Set<string>();
    for (const start of viewerUnitIds) {
      for (const id of this.collectAncestors(units, start)) chain.add(id);
    }
    const grantees: { granteeType: string; granteeId: string }[] = [
      { granteeType: 'user', granteeId: userId },
      // Accept BOTH legacy 'department' and the new 'unit' alias (m3).
      ...[...chain].flatMap((id) => [
        { granteeType: 'department', granteeId: id },
        { granteeType: 'unit', granteeId: id },
      ]),
    ];
    // Only ACTIVE grants extend visibility — an expired grant is treated as
    // absent (E2-11, fail-closed; no row delete required).
    const shares = await this.prisma.recordShare.findMany({
      where: {
        projectId,
        resource,
        AND: [{ OR: grantees }, { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      select: { recordId: true },
    });
    return [...new Set(shares.map((s) => s.recordId))];
  }

  /** The unit itself plus all its ancestors (walking parentId up). */
  private collectAncestors(
    units: { id: string; parentId: string | null }[],
    startId: string,
  ): string[] {
    const byId = new Map(units.map((u) => [u.id, u]));
    const out: string[] = [];
    const guard = new Set<string>();
    let cursor: string | null = startId;
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      out.push(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return out;
  }

  /** BFS down the parent→children tree; returns roots plus all descendants (inclusive). */
  private collectSubtree(
    units: { id: string; parentId: string | null }[],
    rootIds: string[],
  ): string[] {
    if (!rootIds.length) return [];
    const childrenOf = new Map<string, string[]>();
    for (const u of units) {
      if (!u.parentId) continue;
      const arr = childrenOf.get(u.parentId) ?? [];
      arr.push(u.id);
      childrenOf.set(u.parentId, arr);
    }
    const out = new Set<string>();
    const queue = [...rootIds];
    while (queue.length) {
      const id = queue.shift()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const child of childrenOf.get(id) ?? []) queue.push(child);
    }
    return [...out];
  }
}
