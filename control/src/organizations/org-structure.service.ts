import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { newEntityId, isOrgRole } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { DepartmentBindingsService } from './department-bindings.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { UserDirectoryService } from '../user-directory/user-directory.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import type { Prisma } from '../generated/prisma';

/**
 * Org structure: employees + departments (business-process spec §14).
 * Revives the previously-dormant Department / Employee tables.
 *
 * Authorization (fail-closed PEP — contract control.md §1 S-1/M-1): every
 * end-user call carries `actorUserId` (the gateway propagates x-user-id from the
 * verified JWT). An empty `actorUserId` is NOT "skip the check" — it means the
 * caller is unauthenticated and the request is rejected. Org gRPC methods are
 * only ever reached through the gateway; direct service/seed writes go via Prisma
 * (prisma/seed.ts), never through these methods, so no s2s bypass is needed here.
 */
@Injectable()
export class OrgStructureService {
  private readonly logger = new Logger(OrgStructureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrgAuditService))
    private readonly audit: OrgAuditService,
    private readonly seats: SeatsService,
    private readonly pdp: OrgPdpService,
    @Inject(forwardRef(() => DepartmentBindingsService))
    private readonly bindings: DepartmentBindingsService,
    private readonly epoch: ProjectAccessEpochService,
    private readonly directory: UserDirectoryService,
    private readonly events: ControlEventEmitter,
  ) {}

  // ─── FR-MORG-11 binding-membership hooks ──────────────────────────────────
  // These recompute a single employee's binding-derived project memberships in
  // the SAME transaction as the employee mutation (materialization atomic with
  // the Employee row, FR-MORG-25). `source='manual'` memberships are untouched.
  // The touched project ids are collected so the caller can invalidate the
  // gateway permission cache (FR-MORG-31) after the transaction commits.

  /** Hire / transfer-in: materialize members for the new department's bindings. */
  private async bindingMembershipOnJoin(
    tx: Prisma.TransactionClient,
    userId: string,
    departmentId: string | null | undefined,
  ): Promise<string[]> {
    return this.bindings.bindingMembershipAddEmployee(tx, userId, departmentId);
  }

  /** Transfer-out / offboard: drop members produced by the old department. */
  private async bindingMembershipOnLeave(
    tx: Prisma.TransactionClient,
    userId: string,
    departmentId: string | null | undefined,
  ): Promise<string[]> {
    return this.bindings.bindingMembershipRemoveEmployee(tx, userId, departmentId);
  }

  /** Best-effort epoch bump for every touched project (after commit). */
  private async bindingMembershipInvalidate(projectIds: string[]): Promise<void> {
    for (const projectId of [...new Set(projectIds)]) await this.epoch.bump(projectId);
  }

  /**
   * BX-OFFB offboarding access revocation (security HIGH / 152-ФЗ). Unlike the
   * binding-only `bindingMembershipOnLeave` (drops just `source='binding'` rows,
   * leaving manual memberships), a DEPARTING employee loses ALL project access:
   * every ProjectMember row (manual AND binding) in the org's projects, plus
   * their project-scoped `RoleAssignment`s and member-addressed `PermissionGrant`s.
   * Runs inside the offboard transaction; returns the touched project ids so the
   * caller can bump the gateway permission-cache epoch after commit. Org-scoped
   * SYSTEM-role assignments are cleared separately (`clearEmployeeSystemRoleAssignments`).
   */
  private async revokeAllProjectAccess(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ): Promise<string[]> {
    const memberships = await tx.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    if (memberships.length === 0) return [];
    // DEORG-W1: box is single-tenant and there is no personal vector — every
    // project is owned by the System. Stay scoped to the system anchor.
    const orgProjects = await tx.project.findMany({
      where: {
        id: { in: memberships.map((m) => m.projectId) },
        ownerId: organizationId,
      },
      select: { id: true },
    });
    const projectIds = orgProjects.map((p) => p.id);
    if (projectIds.length === 0) return [];
    // FR-ACCESS-150: offboarding must not orphan a project — block when the leaver
    // is the sole owner of any scoped project (same LAST_OWNER invariant as removeMember).
    for (const projectId of projectIds) {
      const membership = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      });
      if (membership?.role !== 'owner') continue;
      const owners = await tx.projectMember.count({ where: { projectId, role: 'owner' } });
      if (owners <= 1) {
        throw new AppError('locked', 'Cannot offboard the last owner of a project', {
          code: 'LAST_OWNER',
          projectId,
        });
      }
    }
    await tx.projectMember.deleteMany({ where: { userId, projectId: { in: projectIds } } });
    await tx.roleAssignment.deleteMany({
      where: { projectId: { in: projectIds }, subjectType: 'user', subjectId: userId },
    });
    await tx.permissionGrant.deleteMany({
      where: { projectId: { in: projectIds }, granteeType: 'member', granteeId: userId },
    });
    return projectIds;
  }

  /**
   * Post-commit session revocation for an offboarded user (BX-OFFB). Fail-soft:
   * `revokeSessions` never throws (returns `null` when auth is down), so a failure
   * only delays JWT invalidation to the token TTL — it never rolls back the
   * offboard. Mirrors the transferOwnership / org-deactivate session cascade.
   */
  private async revokeOffboardedSessions(organizationId: string, userId: string): Promise<void> {
    const revoked = await this.directory.revokeSessions([userId]);
    if (revoked === null) {
      this.logger.warn(
        `Employee ${userId} offboarded in org ${organizationId} but session revocation failed — ` +
          `auth down/timeout; the JWT stays valid until its TTL.`,
      );
    }
  }

  /**
   * BX-OFFB-2: resolve the active member the offboarded user's CRM records are
   * reassigned to. Prefers the caller-chosen target, but only when it is an
   * ACTIVE employee of this org and not the leaver themselves; otherwise falls
   * back to the acting admin (the safe single-tenant default). Returns '' when
   * no valid target exists (e.g. self-offboard with no pick) — then no
   * reassignment event is emitted and records keep their (now-inactive) owner.
   */
  private async resolveReassignTarget(
    tx: Prisma.TransactionClient,
    organizationId: string,
    departingUserId: string,
    actorUserId: string | undefined,
    reassignToUserId: string | undefined,
  ): Promise<string> {
    const picked = (reassignToUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    for (const cand of [picked, actor]) {
      if (!cand || cand === departingUserId) continue;
      const emp = await tx.employee.findUnique({
        where: { organizationId_userId: { organizationId, userId: cand } },
        select: { isActive: true },
      });
      if (emp?.isActive) return cand;
    }
    return '';
  }

  /**
   * BX-OFFB-2: emit one `control.member.offboarded` per org-project the leaver
   * held, INSIDE the offboard transaction (atomic with access revocation via the
   * control outbox). Each event is project-scoped so a CRM domain consumer
   * reassigns only that project's records to `toUserId`. Empty target / no
   * projects → no-op. `offboardTs` is stamped once so the domains' per-record
   * event idempotency keys stay stable across an at-least-once redelivery.
   */
  private async emitOffboardReassignment(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      departingUserId: string;
      actorUserId?: string;
      toUserId: string;
      projectIds: string[];
      departmentId?: string | null;
    },
  ): Promise<void> {
    if (!input.toUserId || input.projectIds.length === 0) return;
    const departmentId = (input.departmentId ?? '').trim() || null;
    let departmentLeaderUserId: string | null = null;
    if (departmentId) {
      const dept = await tx.department.findUnique({
        where: { id: departmentId },
        select: { leaderUserId: true },
      });
      departmentLeaderUserId = (dept?.leaderUserId ?? '').trim() || null;
    }
    const offboardTs = Date.now();
    for (const projectId of input.projectIds) {
      // FR-ACCESS-390: reassignment target must be a member of THIS project — skip
      // projects where the chosen recipient has no membership (fail-soft per project).
      const recipient = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: input.toUserId } },
        select: { userId: true },
      });
      if (!recipient) continue;
      await this.events.emit(tx, {
        routingKey: 'control.member.offboarded',
        idempotencyKey: `member.offboarded:${input.departingUserId}:${projectId}:${offboardTs}`,
        organizationId: input.organizationId,
        projectId,
        actorUserId: input.actorUserId ?? null,
        entityType: 'employee',
        entityId: input.departingUserId,
        action: 'employee.offboarded',
        metadata: {
          departingUserId: input.departingUserId,
          reassignToUserId: input.toUserId,
          offboardTs,
          departmentId,
          departmentLeaderUserId,
        },
      });
    }
  }

  /** Fail-closed: a missing requester identity is treated as unauthenticated. */
  private assertActor(actorUserId: string | undefined): string {
    const actor = (actorUserId ?? '').trim();
    if (!actor) {
      throw new AppError('auth', 'Authentication required');
    }
    return actor;
  }

  /** Public membership gate (read-level) for sibling read endpoints (e.g. seats). */
  async assertOrgMember(organizationId: string, actorUserId: string | undefined) {
    await this.assertMember(organizationId, actorUserId);
  }

  /**
   * P8-T3.1 (defense-in-depth): thin membership/role lookup for the gateway
   * OrgAccessGuard. Unlike assertMember/assertCanManage this does NOT throw on
   * non-membership — it returns `{ role: '', isMember: false }` so the guard can
   * distinguish a plain deny (no membership / insufficient role) from a control
   * outage (transport error → fail-closed 503). An empty actor is still rejected
   * (unauthenticated). Single indexed PK lookup, no side effects.
   */
  async getRole(
    organizationId: string,
    actorUserId: string | undefined,
  ): Promise<{ role: string; isMember: boolean; isActive: boolean }> {
    const actor = this.assertActor(actorUserId);
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: actor } },
      select: { role: true, isActive: true },
    });
    if (!employee) return { role: '', isMember: false, isActive: false };
    const system = await this.prisma.systemSettings.findUnique({
      where: { id: organizationId },
      select: { isActive: true },
    });
    if (!system?.isActive) {
      return { role: employee.role, isMember: true, isActive: false };
    }
    return { role: employee.role, isMember: true, isActive: employee.isActive };
  }

  /**
   * chat (M-CHAT-12, B-3): resolve whether `peerUserIds` share the actor's
   * communication boundary so a DM/group may be created / @mentions delivered
   * (FR-CHAT-50/30). Two modes:
   *  - corporate (`organizationId` set): the actor MUST be an active employee;
   *    every peer must also be an active employee of the SAME organization.
   *    Peers outside the org are returned in `deniedUserIds` (cross-org deny).
   *  - individual (`workspaceId` set, no org): isolation is the personal
   *    workspace. There is no shared workspace-membership store yet, so the only
   *    safe peer is the actor themselves (self-notes); other peers are denied
   *    until an individual-mode contact graph exists. Never widens the boundary.
   *
   * The boundary is always taken from TRUSTED metadata (org/workspace id), never
   * inferred from the peer list — a caller cannot smuggle a wider scope.
   */
  async resolveCommunicationScope(input: {
    actorUserId: string;
    peerUserIds: string[];
    organizationId?: string;
    workspaceId?: string;
    projectId?: string;
  }): Promise<{
    allowed: boolean;
    scopeKind: 'org' | 'workspace';
    scopeId: string;
    deniedUserIds: string[];
  }> {
    const actor = this.assertActor(input.actorUserId);
    const peers = [...new Set((input.peerUserIds ?? []).filter((p) => p && p !== actor))];

    // Boundary resolved SERVER-SIDE from the (already access-guarded) project — the
    // client never asserts the org. DEORG-W1: box is single-tenant, every project is
    // owned by the System, so the boundary is always the system anchor (project
    // owner). Explicit org/workspace metadata (legacy / non-project callers) still
    // wins when present; the workspace fallback only serves non-project callers.
    let organizationId = input.organizationId;
    const workspaceId = input.workspaceId;
    if (!organizationId && !workspaceId && input.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { ownerId: true },
      });
      if (project) organizationId = project.ownerId;
    }

    if (organizationId) {
      const orgId = organizationId;
      // Actor must be an active member; otherwise the whole request is denied.
      const actorEmp = await this.prisma.employee.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: actor } },
        select: { isActive: true },
      });
      if (!actorEmp?.isActive) {
        return { allowed: false, scopeKind: 'org', scopeId: orgId, deniedUserIds: peers };
      }
      if (peers.length === 0) {
        return { allowed: true, scopeKind: 'org', scopeId: orgId, deniedUserIds: [] };
      }
      const members = await this.prisma.employee.findMany({
        where: { organizationId: orgId, userId: { in: peers }, isActive: true },
        select: { userId: true },
      });
      const inOrg = new Set(members.map((m) => m.userId));
      const denied = peers.filter((p) => !inOrg.has(p));
      return {
        allowed: denied.length === 0,
        scopeKind: 'org',
        scopeId: orgId,
        deniedUserIds: denied,
      };
    }

    // Individual mode: personal workspace boundary.
    const wsId = workspaceId || actor;
    const denied = peers; // no cross-user individual graph yet → deny non-self peers
    return {
      allowed: denied.length === 0,
      scopeKind: 'workspace',
      scopeId: wsId,
      deniedUserIds: denied,
    };
  }

  private async assertMember(organizationId: string, actorUserId: string | undefined) {
    const actor = this.assertActor(actorUserId);
    const system = await this.prisma.systemSettings.findUnique({
      where: { id: organizationId },
      select: { isActive: true },
    });
    if (!system?.isActive) {
      throw new AppError('access', 'System is deactivated');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: actor } },
      select: { isActive: true },
    });
    // Fail-closed: a deactivated (offboarded) member is NOT a member (FR-ORG-490).
    if (!employee?.isActive) {
      throw new AppError('access', 'You are not a member of this organization');
    }
  }

  /**
   * P8-T4.1: gate a mutation on a CONCRETE org-structure subject through the PDP
   * (org:employees / org:departments / …) instead of the old binary
   * `orgRoleCanManage`. Default behaviour is preserved — owner/admin carry every
   * `:manage` key, `employee` carries none — while a custom org role can now grant
   * manage of one subject without another (HR = employees, not departments). The
   * outward error code/message is unchanged (access / "owner or admin").
   */
  private async assertCanManage(
    organizationId: string,
    actorUserId: string | undefined,
    subject: string,
  ) {
    const actor = this.assertActor(actorUserId);
    if (!(await this.pdp.canManage(organizationId, actor, subject))) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }
  }

  /** Normalize an org role; never let add/update mint a second platform_owner. */
  private normalizeRole(role: string | undefined): string {
    if (!isOrgRole(role) || role === 'platform_owner') return 'employee';
    return role;
  }

  // ─── Employees ──────────────────────────────────────────────────────────

  async listEmployees(organizationId: string, actorUserId?: string) {
    await this.assertMember(organizationId, actorUserId);
    return this.prisma.employee.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * FR-ORG-150: PII-safe colleague roster for any active member. Returns only
   * structural fields (department, manager); identity (name/avatar/position) is
   * enriched on the gateway from auth WITHOUT forwarding email/phone.
   */
  async listColleagueDirectory(organizationId: string, actorUserId?: string) {
    await this.assertMember(organizationId, actorUserId);
    const employees = await this.prisma.employee.findMany({
      where: { organizationId, isActive: true },
      select: { userId: true, departmentId: true },
      orderBy: { createdAt: 'asc' },
    });
    const deptIds = [
      ...new Set(employees.map((e) => e.departmentId).filter((id): id is string => Boolean(id))),
    ];
    const departments =
      deptIds.length > 0
        ? await this.prisma.department.findMany({
            where: { id: { in: deptIds } },
            select: { id: true, name: true, leaderUserId: true },
          })
        : [];
    const deptById = new Map(departments.map((d) => [d.id, d]));
    return employees.map((e) => {
      const dept = e.departmentId ? deptById.get(e.departmentId) : undefined;
      return {
        userId: e.userId,
        departmentId: e.departmentId ?? '',
        departmentName: dept?.name ?? '',
        managerUserId: dept?.leaderUserId ?? '',
      };
    });
  }

  async addEmployee(
    organizationId: string,
    userId: string,
    role: string | undefined,
    departmentId: string | undefined,
    actorUserId?: string,
  ) {
    if (!userId) throw new AppError('invalid', 'userId required');
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    // TODO-420: only AFTER the permission gate — the directory lookup must not be
    // a user-existence oracle for callers who cannot manage employees anyway.
    const resolved = await this.directory.resolve([userId]);
    if (!resolved.has(userId)) {
      throw new AppError('notFound', 'User not found');
    }
    if (departmentId) await this.assertDepartmentInOrg(departmentId, organizationId);
    await this.pdp.ensureSystemOrgRoles(organizationId).catch(() => undefined);
    // FR-MORG-23: seat check + the seat-taking write share one transaction so two
    // parallel adds at total-used==1 cannot both succeed. A seat is taken only when
    // the (new or reactivated) employee ends up active; updating an already-active
    // employee does not consume an extra seat.
    const { employee, touchedProjects } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.employee.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { isActive: true, departmentId: true },
      });
      const willConsumeSeat = !existing || existing.isActive === false;
      if (willConsumeSeat) {
        await this.seats.assertSeatAvailable(organizationId, () =>
          tx.employee.count({ where: { organizationId, isActive: true } }),
        );
      }
      const created = await tx.employee.upsert({
        where: { organizationId_userId: { organizationId, userId } },
        create: {
          id: newEntityId(),
          organizationId,
          userId,
          role: this.normalizeRole(role),
          departmentId: departmentId || null,
          isActive: true,
        },
        update: {
          role: this.normalizeRole(role),
          isActive: true,
          ...(departmentId !== undefined ? { departmentId: departmentId || null } : {}),
        },
      });
      // FR-MORG-11: recompute binding memberships. On a fresh hire / reactivation
      // there is nothing to remove; on a dept change of an active employee the old
      // dept's binding-members are dropped first, then the new dept's added.
      const touched: string[] = [];
      const oldDept = existing?.isActive ? (existing.departmentId ?? null) : null;
      const newDept = created.departmentId ?? null;
      if (oldDept !== newDept) {
        touched.push(...(await this.bindingMembershipOnLeave(tx, userId, oldDept)));
      }
      touched.push(...(await this.bindingMembershipOnJoin(tx, userId, newDept)));
      // W7: keep the system-role assignment in lock-step with Employee.role in the
      // SAME transaction (dual-source consistency). No-op until roles are provisioned.
      await this.pdp.syncEmployeeRoleAssignment(
        tx,
        organizationId,
        userId,
        created.role,
        actorUserId ?? '',
      );
      // Chained audit in the SAME transaction as the seat-taking write (T5.1).
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'employee.added',
          entityType: 'employee',
          entityId: userId,
          metadata: { role: created.role, departmentId: created.departmentId },
        },
        tx,
      );
      return { employee: created, touchedProjects: touched };
    });
    this.seats.invalidate(organizationId);
    await this.bindingMembershipInvalidate(touchedProjects);
    return employee;
  }

  async updateEmployee(
    organizationId: string,
    userId: string,
    data: { role?: string; departmentId?: string | null },
    actorUserId?: string,
  ) {
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    const existing = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, departmentId: true, isActive: true },
    });
    if (!existing) throw new AppError('notFound', 'Employee not found');
    // Never demote the platform_owner via this path.
    if (existing.role === 'platform_owner' && data.role && data.role !== 'platform_owner') {
      throw new AppError('invalid', 'Cannot change the role of the organization owner');
    }
    if (data.departmentId) await this.assertDepartmentInOrg(data.departmentId, organizationId);
    await this.pdp.ensureSystemOrgRoles(organizationId).catch(() => undefined);
    const { employee, touchedProjects } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: {
          ...(data.role !== undefined && existing.role !== 'platform_owner'
            ? { role: this.normalizeRole(data.role) }
            : {}),
          ...(data.departmentId !== undefined ? { departmentId: data.departmentId || null } : {}),
        },
      });
      // FR-MORG-11: a department change transfers binding memberships. Only an
      // active employee holds materialized memberships to move.
      const touched: string[] = [];
      const oldDept = existing.departmentId ?? null;
      const newDept = updated.departmentId ?? null;
      if (existing.isActive && data.departmentId !== undefined && oldDept !== newDept) {
        touched.push(...(await this.bindingMembershipOnLeave(tx, userId, oldDept)));
        touched.push(...(await this.bindingMembershipOnJoin(tx, userId, newDept)));
      }
      // W7: role may have changed → re-point the system-role assignment atomically
      // so the dual-source (floor ↔ assignment) never diverges.
      await this.pdp.syncEmployeeRoleAssignment(
        tx,
        organizationId,
        userId,
        updated.role,
        actorUserId ?? '',
      );
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'employee.updated',
          entityType: 'employee',
          entityId: userId,
          metadata: {
            from: { role: existing.role },
            to: { role: updated.role, departmentId: updated.departmentId },
          },
        },
        tx,
      );
      return { employee: updated, touchedProjects: touched };
    });
    await this.bindingMembershipInvalidate(touchedProjects);
    return employee;
  }

  /**
   * Transfer organization ownership (single-tenant box). Atomic hand-off: the
   * current `platform_owner` becomes `platform_admin` and the target ACTIVE
   * member becomes the new `platform_owner` — both role writes AND both PDP
   * system-role re-points happen in ONE transaction, so the org never has zero
   * or two owners even under a crash mid-swap.
   *
   * Owner-only: only the current owner may hand off (fail-closed here; the
   * gateway `@RequireOrgRole('manage')` gate is a defense-in-depth peer, not a
   * replacement — mirrors OrganizationsService.setActive). After the tx commits,
   * two fail-soft cascades run OUTSIDE it (the swap is already durable): (1) bump
   * the org's project access epochs so the gateway re-resolves any cached access
   * decisions; (2) revoke both users' auth sessions so the demoted/promoted org
   * role is re-minted into their JWT on next sign-in (matches the org-deactivate
   * cascade). Returns the new owner's Employee row.
   */
  async transferOwnership(organizationId: string, newOwnerUserId: string, actorUserId?: string) {
    const actor = this.assertActor(actorUserId);
    if (!newOwnerUserId) throw new AppError('invalid', 'newOwnerUserId required');
    if (newOwnerUserId === actor) {
      throw new AppError('invalid', 'You are already the owner of this organization');
    }
    // Owner-only: the caller must currently BE the org's active platform_owner.
    const actorEmp = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: actor } },
      select: { role: true, isActive: true },
    });
    if (actorEmp?.role !== 'platform_owner' || actorEmp.isActive === false) {
      throw new AppError('access', 'Only the organization owner can transfer ownership');
    }
    // Target must be an active member of the same organization.
    const target = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: newOwnerUserId } },
      select: { isActive: true },
    });
    if (!target) {
      throw new AppError('notFound', 'The new owner must be a member of this organization');
    }
    if (target.isActive === false) {
      throw new AppError('invalid', 'The new owner must be an active member of this organization');
    }

    const newOwner = await this.prisma.$transaction(async (tx) => {
      // Old owner → admin (never leave the org owner-less).
      await tx.employee.update({
        where: { organizationId_userId: { organizationId, userId: actor } },
        data: { role: 'platform_admin' },
      });
      // Target → new owner.
      const updated = await tx.employee.update({
        where: { organizationId_userId: { organizationId, userId: newOwnerUserId } },
        data: { role: 'platform_owner' },
      });
      // W7: keep BOTH users' system-role assignments in lock-step with the new
      // Employee.role in the same transaction (dual-source consistency).
      await this.pdp.syncEmployeeRoleAssignment(tx, organizationId, actor, 'platform_admin', actor);
      await this.pdp.syncEmployeeRoleAssignment(
        tx,
        organizationId,
        newOwnerUserId,
        'platform_owner',
        actor,
      );
      await this.audit.record(
        {
          organizationId,
          actorUserId: actor,
          action: 'organization.ownership_transferred',
          entityType: 'organization',
          entityId: organizationId,
          metadata: {
            from: { ownerUserId: actor },
            to: { ownerUserId: newOwnerUserId },
          },
        },
        tx,
      );
      return updated;
    });

    // Fail-soft cascades (post-commit): epoch bump + session revocation. Neither
    // rolls back the swap; a failure only delays cache/JWT refresh to TTL.
    await this.epoch.bumpOrgProjects(organizationId);
    const revoked = await this.directory.revokeSessions([actor, newOwnerUserId]);
    if (revoked === null) {
      this.logger.warn(
        `Ownership of org ${organizationId} transferred but session revocation failed — auth unreachable; roles refresh on token TTL.`,
      );
    }
    return newOwner;
  }

  /**
   * Offboard (FR-MORG-23/27/43, spec §3.4): soft-delete. The row is kept (audit /
   * history / reactivation) but the seat is freed (isActive=false). The
   * platform_owner can never be offboarded (→ 423 cannot_remove_owner).
   */
  async removeEmployee(
    organizationId: string,
    userId: string,
    actorUserId?: string,
    reassignToUserId?: string,
  ) {
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    const existing = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, isActive: true, departmentId: true },
    });
    if (!existing) return { ok: true };
    if (existing.role === 'platform_owner') {
      throw new AppError('locked', 'Cannot remove the organization owner', {
        reason: 'CANNOT_REMOVE_OWNER',
      });
    }
    const touchedProjects = await this.prisma.$transaction(async (tx) => {
      if (existing.isActive) {
        await tx.employee.update({
          where: { organizationId_userId: { organizationId, userId } },
          data: { isActive: false },
        });
      }
      // BX-OFFB: offboarding revokes ALL project access (manual + binding), not
      // just binding-derived — the departed member must lose every project.
      const touched = await this.revokeAllProjectAccess(tx, organizationId, userId);
      // W7: freeing the seat also drops the system-role assignment (the assignment
      // layer tracks active membership); the Employee.role floor stays for audit.
      await this.pdp.clearEmployeeSystemRoleAssignments(tx, organizationId, userId);
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'employee.removed',
          entityType: 'employee',
          entityId: userId,
          metadata: { departmentId: existing.departmentId, revokedProjects: touched.length },
        },
        tx,
      );
      // BX-OFFB-2: reassign the leaver's CRM records to an active responsible
      // (same eventual cascade as deactivateEmployee).
      const toUserId = await this.resolveReassignTarget(
        tx,
        organizationId,
        userId,
        actorUserId,
        reassignToUserId,
      );
      await this.emitOffboardReassignment(tx, {
        organizationId,
        departingUserId: userId,
        actorUserId,
        toUserId,
        projectIds: touched,
        departmentId: existing.departmentId,
      });
      return touched;
    });
    if (existing.isActive) this.seats.invalidate(organizationId);
    await this.bindingMembershipInvalidate(touchedProjects);
    // BX-OFFB: kill the departed member's live auth sessions (fail-soft).
    await this.revokeOffboardedSessions(organizationId, userId);
    return { ok: true };
  }

  /**
   * Offboard wizard endpoint (FR-MORG-43, OQ-MORG-5): explicit deactivation.
   * Same effect as removeEmployee (soft-delete + free seat) but named for the
   * lifecycle UI; emits `employee.deactivated` audit. Owner is protected.
   */
  async deactivateEmployee(
    organizationId: string,
    userId: string,
    actorUserId?: string,
    reassignToUserId?: string,
  ) {
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    const existing = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, isActive: true, departmentId: true },
    });
    if (!existing) throw new AppError('notFound', 'Employee not found');
    if (existing.role === 'platform_owner') {
      throw new AppError('locked', 'Cannot deactivate the organization owner', {
        reason: 'CANNOT_REMOVE_OWNER',
      });
    }
    const { employee, touchedProjects } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { isActive: false },
      });
      // BX-OFFB: deactivation revokes ALL project access (manual + binding) — the
      // offboarded member loses every project, not just binding-derived ones.
      const touched = await this.revokeAllProjectAccess(tx, organizationId, userId);
      // W7: drop the system-role assignment alongside freeing the seat.
      await this.pdp.clearEmployeeSystemRoleAssignments(tx, organizationId, userId);
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'employee.deactivated',
          entityType: 'employee',
          entityId: userId,
          metadata: { departmentId: existing.departmentId, revokedProjects: touched.length },
        },
        tx,
      );
      // BX-OFFB-2: hand the leaver's CRM records to an active responsible via the
      // eventual bus cascade (one project-scoped event per revoked project).
      const toUserId = await this.resolveReassignTarget(
        tx,
        organizationId,
        userId,
        actorUserId,
        reassignToUserId,
      );
      await this.emitOffboardReassignment(tx, {
        organizationId,
        departingUserId: userId,
        actorUserId,
        toUserId,
        projectIds: touched,
        departmentId: existing.departmentId,
      });
      return { employee: updated, touchedProjects: touched };
    });
    this.seats.invalidate(organizationId);
    await this.bindingMembershipInvalidate(touchedProjects);
    // BX-OFFB: kill the departed member's live auth sessions (fail-soft).
    await this.revokeOffboardedSessions(organizationId, userId);
    return employee;
  }

  /**
   * Reactivate a previously offboarded employee (OQ-MORG-5). Re-takes a seat, so
   * it is seat-gated (FR-MORG-24): if the org is at its quota → 402 seat_limit.
   */
  async reactivateEmployee(organizationId: string, userId: string, actorUserId?: string) {
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    const { employee, touchedProjects } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.employee.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { isActive: true, departmentId: true },
      });
      if (!existing) throw new AppError('notFound', 'Employee not found');
      if (!existing.isActive) {
        await this.seats.assertSeatAvailable(organizationId, () =>
          tx.employee.count({ where: { organizationId, isActive: true } }),
        );
      }
      const updated = await tx.employee.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { isActive: true },
      });
      // FR-MORG-11: reactivation re-materializes the department's binding members.
      const touched = existing.isActive
        ? []
        : await this.bindingMembershipOnJoin(tx, userId, updated.departmentId);
      // W7: re-take the seat → re-instate the system-role assignment for the
      // (unchanged) Employee.role.
      await this.pdp.syncEmployeeRoleAssignment(
        tx,
        organizationId,
        userId,
        updated.role,
        actorUserId ?? '',
      );
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'employee.reactivated',
          entityType: 'employee',
          entityId: userId,
        },
        tx,
      );
      return { employee: updated, touchedProjects: touched };
    });
    await this.bindingMembershipInvalidate(touchedProjects);
    this.seats.invalidate(organizationId);
    return employee;
  }

  // ─── Departments ────────────────────────────────────────────────────────

  private async assertDepartmentInOrg(departmentId: string, organizationId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { organizationId: true },
    });
    if (!dept || dept.organizationId !== organizationId) {
      throw new AppError('invalid', 'Department does not belong to this organization');
    }
  }

  /** Reject a parent that would create a cycle (parent is the node or its descendant). */
  private async assertNoCycle(departmentId: string, parentId: string) {
    let cursor: string | null = parentId;
    const guard = new Set<string>();
    while (cursor) {
      if (cursor === departmentId) {
        throw new AppError('invalid', 'Department cannot be its own ancestor');
      }
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const node: { parentId: string | null } | null = await this.prisma.department.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = node?.parentId ?? null;
    }
  }

  async listDepartments(organizationId: string, actorUserId?: string) {
    await this.assertMember(organizationId, actorUserId);
    return this.prisma.department.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createDepartment(
    organizationId: string,
    name: string,
    parentId: string | undefined,
    actorUserId?: string,
    leaderUserId?: string,
  ) {
    if (!name?.trim()) throw new AppError('invalid', 'Department name required');
    await this.assertCanManage(organizationId, actorUserId, 'org:departments');
    if (parentId) await this.assertDepartmentInOrg(parentId, organizationId);
    return this.prisma.$transaction(async (tx) => {
      const dept = await tx.department.create({
        data: {
          id: newEntityId(),
          organizationId,
          name: name.trim(),
          parentId: parentId || null,
          leaderUserId: leaderUserId || null,
        },
      });
      await this.audit.record(
        {
          organizationId,
          actorUserId,
          action: 'department.created',
          entityType: 'department',
          entityId: dept.id,
          metadata: { name: dept.name, parentId: dept.parentId },
        },
        tx,
      );
      return dept;
    });
  }

  async updateDepartment(
    id: string,
    data: { name?: string; parentId?: string | null; leaderUserId?: string | null },
    actorUserId?: string,
  ) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (!dept) throw new AppError('notFound', 'Department not found');
    await this.assertCanManage(dept.organizationId, actorUserId, 'org:departments');
    if (data.parentId) {
      await this.assertDepartmentInOrg(data.parentId, dept.organizationId);
      await this.assertNoCycle(id, data.parentId);
    }
    return this.prisma
      .$transaction(async (tx) => {
        const updated = await tx.department.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.parentId !== undefined ? { parentId: data.parentId || null } : {}),
            ...(data.leaderUserId !== undefined ? { leaderUserId: data.leaderUserId || null } : {}),
          },
        });
        await this.audit.record(
          {
            organizationId: dept.organizationId,
            actorUserId,
            action: 'department.updated',
            entityType: 'department',
            entityId: id,
            metadata: { name: updated.name, parentId: updated.parentId },
          },
          tx,
        );
        return updated;
      })
      .then(async (updated) => {
        await this.epoch.bumpOrgProjects(dept.organizationId);
        return updated;
      });
  }

  async deleteDepartment(id: string, actorUserId?: string, strategy?: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { organizationId: true, parentId: true },
    });
    if (!dept) throw new AppError('notFound', 'Department not found');
    await this.assertCanManage(dept.organizationId, actorUserId, 'org:departments');
    const strat = (strategy?.trim() || 'forbid').toLowerCase();
    // FR-ORG-190: an unknown strategy must NOT fall through to the schema's
    // ON DELETE SET NULL (silent child float-up is exactly what the canon forbids).
    if (strat !== 'forbid' && strat !== 'reparent') {
      throw new AppError('invalid', `Unsupported delete strategy "${strat}"`, {
        code: 'INVALID_DELETE_STRATEGY',
      });
    }
    const [childCount, employeeCount] = await Promise.all([
      this.prisma.department.count({ where: { parentId: id } }),
      this.prisma.employee.count({ where: { departmentId: id, isActive: true } }),
    ]);
    if (strat === 'forbid' && (childCount > 0 || employeeCount > 0)) {
      // 'conflict' → gRPC ALREADY_EXISTS → HTTP 409: the canon status
      // (FR-ORG-190 «409 department_not_empty») and the branch the host UI
      // already renders. 'failedPrecondition' is not an AppErrorCode — the
      // shared RpcExceptionFilter would degrade it to INTERNAL → 500.
      throw new AppError('conflict', 'Department has children or employees', {
        code: 'DEPARTMENT_NOT_EMPTY',
        childCount,
        employeeCount,
      });
    }
    // Schema: children.parentId and employees.departmentId both ON DELETE SET NULL.
    // There is NO FK from DepartmentProjectBinding → Department, so bindings (and
    // their materialized source='binding' members) would otherwise dangle after
    // the department is gone. Tear them down in the same transaction before the
    // delete; collect the touched projects for post-commit epoch invalidation.
    const touchedProjects = await this.prisma.$transaction(async (tx) => {
      let movedUserIds: string[] = [];
      if (strat === 'reparent') {
        if (childCount > 0) {
          await tx.department.updateMany({
            where: { parentId: id },
            data: { parentId: dept.parentId },
          });
        }
        // FR-ORG-190: reparent active employees to the parent department instead of
        // relying on schema ON DELETE SET NULL (silent structural loss).
        if (employeeCount > 0) {
          const moved = await tx.employee.findMany({
            where: { departmentId: id, isActive: true },
            select: { userId: true },
          });
          movedUserIds = moved.map((m) => m.userId);
          await tx.employee.updateMany({
            where: { departmentId: id, isActive: true },
            data: { departmentId: dept.parentId },
          });
        }
      }
      const { projectIds, deletedBindings, dematerialized } =
        await this.bindings.dematerializeAndDeleteBindingsOfDepartment(tx, id);
      const touched = [...projectIds];
      // FR-MORG-11 consistency: a reparented employee must gain the PARENT
      // department's binding-derived memberships, exactly like a normal
      // transfer-in (updateEmployee). Runs AFTER the deleted department's
      // bindings are dematerialized so a same-project membership from the dying
      // binding cannot shadow the parent's materialization.
      if (dept.parentId) {
        for (const userId of movedUserIds) {
          touched.push(
            ...(await this.bindings.bindingMembershipAddEmployee(tx, userId, dept.parentId)),
          );
        }
      }
      await tx.department.delete({ where: { id } });
      await this.audit.record(
        {
          organizationId: dept.organizationId,
          actorUserId,
          action: 'department.deleted',
          entityType: 'department',
          entityId: id,
          metadata: { deletedBindings, dematerialized },
        },
        tx,
      );
      return touched;
    });
    await this.bindingMembershipInvalidate(touchedProjects);
    return { ok: true };
  }

  // ─── Reorg preview (FR-MORG-21/-13, US-MORG-21) ───────────────────────────

  /** Collect a department's id together with all of its descendant ids. */
  private async collectSubtree(organizationId: string, rootId: string): Promise<string[]> {
    const all = await this.prisma.department.findMany({
      where: { organizationId },
      select: { id: true, parentId: true },
    });
    const childrenOf = new Map<string, string[]>();
    for (const d of all) {
      const key = d.parentId ?? '';
      const arr = childrenOf.get(key) ?? [];
      arr.push(d.id);
      childrenOf.set(key, arr);
    }
    const out: string[] = [];
    const stack = [rootId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const child of childrenOf.get(cur) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Dry-run preview of a reorganization (FR-MORG-21/-13): moving a department to a
   * new parent. Pure read — never mutates. Returns the affected scope (departments
   * in the subtree, employees attached to them) and whether the move is valid
   * (target in same org, no cycle). The FE shows this before the user confirms the
   * real `UpdateDepartment` (parentId) call.
   */
  async previewReorg(
    organizationId: string,
    departmentId: string,
    targetParentId: string | null | undefined,
    actorUserId?: string,
  ) {
    await this.assertCanManage(organizationId, actorUserId, 'org:departments');
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true, organizationId: true, name: true, parentId: true },
    });
    if (!dept || dept.organizationId !== organizationId) {
      throw new AppError('notFound', 'Department not found');
    }

    const subtreeIds = await this.collectSubtree(organizationId, departmentId);

    // Validate the proposed target without mutating.
    const issues: string[] = [];
    let valid = true;
    if (targetParentId) {
      const target = await this.prisma.department.findUnique({
        where: { id: targetParentId },
        select: { organizationId: true },
      });
      if (!target || target.organizationId !== organizationId) {
        valid = false;
        issues.push('TARGET_NOT_IN_ORG');
      } else if (subtreeIds.includes(targetParentId)) {
        // Moving a node under its own descendant would create a cycle.
        valid = false;
        issues.push('WOULD_CREATE_CYCLE');
      }
    }

    const affectedEmployees = await this.prisma.employee.count({
      where: { organizationId, departmentId: { in: subtreeIds }, isActive: true },
    });

    return {
      organizationId,
      departmentId,
      departmentName: dept.name,
      currentParentId: dept.parentId ?? '',
      targetParentId: targetParentId ?? '',
      affectedDepartmentCount: subtreeIds.length,
      affectedDepartmentIds: subtreeIds,
      affectedEmployeeCount: affectedEmployees,
      valid,
      issues,
    };
  }

  /**
   * The org-owned projects `userId` is a member of, id+name only (FR-MORG-25/37).
   * Intersection of ProjectMember (userId) with Project(ownerType=ORGANIZATION,
   * ownerId=orgId, not archived) — a single scoped query, no CRM-domain calls.
   */
  private async listOrgProjectsForUser(
    organizationId: string,
    userId: string,
  ): Promise<{ projectId: string; projectName: string }[]> {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const ids = memberships.map((m) => m.projectId);
    if (ids.length === 0) return [];
    const projects = await this.prisma.project.findMany({
      where: {
        id: { in: ids },
        isArchived: false,
        ownerId: organizationId,
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    });
    return projects.map((p) => ({ projectId: p.id, projectName: p.name }));
  }

  /**
   * Public wrapper for FR-ORG-600: departments the actor leads ∪ own department,
   * expanded down the tree.
   */
  async resolveLedDepartmentSubtree(
    organizationId: string,
    userId: string,
    ownDepartmentId: string | null,
  ): Promise<string[]> {
    return this.resolveDeptSubtreeForUser(organizationId, userId, ownDepartmentId);
  }

  /**
   * FR-ORG-220: aggregates for one department (org data; CRM unassigned count is 0
   * unless enriched by the gateway with `projectId`).
   */
  async getDepartmentSummary(
    organizationId: string,
    departmentId: string,
    actorUserId?: string,
  ): Promise<{
    employeeCount: number;
    activeSeats: number;
    pendingInvitations: number;
    unassignedRecordsCount: number;
  }> {
    const actor = this.assertActor(actorUserId);
    await this.assertMember(organizationId, actor);
    const dept = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });
    if (!dept) {
      throw new AppError('not_found', 'Department not found');
    }
    const employeeCount = await this.prisma.employee.count({
      where: { organizationId, departmentId, isActive: true },
    });
    const pendingInvitations = await this.prisma.invitation.count({
      where: {
        organizationId,
        departmentId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });
    return {
      employeeCount,
      activeSeats: employeeCount,
      pendingInvitations,
      unassignedRecordsCount: 0,
    };
  }

  /**
   * The viewer's VERIFIED department subtree (FR-OV-15): the departments they LEAD
   * (leaderUserId==userId) ∪ their own department, each expanded down the tree by
   * parent_id (BFS, cycle-safe). Authoritative and cheap here (control owns the
   * structure) — the gateway no longer reconstructs it from list RPCs.
   */
  private async resolveDeptSubtreeForUser(
    organizationId: string,
    userId: string,
    ownDepartmentId: string | null,
  ): Promise<string[]> {
    const depts = await this.prisma.department.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, leaderUserId: true },
    });
    const roots = new Set<string>();
    for (const d of depts) {
      if ((d.leaderUserId ?? '') === userId) roots.add(d.id);
    }
    if (ownDepartmentId) roots.add(ownDepartmentId);
    if (roots.size === 0) return [];

    const childrenOf = new Map<string, string[]>();
    for (const d of depts) {
      const key = d.parentId ?? '';
      const arr = childrenOf.get(key) ?? [];
      arr.push(d.id);
      childrenOf.set(key, arr);
    }
    const subtree = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const cur = stack.pop()!;
      if (subtree.has(cur)) continue;
      subtree.add(cur);
      for (const child of childrenOf.get(cur) ?? []) if (!subtree.has(child)) stack.push(child);
    }
    return [...subtree];
  }

  /**
   * P8-T6.2 (FR-MORG-30/37): the caller's OWN membership snapshot. Self-scoped —
   * only ever the actor's own Employee row (no other-user lookup), so a plain
   * `assertActor` (not a manage gate) is the correct authorization: any member can
   * read their own context. Non-membership is a benign empty snapshot (isMember=false),
   * mirroring getRole, so the FE can render the "no longer a member" banner rather
   * than a hard error. Leader NAME is resolved at the gateway (identity lives in auth).
   */
  async getMyMembership(organizationId: string, actorUserId?: string) {
    const actor = this.assertActor(actorUserId);
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: actor } },
      select: { role: true, isActive: true, departmentId: true },
    });
    if (!employee) {
      return {
        isMember: false,
        userId: actor,
        role: '',
        isActive: false,
        departmentId: '',
        departmentName: '',
        leaderUserId: '',
        projects: [],
      };
    }

    let departmentName = '';
    let leaderUserId = '';
    if (employee.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: employee.departmentId },
        select: { name: true, leaderUserId: true },
      });
      departmentName = dept?.name ?? '';
      leaderUserId = dept?.leaderUserId ?? '';
    }

    const projects = await this.listOrgProjectsForUser(organizationId, actor);

    return {
      isMember: true,
      userId: actor,
      role: employee.role,
      isActive: employee.isActive,
      departmentId: employee.departmentId ?? '',
      departmentName,
      leaderUserId,
      projects,
    };
  }

  /**
   * P8-T6.2 (FR-MORG-25): dry-run preview of an employee offboard. Manage-gated on
   * `org:employees` (same subject as the real offboard/deactivate) so only an
   * owner/admin (or a delegated org role) can see the impact. Returns the org-owned
   * projects the target loses access to and an owner guard. Per-project record
   * reassignment counts are DELIBERATELY not computed — those records live in the
   * Mongo CRM domains, which this control-only preview does not reach (partial=true).
   */
  async previewOffboard(organizationId: string, userId: string, actorUserId?: string) {
    await this.assertCanManage(organizationId, actorUserId, 'org:employees');
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    if (!employee) {
      throw new AppError('notFound', 'Employee not found');
    }
    const isOwner = employee.role === 'platform_owner';
    const projects = await this.listOrgProjectsForUser(organizationId, userId);
    return {
      userId,
      isOwner,
      projects,
      // Record-count reassignment is out of this control-only preview's scope.
      partial: true,
    };
  }
}
