import { Injectable } from '@nestjs/common';
import {
  decideRbac,
  parseAbac,
  normalizeAbac,
  resolveContextRefs,
  evalGate,
  AbacError,
  isVisibilityLevel,
  type AbacEvalContext,
  type VisibilityLevel,
} from '@fairflow/shared';
import { RolesService } from './roles.service';
import { ProjectsService } from '../projects/projects.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

/** One step of the explain trace (permission-abac-visibility/TZ §6.2). */
export interface AccessTraceStep {
  layer: 'rbac' | 'abac' | 'visibility' | 'sharing';
  effect: 'allow' | 'deny' | 'narrow' | 'pass' | 'grant';
  ruleId?: string;
  reason: string;
  /** Layer was not consulted (skipped) — e.g. no record to gate ABAC against. */
  inactive?: boolean;
}

export interface SimulateExplainResult {
  decision: 'allow' | 'deny';
  reason: string;
  trace: AccessTraceStep[];
  role: string;
}

/** One (subject, action) pair the PEP wants a verdict for (TODO-027). */
export interface PermissionCheckInput {
  subject: string;
  action: string;
}

/** Verdict for one pair — the wire shape of `PermissionDecision`. */
export interface PermissionCheckDecision {
  subject: string;
  action: string;
  decision: 'allow' | 'deny';
  reason: string;
  matchedKeys: string[];
  /**
   * True ⇒ the pair has no key in this project's catalog, so the granular engine
   * has NO opinion (nothing can be allowed or denied for a non-storable key) and
   * the PEP must keep its own verdict. See the proto comment on
   * `PermissionDecision.not_applicable` for why this is the single non-fail-closed
   * path and why it cannot be reached by an error/empty response.
   */
  notApplicable: boolean;
}

export interface CheckPermissionsResult {
  decisions: PermissionCheckDecision[];
  role: string;
  epoch: number;
}

/** API-2 projection (ui-shell/TZ §5.1). */
export interface PermissionProjection {
  projectId: string;
  allowed: string[];
  modulePolicyFlags: Record<string, Record<string, boolean>>;
  visibilityScope: {
    mode: string;
    level: VisibilityLevel | 'custom';
    selfId: string;
    departmentIds: string[];
  };
  epoch: number;
}

/** Stored module-policy rule shape (carries an ABAC `condition` predicate). */
interface ModulePolicyRule {
  id?: string;
  moduleId?: string;
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: Record<string, unknown>;
}

/**
 * PDP (Policy Decision Point) — production resolver in three surfaces (E2-09, K3fe-be):
 *
 *  - `checkPermissions` (gateway PEP, TODO-027): RBAC-only hot path via shared
 *    `decideRbac` / `decideGranular` — membership role + custom role keys. Does NOT
 *    run per-record ABAC `evalGate` or visibility-resolver (those live on domain
 *    read filters via `x-access-predicate` / `x-visibility-scope`). Intentional gap
 *    vs `simulateExplain` (FR-ACCESS-510).
 *
 *  - `simulateExplain` (FR-ABAC-19): full layer pipeline for policy what-if —
 *    RBAC `decideRbac` → ABAC `evalGate` → visibility-resolver → sharing, each
 *    layer appending a trace step. Delegates to the same shared helpers as domains.
 *
 *  - `resolveProjection` (API-2): client-facing `PermissionProjection` for FE
 *    fail-closed gating (`allowed[]` + `modulePolicyFlags` + `visibilityScope`).
 *
 * All surfaces are stamped with the project access epoch (K3-invalidation, Д-4).
 */
@Injectable()
export class PdpService {
  constructor(
    private readonly roles: RolesService,
    private readonly projects: ProjectsService,
    private readonly visibility: VisibilityResolverService,
    private readonly accessEpoch: ProjectAccessEpochService,
    private readonly prisma: PrismaService,
  ) {}

  // ── ownership (project membership, not role-assignment) ─────────────────────

  /**
   * True iff the user is the project's owner. Ownership lives in `ProjectMember`
   * (role='owner'), created atomically with the project (Д-7) — NOT in
   * `roleAssignment`. `roles.resolveEffective` only reads `roleAssignment`, so for
   * a fresh project (0 materialized role assignments, D10) it returns role=''.
   * The PDP must therefore derive owner from membership directly, otherwise the
   * owner gets an empty `allowed[]` and the host menu is blank (D9).
   */
  private async isProjectOwner(projectId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return member?.role === 'owner';
  }

  // ── module-policy / ABAC source ────────────────────────────────────────────

  private async modulePolicyRules(projectId: string): Promise<ModulePolicyRule[]> {
    const project = await this.projects.findOne(projectId);
    const rules = (project as { modulePolicies?: unknown }).modulePolicies;
    return Array.isArray(rules) ? (rules as ModulePolicyRule[]) : [];
  }

