import { Injectable, Inject, forwardRef } from '@nestjs/common';
import {
  newEntityId,
  projectRoleAtLeast,
  isAccessGroupScopeType,
  isAccessGroupKind,
  isAccessGroupMemberType,
  MAX_GROUP_DEPTH,
  type AccessGroupScopeType,
  type AccessGroupKind,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { Prisma } from '../generated/prisma';

/**
 * E2-06 — Access Unit / Group CRUD + membership (RFC-ACCESS-GROUPS §7.3).
 *
 * One primitive generalizes Department. Lives in control / PostgreSQL.
 *
 * Security (all on control, fail-closed):
 *  - M6.1 every mutation is behind an authz-guard: ORGANIZATION-scope units need
 *    org owner/admin; PROJECT-scope units need project role manager+.
 *  - M1.1 write-time scope-guard: a member/container must share the unit's scope
 *    (no cross-scope nesting in v1, ОВ-5).
 *  - M6.2 no self-grant (cannot add yourself).
 *  - M6.4/B3 composition-add (memberType=group) requires manage on BOTH the
 *    container AND the nested group.
 *  - M3.1 composition cycle pre-check (DAG-DFS) + parentId cycle check.
 */
@Injectable()
export class AccessUnitService {
  /**
   * A target id that no real AccessUnit id can equal, used to force the
   * leader-delegation fallback to deny an operation that must NOT be delegated
   * (e.g. reparenting a unit to top-level). Entity ids are alphanumeric, so the
   * NUL-prefixed sentinel can never collide with one.
   */
  private static readonly NOT_DELEGATABLE = '\u0000__not-delegatable__';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrgAuditService))
    private readonly audit: OrgAuditService,
    private readonly pdp: OrgPdpService,
  ) {}

  /** Fail-closed: a missing requester identity is unauthenticated. */
  private assertActor(actorUserId: string | undefined): string {
    const actor = (actorUserId ?? '').trim();
    if (!actor) throw new AppError('auth', 'Authentication required');
    return actor;
  }

  /**
   * M6.1 authz: ORGANIZATION-scope ⇒ org owner/admin; PROJECT-scope ⇒ project
   * role manager+. Fail-closed on unknown scope / missing membership.
   */
  private async assertCanManageScope(
    scopeType: AccessGroupScopeType,
    scopeId: string,
    actorUserId: string | undefined,
  ): Promise<void> {
    const actor = this.assertActor(actorUserId);
    if (scopeType === 'ORGANIZATION') {
      // P8-T4.1: ORG-scope units gate on `org:units:manage` through the PDP instead
      // of the binary `orgRoleCanManage`. Default preserved (owner/admin carry it;
      // employee does not); a custom org role can grant unit management on its own.
      if (!(await this.pdp.canManage(scopeId, actor, 'org:units'))) {
        throw new AppError('access', 'Only the organization owner or admin can manage groups');
      }
      return;
    }
    if (scopeType === 'PROJECT') {
      const member = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: scopeId, userId: actor } },
        select: { role: true },
      });
      if (!projectRoleAtLeast(member?.role, 'manager')) {
        throw new AppError('access', 'Manager role or higher is required to manage groups');
      }
      return;
    }
    throw new AppError('invalid', 'Unknown scope type');
  }

  /**
   * Non-throwing form of {@link assertCanManageScope} — true iff the actor holds
   * the full org/project management right. Used to decide whether the leader
   * delegation second-chance (P8-T4.1/T4.2) even needs to run.
   */
  private async hasManageScope(
    scopeType: AccessGroupScopeType,
    scopeId: string,
    actorUserId: string | undefined,
  ): Promise<boolean> {
    const actor = (actorUserId ?? '').trim();
    if (!actor) return false;
    if (scopeType === 'ORGANIZATION') {
      return this.pdp.canManage(scopeId, actor, 'org:units');
    }
    if (scopeType === 'PROJECT') {
      const member = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: scopeId, userId: actor } },
        select: { role: true },
      });
      return projectRoleAtLeast(member?.role, 'manager');
    }
    return false;
  }

  // ─── Leader delegation (P8-T4.2) ─────────────────────────────────────────────

  /**
   * P8-T4.2 — unit-leader delegation. A unit leader (`AccessUnit.leaderUserId ==
   * actor`, unit not archived) may manage the composition of their OWN subtree —
   * the led unit plus every transitive child along the `parentId` hierarchy —
   * WITHOUT holding the org-wide `org:units:manage`. This is an ADDITIONAL path,
   * only reached after the full-rights check ({@link assertCanManageScope}) has
   * already denied; owners/admins/managers keep going through the T4.1 PDP path
   * unchanged.
   *
   * Boundary (curator decision):
   *  - subtree = the led unit U + all non-archived descendants reachable by
   *    `parentId` (structural hierarchy ONLY — member-group composition does NOT
   *    widen the subtree; a nested group is not a `parentId` child);
   *  - only non-archived, same-scope units count (an archived unit grants nothing
   *    and severs the branch below it from the leader's reach);
   *  - delegated operations: addMember/removeMember, update (rename) and create of
   *    a child unit whose `parentId` is inside the subtree;
   *  - reparent must keep BOTH ends inside the subtree (no dragging a unit out of
   *    the subtree, no pulling a foreign unit in);
   *  - NOT delegated: archive (only owner/admin — a leader must not hide a branch),
   *    org-level employee add/remove (that is org membership, not unit composition),
   *    and any operation on a unit outside the subtree.
   *
   * Self-escalation is structurally impossible: reachability is computed purely
   * from `parentId` starting at units the actor already leads, so a leader can
   * never reach a sibling/parent branch, and reparent's both-ends check blocks
   * pulling a foreign unit under a led node.
   */

  /**
   * Collect the ids of every unit inside ANY subtree the actor leads within
   * `(scopeType, scopeId)`. BFS down `parentId`, non-archived nodes only; an
   * archived node is skipped and prunes the branch below it. Returns the empty
   * set when the actor leads no (live) unit in the scope.
   */
  private async collectLeaderSubtree(
    scopeType: string,
    scopeId: string,
    actorUserId: string,
  ): Promise<Set<string>> {
    // Roots: every non-archived unit in this scope the actor leads.
    const roots = await this.prisma.accessUnit.findMany({
      where: { scopeType, scopeId, leaderUserId: actorUserId, archivedAt: null },
      select: { id: true },
    });
    const subtree = new Set<string>();
    if (!roots.length) return subtree;
    const queue: string[] = [];
    for (const r of roots) {
      subtree.add(r.id);
      queue.push(r.id);
    }
    let steps = 0;
    while (queue.length) {
      if (steps++ > MAX_GROUP_DEPTH * 1000) break; // failsafe
      const parentId = queue.shift()!;
      const children = await this.prisma.accessUnit.findMany({
        where: { scopeType, scopeId, parentId, archivedAt: null },
        select: { id: true },
      });
      for (const c of children) {
        if (subtree.has(c.id)) continue;
        subtree.add(c.id);
        queue.push(c.id);
      }
    }
    return subtree;
  }

  /**
   * Second-chance authz used AFTER {@link assertCanManageScope} denied. Grants the
   * operation iff the actor is a unit leader whose subtree contains the target
   * unit id(s). `targetUnitIds` are every unit that must be inside the subtree for
   * the op to be legal (for reparent: both the moved unit AND the new parent; for
   * create-child: the parent unit). Fail-closed: no led unit, or any target
   * outside the subtree ⇒ throw the ORIGINAL access error.
   */
  private async assertLeaderDelegation(
    scopeType: AccessGroupScopeType,
    scopeId: string,
    actorUserId: string,
    targetUnitIds: (string | null | undefined)[],
    denied: AppError,
  ): Promise<void> {
    // Delegation is an ORG-scope affordance only (project units gate on project
    // role manager+; no leader delegation there in v1).
    if (scopeType !== 'ORGANIZATION') throw denied;
    const targets = targetUnitIds.filter((t): t is string => !!t);
    // Nothing concrete to place inside a subtree ⇒ cannot delegate (e.g. a
    // top-level create with no parentId is an org-wide op, not a subtree op).
    if (!targets.length) throw denied;
    const subtree = await this.collectLeaderSubtree(scopeType, scopeId, actorUserId);
    if (!subtree.size) throw denied;
    for (const t of targets) {
      if (!subtree.has(t)) throw denied;
    }
  }

  /**
   * Full-rights check with the leader-delegation fallback. Runs the T4.1 PDP /
   * project-role gate first; on an access/auth denial, retries via
   * {@link assertLeaderDelegation} against `targetUnitIds`. Any non-access error
   * (invalid scope, etc.) propagates immediately.
   */
  private async assertManageOrLeader(
    scopeType: AccessGroupScopeType,
    scopeId: string,
    actorUserId: string | undefined,
    targetUnitIds: (string | null | undefined)[],
  ): Promise<void> {
    const actor = this.assertActor(actorUserId);
    try {
      await this.assertCanManageScope(scopeType, scopeId, actor);
    } catch (err) {
      if (err instanceof AppError && (err.errorCode === 'access' || err.errorCode === 'auth')) {
        await this.assertLeaderDelegation(scopeType, scopeId, actor, targetUnitIds, err);
        return;
      }
      throw err;
    }
  }

  /** M6.1 read-guard: any member of the scope may list groups. */
  private async assertMemberOfScope(
    scopeType: AccessGroupScopeType,
    scopeId: string,
    actorUserId: string | undefined,
  ): Promise<void> {
    const actor = this.assertActor(actorUserId);
    if (scopeType === 'ORGANIZATION') {
      const employee = await this.prisma.employee.findUnique({
        where: { organizationId_userId: { organizationId: scopeId, userId: actor } },
        select: { isActive: true },
      });
      // Fail-closed: a deactivated (offboarded) member is NOT a member (FR-ORG-490).
      if (!employee?.isActive) {
        throw new AppError('access', 'You are not a member of this organization');
      }
      return;
    }
    if (scopeType === 'PROJECT') {
      const member = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: scopeId, userId: actor } },
        select: { id: true },
      });
      if (!member) throw new AppError('access', 'You are not a member of this project');
      return;
    }
    throw new AppError('invalid', 'Unknown scope type');
  }

  private async loadUnit(id: string) {
    const unit = await this.prisma.accessUnit.findUnique({ where: { id } });
    if (!unit) throw new AppError('notFound', 'Access unit not found');
    return unit;
  }

  /** Scope of a unit (for cache-invalidation routing); null if it no longer exists. */
  async getUnitScope(id: string): Promise<{ scopeType: string; scopeId: string } | null> {
    const unit = await this.prisma.accessUnit.findUnique({
      where: { id },
      select: { scopeType: true, scopeId: true },
    });
    return unit ?? null;
  }

  /** M1.1: parent must live in the SAME scope as the child (no cross-scope tree). */
  private async assertParentInScope(
    parentId: string,
    scopeType: string,
    scopeId: string,
  ): Promise<void> {
    const parent = await this.prisma.accessUnit.findUnique({
      where: { id: parentId },
      select: { scopeType: true, scopeId: true },
    });
    if (!parent || parent.scopeType !== scopeType || parent.scopeId !== scopeId) {
      throw new AppError('invalid', 'Parent group is not in the same scope');
    }
  }

  /** parentId cycle guard (walk up): reject a parent that is the node or its descendant. */
  private async assertNoParentCycle(unitId: string, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    const guard = new Set<string>();
    let depth = 0;
    while (cursor) {
      if (cursor === unitId) {
        throw new AppError('invalid', 'Group cannot be its own ancestor');
      }
      if (guard.has(cursor) || depth++ > MAX_GROUP_DEPTH) break;
      guard.add(cursor);
      const node: { parentId: string | null } | null = await this.prisma.accessUnit.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = node?.parentId ?? null;
    }
  }

  /**
   * M3.1 composition cycle guard. Adding B into A creates a cycle iff A is
   * reachable from B by following composition (memberType=group) edges down.
   * DFS down from B; if we hit A → cycle.
   */
  private async assertNoCompositionCycle(
    containerId: string,
    memberGroupId: string,
  ): Promise<void> {
    if (containerId === memberGroupId) {
      throw new AppError('invalid', 'A group cannot contain itself');
    }
    const visited = new Set<string>();
    const stack = [memberGroupId];
    let steps = 0;
    while (stack.length) {
      if (steps++ > MAX_GROUP_DEPTH * 1000) break; // failsafe
      const current = stack.pop()!;
      if (current === containerId) {
        throw new AppError('invalid', 'Nesting these groups would create a cycle');
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const children = await this.prisma.accessUnitMember.findMany({
        where: { unitId: current, memberType: 'group' },
        select: { memberId: true },
      });
      for (const c of children) stack.push(c.memberId);
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async listUnits(
    scopeType: string,
    scopeId: string,
    actorUserId: string | undefined,
    includeArchived = false,
  ) {
    if (!isAccessGroupScopeType(scopeType)) throw new AppError('invalid', 'Invalid scope type');
    if (!scopeId) throw new AppError('invalid', 'scopeId required');
    await this.assertMemberOfScope(scopeType, scopeId, actorUserId);
    return this.prisma.accessUnit.findMany({
      where: {
        scopeType,
        scopeId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createUnit(
    input: {
      scopeType: string;
      scopeId: string;
      name: string;
      kind?: string;
      parentId?: string | null;
      leaderUserId?: string | null;
    },
    actorUserId: string | undefined,
  ) {
    if (!isAccessGroupScopeType(input.scopeType))
      throw new AppError('invalid', 'Invalid scope type');
    if (!input.scopeId) throw new AppError('invalid', 'scopeId required');
    if (!input.name?.trim()) throw new AppError('invalid', 'Group name required');
    const kind: AccessGroupKind = isAccessGroupKind(input.kind) ? input.kind : 'custom';
    // P8-T4.2: a leader may create a child unit INSIDE their subtree (parentId in
    // subtree); a top-level create (no parentId) stays owner/admin-only.
    await this.assertManageOrLeader(input.scopeType, input.scopeId, actorUserId, [input.parentId]);
    if (input.parentId) {
      await this.assertParentInScope(input.parentId, input.scopeType, input.scopeId);
    }
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.accessUnit.create({
        data: {
          id: newEntityId(),
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          name: input.name.trim(),
          kind,
          parentId: input.parentId || null,
          leaderUserId: input.leaderUserId || null,
        },
      });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actorUserId,
        'access_unit.created',
        unit.id,
        {
          name: unit.name,
          kind: unit.kind,
          parentId: unit.parentId,
          leaderUserId: unit.leaderUserId,
        },
      );
      return unit;
    });
  }

  async updateUnit(
    id: string,
    data: { name?: string; kind?: string; leaderUserId?: string | null },
    actorUserId: string | undefined,
  ) {
    const unit = await this.loadUnit(id);
    const actor = this.assertActor(actorUserId);
    // P8-T4.2: a leader may update (rename) a unit in their subtree, but NOT
    // reassign leadership — changing `leaderUserId` is an owner/admin affordance
    // (a leader must not hand their branch to someone else nor pin themselves as
    // leader of a sibling). So the leader-delegation fallback covers name/kind
    // only; a `leaderUserId` change requires the full org right.
    const changesLeader = data.leaderUserId !== undefined;
    if (
      changesLeader &&
      !(await this.hasManageScope(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor))
    ) {
      // Full right required, and it is absent → deny (do not fall to delegation).
      await this.assertCanManageScope(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor);
    } else {
      await this.assertManageOrLeader(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor, [
        id,
      ]);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessUnit.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name.trim() } : {}),
          ...(data.kind !== undefined && isAccessGroupKind(data.kind) ? { kind: data.kind } : {}),
          ...(data.leaderUserId !== undefined ? { leaderUserId: data.leaderUserId || null } : {}),
        },
      });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actorUserId,
        'access_unit.updated',
        id,
        {
          name: updated.name,
          kind: updated.kind,
          leaderUserId: updated.leaderUserId,
        },
      );
      return updated;
    });
  }

  /** SetUnitParent: re-parent along the structural hierarchy (parentId axis). */
  async setUnitParent(id: string, parentId: string | null, actorUserId: string | undefined) {
    const unit = await this.loadUnit(id);
    // P8-T4.2: a leader may reparent WITHIN their subtree — BOTH the moved unit and
    // the new parent must be inside it. Detaching to top-level (parentId=null) is
    // NOT delegated: it pulls the unit out from under its leader-rooted subtree, so
    // it requires the full org right. `NOT_DELEGATABLE` is a target no real unit id
    // can equal, forcing the fallback to deny for the detach case.
    const reparentTargets: (string | null)[] =
      parentId === null ? [id, AccessUnitService.NOT_DELEGATABLE] : [id, parentId];
    await this.assertManageOrLeader(
      unit.scopeType as AccessGroupScopeType,
      unit.scopeId,
      actorUserId,
      reparentTargets,
    );
    if (parentId) {
      await this.assertParentInScope(parentId, unit.scopeType, unit.scopeId);
      await this.assertNoParentCycle(id, parentId);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessUnit.update({
        where: { id },
        data: { parentId: parentId || null },
      });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actorUserId,
        'access_unit.reparented',
        id,
        {
          parentId: updated.parentId,
        },
      );
      return updated;
    });
  }

  async archiveUnit(id: string, archived: boolean, actorUserId: string | undefined) {
    const unit = await this.loadUnit(id);
    await this.assertCanManageScope(
      unit.scopeType as AccessGroupScopeType,
      unit.scopeId,
      actorUserId,
    );
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessUnit.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actorUserId,
        archived ? 'access_unit.archived' : 'access_unit.unarchived',
        id,
        null,
      );
      return updated;
    });
  }

  // ─── Membership ─────────────────────────────────────────────────────────────

  async listMembers(unitId: string, actorUserId: string | undefined) {
    const unit = await this.loadUnit(unitId);
    await this.assertMemberOfScope(
      unit.scopeType as AccessGroupScopeType,
      unit.scopeId,
      actorUserId,
    );
    return this.prisma.accessUnitMember.findMany({
      where: { unitId },
      orderBy: { addedAt: 'asc' },
    });
  }

  /** "Which units is this user in" (reverse lookup, indexed). */
  async listUnitsOfUser(
    scopeType: string,
    scopeId: string,
    userId: string,
    actorUserId: string | undefined,
  ) {
    if (!isAccessGroupScopeType(scopeType)) throw new AppError('invalid', 'Invalid scope type');
    await this.assertMemberOfScope(scopeType, scopeId, actorUserId);
    const memberships = await this.prisma.accessUnitMember.findMany({
      where: { memberType: 'user', memberId: userId },
      select: { unitId: true },
    });
    if (!memberships.length) return [];
    return this.prisma.accessUnit.findMany({
      where: {
        id: { in: memberships.map((m) => m.unitId) },
        scopeType,
        scopeId,
        archivedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(
    unitId: string,
    memberType: string,
    memberId: string,
    actorUserId: string | undefined,
  ) {
    if (!isAccessGroupMemberType(memberType)) {
      throw new AppError('invalid', 'memberType must be user or group');
    }
    if (!memberId) throw new AppError('invalid', 'memberId required');
    const actor = this.assertActor(actorUserId);
    const unit = await this.loadUnit(unitId);
    // M6.1 + P8-T4.2: manage on the container, OR the container is inside the
    // actor's led subtree.
    await this.assertManageOrLeader(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor, [
      unitId,
    ]);

    if (memberType === 'user') {
      // M6.2: no self-grant (cannot add yourself to a group you manage).
      if (memberId === actor) {
        throw new AppError('access', 'You cannot add yourself to a group');
      }
    } else {
      // memberType === 'group' — composition.
      const child = await this.prisma.accessUnit.findUnique({
        where: { id: memberId },
        select: { scopeType: true, scopeId: true },
      });
      if (!child) throw new AppError('notFound', 'Nested group not found');
      // M1.1: composition must stay within the same scope (no cross-scope nesting).
      if (child.scopeType !== unit.scopeType || child.scopeId !== unit.scopeId) {
        throw new AppError('invalid', 'Cannot nest a group from another scope');
      }
      // M6.4/B3 + P8-T4.2: composition-add requires manage on BOTH groups (or the
      // nested group is inside the actor's subtree — composition does NOT widen the
      // subtree itself, but the leader may nest a subtree unit under another).
      await this.assertManageOrLeader(
        child.scopeType as AccessGroupScopeType,
        child.scopeId,
        actor,
        [memberId],
      );
      // M3.1: composition cycle pre-check.
      await this.assertNoCompositionCycle(unitId, memberId);
    }

    const existing = await this.prisma.accessUnitMember.findFirst({
      where: { unitId, memberType, memberId },
      select: { id: true },
    });
    if (existing) {
      return this.prisma.accessUnitMember.findUniqueOrThrow({ where: { id: existing.id } });
    }
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.accessUnitMember.create({
        data: {
          id: newEntityId(),
          unitId,
          memberType,
          memberId,
          addedBy: actor,
        },
      });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actor,
        memberType === 'group' ? 'access_unit.composition.added' : 'access_unit.member.added',
        unitId,
        { memberType, memberId },
        memberType === 'group' ? 'access_unit_composition' : 'access_unit_member',
      );
      return member;
    });
  }

  async removeMember(
    unitId: string,
    memberType: string,
    memberId: string,
    actorUserId: string | undefined,
  ) {
    if (!isAccessGroupMemberType(memberType)) {
      throw new AppError('invalid', 'memberType must be user or group');
    }
    const actor = this.assertActor(actorUserId);
    const unit = await this.loadUnit(unitId);
    // M6.1 + P8-T4.2: manage on the container, OR it is inside the led subtree.
    await this.assertManageOrLeader(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor, [
      unitId,
    ]);
    await this.prisma.$transaction(async (tx) => {
      await tx.accessUnitMember.deleteMany({ where: { unitId, memberType, memberId } });
      await this.auditUnit(
        tx,
        unit.scopeType,
        unit.scopeId,
        actor,
        memberType === 'group' ? 'access_unit.composition.removed' : 'access_unit.member.removed',
        unitId,
        { memberType, memberId },
        memberType === 'group' ? 'access_unit_composition' : 'access_unit_member',
      );
    });
    return { ok: true };
  }

  // ─── Composition preview (§7.2 — expanded-member count BEFORE persisting) ─────

  /**
   * Preview the EFFECTIVE user count of a unit's composition, with the optional
   * `addGroupId` edge applied (§7.2). Pure computation — never mutates the graph.
   *
   * Mirrors {@link VisibilityResolverService.addEffectiveUsers} exactly: a BFS
   * down `memberType=group` edges with a per-node cross-scope hard-stop
   * (allowedScopeIds = { the unit's own scopeId }, M1.1/M2.2). Composition must
   * live in ONE scope, so in box cross-scope drops are normally 0 — but they are
   * counted honestly here so the UI can warn.
   *
   *  - current   = effective users at the CURRENT composition;
   *  - projected = effective users AFTER adding the unit→addGroupId edge;
   *  - added     = |projected \ current|;
   *  - crossScopeDropped = candidate's effective users that the hard-stop severs
   *    (a different-scope candidate contributes its WHOLE membership here and
   *    added=0 — it cannot legally be nested; a same-scope candidate contributes
   *    only the users reachable solely via a cross-scope 2nd+ hop).
   *
   * Authz: same gate as {@link addMember} — manage on the container OR the actor
   * leads the subtree (this preview is part of the composition-edit flow).
   */
  async previewComposition(params: {
    unitId: string;
    addGroupId?: string;
    actorUserId?: string;
  }): Promise<{
    currentUserCount: number;
    projectedUserCount: number;
    addedUserCount: number;
    crossScopeDropped: number;
  }> {
    const unitId = (params.unitId ?? '').trim();
    if (!unitId) throw new AppError('invalid', 'unitId required');
    const addGroupId = (params.addGroupId ?? '').trim() || undefined;
    const actor = this.assertActor(params.actorUserId);
    const unit = await this.loadUnit(unitId);
    await this.assertManageOrLeader(unit.scopeType as AccessGroupScopeType, unit.scopeId, actor, [
      unitId,
    ]);

    // Validate the candidate exists (a missing candidate is a client error, not a
    // silent 0). Its scope decides whether the edge can contribute at all.
    if (addGroupId) {
      const candidate = await this.prisma.accessUnit.findUnique({
        where: { id: addGroupId },
        select: { id: true, archivedAt: true },
      });
      if (!candidate || candidate.archivedAt) {
        throw new AppError('notFound', 'Candidate group not found');
      }
    }

    // Load the reachable group subgraph across scopes (so a cross-scope candidate's
    // membership can be counted for `crossScopeDropped`). archived units excluded,
    // matching the resolver's live-graph load.
    const seeds = addGroupId ? [unitId, addGroupId] : [unitId];
    const { membersByUnit, unitScope } = await this.loadReachableGraph(seeds);

    const allowed = new Set<string>([unit.scopeId]);

    const current = this.expandEffectiveUsers([unitId], null, membersByUnit, unitScope, allowed);
    const projected = addGroupId
      ? this.expandEffectiveUsers(
          [unitId],
          { unitId, childId: addGroupId },
          membersByUnit,
          unitScope,
          allowed,
        )
      : current;

    let addedUserCount = 0;
    for (const u of projected) if (!current.has(u)) addedUserCount++;

    // Cross-scope dropped: users reachable from the candidate ignoring the
    // hard-stop, MINUS those still reachable within the unit's scope.
    let crossScopeDropped = 0;
    if (addGroupId) {
      const candidateAll = this.expandEffectiveUsers(
        [addGroupId],
        null,
        membersByUnit,
        unitScope,
        null, // no hard-stop → full reach
      );
      const candidateInScope = this.expandEffectiveUsers(
        [addGroupId],
        null,
        membersByUnit,
        unitScope,
        allowed,
      );
      for (const u of candidateAll) if (!candidateInScope.has(u)) crossScopeDropped++;
    }

    return {
      currentUserCount: current.size,
      projectedUserCount: projected.size,
      addedUserCount,
      crossScopeDropped,
    };
  }

  /**
   * BFS over `memberType=group` edges collecting effective user ids. Local mirror
   * of {@link VisibilityResolverService.addEffectiveUsers} (M2.2 per-node
   * cross-scope hard-stop). `allowedScopeIds === null` disables the hard-stop
   * (used to measure what the hard-stop severs). `extraEdge` injects one virtual
   * unit→childId composition edge (the previewed add) without touching the DB.
   */
  private expandEffectiveUsers(
    seedUnitIds: string[],
    extraEdge: { unitId: string; childId: string } | null,
    membersByUnit: Map<string, { users: string[]; childGroups: string[] }>,
    unitScope: Map<string, string>,
    allowedScopeIds: Set<string> | null,
  ): Set<string> {
    const into = new Set<string>();
    const visited = new Set<string>();
    const queue = [...seedUnitIds];
    const maxNodes = unitScope.size * (MAX_GROUP_DEPTH + 1) + 8; // failsafe
    let steps = 0;
    while (queue.length) {
      if (steps++ > maxNodes) break;
      const unitId = queue.shift()!;
      if (visited.has(unitId)) continue;
      visited.add(unitId);
      const scope = unitScope.get(unitId);
      if (scope === undefined) continue; // dangling id (R7-tolerant)
      // Per-node cross-scope hard-stop (also drops dangling ids).
      if (allowedScopeIds && !allowedScopeIds.has(scope)) continue;
      const bucket = membersByUnit.get(unitId);
      if (!bucket) continue;
      for (const u of bucket.users) into.add(u);
      const children = [...bucket.childGroups];
      if (extraEdge && unitId === extraEdge.unitId) children.push(extraEdge.childId);
      for (const child of children) {
        if (!visited.has(child)) queue.push(child);
      }
    }
    return into;
  }

  /**
   * Load the group subgraph reachable from `seedIds` by following composition
   * (`memberType=group`) edges, across scopes (bounded by MAX_GROUP_DEPTH). Only
   * non-archived units are materialized (an archived unit severs its branch, same
   * as the resolver). Returns per-unit member buckets + a unit→scopeId map.
   */
  private async loadReachableGraph(seedIds: string[]): Promise<{
    membersByUnit: Map<string, { users: string[]; childGroups: string[] }>;
    unitScope: Map<string, string>;
  }> {
    const membersByUnit = new Map<string, { users: string[]; childGroups: string[] }>();
    const unitScope = new Map<string, string>();
    const requested = new Set<string>();
    let frontier = seedIds.filter((id): id is string => !!id);
    let rounds = 0;
    while (frontier.length) {
      if (rounds++ > MAX_GROUP_DEPTH + 4) break; // failsafe
      const toLoad = frontier.filter((id) => !requested.has(id));
      if (!toLoad.length) break;
      for (const id of toLoad) requested.add(id);
      const units = await this.prisma.accessUnit.findMany({
        where: { id: { in: toLoad }, archivedAt: null },
        select: { id: true, scopeId: true },
      });
      const foundIds = units.map((u) => u.id);
      for (const u of units) {
        unitScope.set(u.id, u.scopeId);
        membersByUnit.set(u.id, { users: [], childGroups: [] });
      }
      const members = foundIds.length
        ? await this.prisma.accessUnitMember.findMany({
            where: { unitId: { in: foundIds } },
            select: { unitId: true, memberType: true, memberId: true },
          })
        : [];
      const next: string[] = [];
      for (const m of members) {
        const bucket = membersByUnit.get(m.unitId);
        if (!bucket) continue;
        if (m.memberType === 'group') {
          bucket.childGroups.push(m.memberId);
          if (!requested.has(m.memberId)) next.push(m.memberId);
        } else {
          bucket.users.push(m.memberId);
        }
      }
      frontier = next;
    }
    return { membersByUnit, unitScope };
  }

  /**
   * Audit helper. Org-scope writes the OrgAuditLog (which requires an
   * organizationId); project-scope groups have no org row, so the audit is
   * skipped here (project-level audit lands in the project audit trail / E2-10).
   */
  private async auditUnit(
    tx: Prisma.TransactionClient,
    scopeType: string,
    scopeId: string,
    actorUserId: string | undefined,
    action: string,
    entityId: string,
    metadata: Record<string, unknown> | null,
    entityType: 'access_unit' | 'access_unit_member' | 'access_unit_composition' = 'access_unit',
  ): Promise<void> {
    if (scopeType !== 'ORGANIZATION') return;
    await this.audit.record(
      {
        organizationId: scopeId,
        actorUserId,
        action,
        entityType,
        entityId,
        metadata,
      },
      tx,
    );
  }
}