  /** True iff the rule has a non-empty ABAC condition (vs a plain flat allow/deny). */
  private hasCondition(rule: ModulePolicyRule): boolean {
    return (
      rule.condition != null &&
      typeof rule.condition === 'object' &&
      Object.keys(rule.condition).length > 0
    );
  }

  // ── visibility scope (mirror of x-visibility-scope) ─────────────────────────

  private async departmentIds(projectId: string, userId: string): Promise<string[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    // DEORG-W1: every project is owned by the System — read the departments from
    // the system structure by the project's system anchor (ownerId).
    if (!project) return [];
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: project.ownerId, userId, departmentId: { not: null } },
      select: { departmentId: true },
    });
    return employees.map((e) => e.departmentId!).filter(Boolean);
  }

  // ── ABAC eval context (partial-eval on control, RFC-ABAC §2) ────────────────

  private async abacContext(
    projectId: string,
    userId: string,
    role: string,
  ): Promise<AbacEvalContext> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    const deptIds = await this.departmentIds(projectId, userId);
    return {
      user: {
        id: userId,
        departmentId: deptIds[0] ?? null,
        departmentChain: deptIds,
        leaderOfDepartmentIds: [],
        role,
      },
      project: {
        id: projectId,
        // DEORG-W1: box has a single ownership vector — the System. The ABAC
        // context keeps the neighbour field (shared contract) with a constant.
        ownerType: 'ORGANIZATION',
        ownerId: project?.ownerId ?? '',
      },
    };
  }

  // ── projection (API-2) ──────────────────────────────────────────────────────

  async resolveProjection(projectId: string, userId: string): Promise<PermissionProjection> {
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const [{ effective, role }, vis, rules, epoch, owner] = await Promise.all([
      this.roles.resolveEffective(projectId, userId),
      this.visibility.resolve(projectId, userId),
      this.modulePolicyRules(projectId),
      this.accessEpoch.get(projectId),
      this.isProjectOwner(projectId, userId),
    ]);

    // Owner short-circuit (RFC "owner: всё") — same contract simulateExplain
    // enforces. Ownership is taken from project membership (isProjectOwner), not
    // the role-assignment-derived `role` (which is '' for a fresh project, D10).
    // The owner's `allowed` is the FULL project catalog (every `subject:action`),
    // independent of any materialized role rows, so the host menu stays populated.
    // Mirrors the catalog source used everywhere else (RolesService.getCatalog →
    // buildProjectCatalogWithSystem).
    const isOwner = owner || role === 'owner';
    const allowed = isOwner
      ? (await this.roles.getCatalog(projectId)).keys.slice()
      : effective.allow;

    // modulePolicyFlags: moduleId → { "subject:action": effect-allows-it }. A deny
    // rule (no condition) flips the flag false; allow keeps it true. Conditional
    // (ABAC) rules are record-dependent → not surfaced as a static flag here.
    const flags: Record<string, Record<string, boolean>> = {};
    for (const r of rules) {
      if (!r.moduleId || !r.subject || !r.action) continue;
      if (this.hasCondition(r)) continue;
      const bucket = (flags[r.moduleId] ??= {});
      bucket[`${r.subject}:${r.action}`] = r.effect !== 'deny';
    }

    const departmentIds = await this.departmentIds(projectId, userId);

    return {
      projectId,
      allowed,
      modulePolicyFlags: flags,
      visibilityScope: {
        mode: vis.mode,
        level: isVisibilityLevel(vis.level) ? vis.level : 'custom',
        selfId: userId,
        departmentIds,
      },
      epoch,
    };
  }

  // ── enforcement decision (TODO-027) ─────────────────────────────────────────

  /**
   * PEP↔PDP: batched allow/deny verdicts for the gateway's enforcement path.
   *
   * The decision engine is the SAME `decideRbac(subject, action, effective,
   * catalog)` the simulator (`RolesService.simulate`) and the explain endpoint
   * (`simulateExplain`) run — one effective-set resolve (`resolveEffective`:
   * role assignments incl. department/unit scope + PermissionGrant overlay with
   * deny > allow + membership baseline) shared across all pairs, so a batch of N
   * checks costs the same as one.
   *
   * Layers ABOVE RBAC are deliberately NOT evaluated here: ABAC needs a record
   * (the gateway pushes it down as `x-access-predicate`), visibility/sharing are
   * already resolved into `x-visibility-scope`. This call answers exactly the
   * layer the PEP was missing.
   *
   * Owner short-circuit (RFC «owner: всё») mirrors `simulateExplain`, so the
   * simulator and the live route cannot disagree for the project owner, and the
   * owner's flat-matrix behaviour is preserved bit-for-bit.
   */
  async checkPermissions(params: {
    projectId: string;
    userId: string;
    checks: PermissionCheckInput[];
  }): Promise<CheckPermissionsResult> {
    const { projectId, userId } = params;
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const checks = (params.checks ?? []).filter((c) => c && c.subject && c.action);
    // One effective-set resolve for the whole batch; the catalog comes back with
    // it (no second project read on the enforcement path).
    const [{ effective, role, catalog }, ownerMember, epoch] = await Promise.all([
      this.roles.resolveEffective(projectId, userId),
      this.isProjectOwner(projectId, userId),
      this.accessEpoch.get(projectId),
    ]);

    const isOwner = ownerMember || role === 'owner';
    const decisions: PermissionCheckDecision[] = checks.map((check) => {
      if (isOwner) {
        return {
          subject: check.subject,
          action: check.action,
          decision: 'allow' as const,
          reason: 'OWNER_ALL',
          matchedKeys: [],
          notApplicable: false,
        };
      }
      const d = decideRbac(check.subject, check.action, effective, catalog);
      // A missing catalog mapping is NOT a granular deny: no role and no grant
      // can reference a key the project's catalog does not contain, so the engine
      // has nothing to enforce and must not 403 a live route. Reported as
      // `notApplicable` — the PEP keeps its own verdict for that pair.
      const notApplicable = d.reason === 'PERMISSION_MAPPING_MISSING';
      return {
        subject: check.subject,
        action: check.action,
        decision: d.decision,
        reason: notApplicable ? 'NO_CATALOG_KEY' : d.reason,
        matchedKeys: d.matchedKeys,
        notApplicable,
      };
    });

    return { decisions, role: isOwner ? role || 'owner' : role, epoch };
  }

  // ── simulator / explain (E2-09, FR-ABAC-19) ─────────────────────────────────

  /** CRM resources that support per-record sharing (layer 4). */
  private static readonly SHAREABLE = new Set([
    'contacts',
    'companies',
    'deals',
    'orders',
    'activities',
  ]);

  async simulateExplain(params: {
    projectId: string;
    userId: string;
    subject: string;
    action: string;
    resource?: string;
    recordId?: string;
    /** Optional record snapshot to gate ABAC against (when the caller can read it). */
    record?: Record<string, unknown> | null;
  }): Promise<SimulateExplainResult> {
    const { projectId, userId } = params;
    if (!projectId || !userId) {
      throw new AppError('invalid', 'projectId and userId required');
    }
    const subject = params.subject ?? '';
    const action = params.action ?? '';
    const resource = params.resource ?? '';
    const trace: AccessTraceStep[] = [];

    const [{ effective, role }, ownerMember] = await Promise.all([
      this.roles.resolveEffective(projectId, userId),
      this.isProjectOwner(projectId, userId),
    ]);

    // Owner short-circuit (RFC: "owner: всё"). Ownership comes from project
    // membership (isProjectOwner), not the role-assignment-derived `role`, which
    // is '' for a project that has no materialized owner role assignment (D10).
    if (ownerMember || role === 'owner') {
      trace.push({ layer: 'rbac', effect: 'allow', reason: 'owner: всё', ruleId: 'owner' });
      return { decision: 'allow', reason: 'OWNER_ALL', trace, role: 'owner' };
    }

    // ── Layer 1: RBAC (decideRbac — same helper the hot path uses). ──
    const catalog = await this.roles.getCatalog(projectId);
    const rbac = decideRbac(subject, action, effective, catalog);
    trace.push({
      layer: 'rbac',
      effect: rbac.decision === 'allow' ? 'pass' : 'deny',
      reason: rbac.reason,
    });
    if (rbac.decision === 'deny') {
      return { decision: 'deny', reason: `RBAC_${rbac.reason}`, trace, role };
    }

    // ── Layer 2: ABAC (evalGate over the record, when supplied). ──
    const abacOutcome = await this.evalAbacLayer({
      projectId,
      userId,
      role,
      subject,
      action,
      resource,
      record: params.record ?? null,
      trace,
    });
    if (abacOutcome === 'deny') {
      return { decision: 'deny', reason: 'ABAC_DENY', trace, role };
    }

    // ── Layer 3: visibility (visibility-resolver — same resolver as enforcement). ──
    const visRes = resource ? resource : '';
    // [#19] inline: PDP consumes the flat lists in-process (no metadata budget) —
    // never let the defer cap degrade its decision to fail-closed.
    const vis = await this.visibility.resolve(projectId, userId, visRes, { inline: true });
    if (vis.mode === 'all') {
      trace.push({ layer: 'visibility', effect: 'pass', reason: 'mode=all' });
    } else {
      // narrow: enforcement restricts to ownerIds (and shared, layer 4). For a
      // concrete record we can decide; without one, the layer narrows the set.
      const ownerId = this.recordOwnerId(params.record);
      if (params.recordId && ownerId !== undefined) {
        const visible = vis.ownerIds.includes(ownerId);
        trace.push({
          layer: 'visibility',
          effect: visible ? 'pass' : 'narrow',
          reason: visible
            ? `record owner in scope (${vis.level})`
            : `record owner outside visibility scope (${vis.level})`,
        });
        if (!visible) {
          // ── Layer 4: sharing — an explicit share rescues an out-of-scope record. ──
          const shared = vis.sharedRecordIds.includes(params.recordId);
          trace.push({
            layer: 'sharing',
            effect: shared ? 'grant' : 'deny',
            reason: shared ? 'record explicitly shared with user' : 'no share grants access',
          });
          if (!shared) return { decision: 'deny', reason: 'VISIBILITY_DENY', trace, role };
          return { decision: 'allow', reason: 'OK_VIA_SHARE', trace, role };
        }
      } else {
        trace.push({
          layer: 'visibility',
          effect: 'narrow',
          reason: `restricted to ${vis.ownerIds.length} owner(s) (${vis.level}); no recordId to gate`,
          inactive: !params.recordId,
        });
      }
      // sharing layer note when not already resolved above.
      if (PdpService.SHAREABLE.has(resource)) {
        trace.push({
          layer: 'sharing',
          effect: 'pass',
          reason: 'sharing widens visibility for explicitly shared records',
          inactive: !params.recordId,
        });
      }
    }

    return { decision: 'allow', reason: 'OK', trace, role };
  }

  private recordOwnerId(record: Record<string, unknown> | null | undefined): string | undefined {
    if (!record) return undefined;
    const v = record.ownerId ?? record.assigneeId ?? record.owner_id ?? record.assignee_id;
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * ABAC layer: collect the conditional module-policy rules matching (subject,
   * action, resource), parse → resolveContextRefs → normalize → evalGate over the
   * supplied record. Returns 'deny' on a matching DENY whose gate evaluates true,
   * else 'pass'. When no record is supplied, the layer is reported `inactive`
   * (gate not evaluated — trace must not leak record values, FR-ABAC-20).
   */
  private async evalAbacLayer(params: {
    projectId: string;
    userId: string;
    role: string;
    subject: string;
    action: string;
    resource: string;
    record: Record<string, unknown> | null;
    trace: AccessTraceStep[];
  }): Promise<'deny' | 'pass'> {
    const { projectId, userId, role, subject, action, resource, record, trace } = params;
    const rules = (await this.modulePolicyRules(projectId)).filter(
      (r) =>
        this.hasCondition(r) &&
        r.subject === subject &&
        (r.action === action || r.action === '*') &&
        (!r.resource || r.resource === '*' || r.resource === resource),
    );
    if (rules.length === 0) {
      trace.push({
        layer: 'abac',
        effect: 'pass',
        reason: 'no ABAC condition matches',
        inactive: true,
      });
      return 'pass';
    }

    const ctx = await this.abacContext(projectId, userId, role);

    if (record) {
      const ownerId = this.recordOwnerId(record);
      if (ownerId && ownerId === userId) {
        trace.push({
          layer: 'abac',
          effect: 'grant',
          reason: 'owner-of-record short-circuit (FR-ABAC-16)',
        });
        return 'pass';
      }
    }

    for (const rule of rules) {
      let gate: boolean;
      try {
        const ir = normalizeAbac(resolveContextRefs(parseAbac(rule.condition), ctx));
        if (!record) {
          // No record to gate against — report the rule but do not evaluate (no
          // field values reach the trace; FR-ABAC-20).
          trace.push({
            layer: 'abac',
            effect: 'narrow',
            ruleId: rule.id,
            reason: `condition applies (no recordId to gate ${rule.effect ?? 'allow'})`,
            inactive: true,
          });
          continue;
        }
        gate = evalGate(ir, record);
      } catch (err) {
        // Uncompilable / unknown ref → fail-closed for a deny rule, skip allow.
        const msg = err instanceof AbacError ? err.code : 'ABAC_EVAL_ERROR';
        trace.push({ layer: 'abac', effect: 'deny', ruleId: rule.id, reason: msg });
        return 'deny';
      }
      const effect = rule.effect === 'deny' ? 'deny' : 'allow';
      if (effect === 'deny' && gate) {
        trace.push({
          layer: 'abac',
          effect: 'deny',
          ruleId: rule.id,
          reason: 'record matches deny condition',
        });
        return 'deny';
      }
      trace.push({
        layer: 'abac',
        effect: 'pass',
        ruleId: rule.id,
        reason: gate ? `${effect} condition matches` : `${effect} condition does not match`,
      });
    }
    return 'pass';
  }
}
