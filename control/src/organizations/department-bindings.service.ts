import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { AppError, newEntityId, isProjectRole } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';

/**
 * Department→project bindings (FR-MORG-7/8/9/10/11).
 *
 * A `DepartmentProjectBinding` is the single source of truth for the intent
 * "department D works in project P as defaultRole R". The derived materialization
 * is a set of `ProjectMember(source='binding', bindingId, departmentId)` rows —
 * one per ACTIVE employee of the department — that grant the actual project access.
 *
 * Invariants:
 *  - Materialization NEVER touches a `source='manual'` membership and never
 *    overwrites ANY pre-existing membership of a (project, user) pair (a manual
 *    role wins; @@unique([projectId,userId])).
 *  - Every binding mutation and its ProjectMember materialization run in ONE
 *    transaction (FR-MORG-25) together with the chained org-audit record.
 *  - v1 supports `scope='self'` only; `subtree` is rejected (OQ-MORG-9).
 *  - suspend = dematerialize (delete the binding's members); re-activate =
 *    re-materialize. ProjectMember has no active flag, so this delete/re-create
 *    is the least-surprising, fully-idempotent semantics.
 */
@Injectable()
export class DepartmentBindingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrgAuditService))
    private readonly audit: OrgAuditService,
    private readonly pdp: OrgPdpService,
    private readonly epoch: ProjectAccessEpochService,
  ) {}

  private assertActor(actorUserId: string | undefined): string {
    const actor = (actorUserId ?? '').trim();
    if (!actor) throw new AppError('auth', 'Authentication required');
    return actor;
  }

  /** Read gate (`org:bindings:read`) — any member with the key may list. */
  private async assertCanRead(organizationId: string, actorUserId: string | undefined) {
    const actor = this.assertActor(actorUserId);
    if (!(await this.pdp.can(organizationId, actor, 'org:bindings', 'read'))) {
      throw new AppError('access', 'You are not allowed to view department bindings');
    }
  }

  /** Manage gate (`org:bindings:manage`) — owner/admin (or delegated role). */
  private async assertCanManage(organizationId: string, actorUserId: string | undefined) {
    const actor = this.assertActor(actorUserId);
    if (!(await this.pdp.canManage(organizationId, actor, 'org:bindings'))) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }
  }

  /** The department must belong to `organizationId` (isolation, first condition). */
  private async assertDepartmentInOrg(departmentId: string, organizationId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { organizationId: true },
    });
    if (!dept || dept.organizationId !== organizationId) {
      throw new AppError('notFound', 'Department not found');
    }
  }

  /**
   * The project must be an ORGANIZATION project owned by THIS organization — a
   * binding can only ever attach a department to a project of its own org. Returns
   * the project name (resolved here, in the same control DB — cheaper than a
   * gateway round-trip).
   */
  private async assertProjectInOrg(projectId: string, organizationId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, name: true },
    });
    // DEORG-W1: every project is owned by the System — verify the binding attaches a
    // project of this system (anchor match); the personal vector no longer exists.
    if (!project || project.ownerId !== organizationId) {
      throw new AppError('notFound', 'Project not found in this organization');
    }
    return project.name;
  }

  /** v1: only `self`. `subtree` is gated behind OQ-MORG-9 → INVALID_ARGUMENT. */
  private normalizeScope(scope: string | undefined): 'self' {
    const s = (scope ?? 'self').trim() || 'self';
    if (s === 'self') return 'self';
    throw new AppError('invalid', 'Only scope="self" is supported', {
      code: 'SCOPE_SUBTREE_NOT_SUPPORTED',
    });
  }

  /**
   * `defaultRole` must be a system project role (owner|admin|manager|member|viewer).
   * Custom roles are assigned via RoleAssignment — ProjectMember.role stores only
   * system roles (FR-ACCESS-160).
   */
  private async resolveDefaultRole(
    defaultRole: string | undefined,
    _projectId: string,
  ): Promise<string> {
    const role = (defaultRole ?? '').trim();
    if (!role) throw new AppError('invalid', 'defaultRole required');
    if (isProjectRole(role)) return role;
    throw new AppError('invalid', 'defaultRole must be a system project role', {
      code: 'INVALID_PROJECT_ROLE',
    });
  }

  private mapBinding(
    b: {
      id: string;
      organizationId: string;
      departmentId: string;
      projectId: string;
      defaultRole: string;
      scope: string;
      status: string;
      createdBy: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    projectName = '',
  ) {
    return {
      id: b.id,
      organizationId: b.organizationId,
      departmentId: b.departmentId,
      projectId: b.projectId,
      projectName,
      defaultRole: b.defaultRole,
      scope: b.scope,
      status: b.status,
      createdBy: b.createdBy ?? '',
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }

  // ── materialization primitives (tx-aware) ─────────────────────────────────

  /**
   * Materialize ONE binding: for every active employee of the binding's
   * department, ensure a `ProjectMember(source='binding')` exists. Skips any
   * (project,user) that already has a membership (manual OR another binding) —
   * never overwrites. Returns how many members were created.
   */
  private async materializeBinding(
    tx: Prisma.TransactionClient,
    binding: { id: string; departmentId: string; projectId: string; defaultRole: string },
  ): Promise<number> {
    const employees = await tx.employee.findMany({
      where: { departmentId: binding.departmentId, isActive: true },
      select: { userId: true },
    });
    let created = 0;
    for (const emp of employees) {
      const existing = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId: binding.projectId, userId: emp.userId } },
        select: { id: true },
      });
      if (existing) continue; // never overwrite an existing membership
      await tx.projectMember.create({
        data: {
          id: newEntityId(),
          projectId: binding.projectId,
          userId: emp.userId,
          role: binding.defaultRole,
          source: 'binding',
          departmentId: binding.departmentId,
          bindingId: binding.id,
        },
      });
      created += 1;
    }
    return created;
  }

  /** Delete all `source='binding'` members produced by one binding. Returns count. */
  private async dematerializeBinding(
    tx: Prisma.TransactionClient,
    bindingId: string,
  ): Promise<number> {
    const res = await tx.projectMember.deleteMany({
      where: { bindingId, source: 'binding' },
    });
    return res.count;
  }

  /**
   * Department teardown hook (called from OrgStructureService.deleteDepartment,
   * tx-aware). A deleted department must not leave dangling bindings whose
   * `source='binding'` members outlive it (access from a department that no
   * longer exists). For every binding of the department: dematerialize its
   * members (manual memberships survive), then delete the binding row — all in
   * the caller's transaction. Returns the affected project ids (for epoch
   * invalidation after commit) plus summary counts for the audit metadata.
   *
   * The full department-removal strategy (reparentToParent, FR-MORG-21) is a
   * separate TO-BE — this only cleans up the binding materialization.
   */
  async dematerializeAndDeleteBindingsOfDepartment(
    tx: Prisma.TransactionClient,
    departmentId: string,
  ): Promise<{ projectIds: string[]; deletedBindings: number; dematerialized: number }> {
    const bindings = await tx.departmentProjectBinding.findMany({
      where: { departmentId },
      select: { id: true, projectId: true },
    });
    const projectIds: string[] = [];
    let dematerialized = 0;
    for (const b of bindings) {
      dematerialized += await this.dematerializeBinding(tx, b.id);
      await tx.departmentProjectBinding.delete({ where: { id: b.id } });
      projectIds.push(b.projectId);
    }
    return { projectIds, deletedBindings: bindings.length, dematerialized };
  }

  // ── employee lifecycle hooks (called from OrgStructureService, tx-aware) ────
  //
  // These recompute the binding-derived membership of a SINGLE employee. They are
  // invoked inside the employee-mutation transaction so membership and the
  // employee row commit atomically (FR-MORG-11). `source='manual'` memberships are
  // never touched. Best-effort epoch bumps happen in the caller after commit.

  /**
   * The employee joined `departmentId` (hire / transfer-in): materialize a
   * binding-member for each ACTIVE binding of that department, skipping any
   * project where the user already has a membership. Returns the affected
   * project ids (for epoch invalidation).
   */
  async bindingMembershipAddEmployee(
    tx: Prisma.TransactionClient,
    userId: string,
    departmentId: string | null | undefined,
  ): Promise<string[]> {
    if (!departmentId) return [];
    const bindings = await tx.departmentProjectBinding.findMany({
      where: { departmentId, status: 'active', scope: 'self' },
      select: { id: true, projectId: true, departmentId: true, defaultRole: true },
    });
    const touched: string[] = [];
    for (const b of bindings) {
      const existing = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId: b.projectId, userId } },
        select: { id: true },
      });
      if (existing) continue;
      await tx.projectMember.create({
        data: {
          id: newEntityId(),
          projectId: b.projectId,
          userId,
          role: b.defaultRole,
          source: 'binding',
          departmentId: b.departmentId,
          bindingId: b.id,
        },
      });
      touched.push(b.projectId);
    }
    return touched;
  }

  /**
   * The employee left `departmentId` (transfer-out / offboard): drop the
   * binding-members that this department's bindings produced for the user.
   * `source='manual'` memberships survive. Returns the affected project ids.
   */
  async bindingMembershipRemoveEmployee(
    tx: Prisma.TransactionClient,
    userId: string,
    departmentId: string | null | undefined,
  ): Promise<string[]> {
    if (!departmentId) return [];
    const rows = await tx.projectMember.findMany({
      where: { userId, source: 'binding', departmentId },
      select: { projectId: true },
    });
    if (rows.length === 0) return [];
    await tx.projectMember.deleteMany({
      where: { userId, source: 'binding', departmentId },
    });
    return rows.map((r) => r.projectId);
  }

  // ── RPC surface ────────────────────────────────────────────────────────────

  async list(organizationId: string, departmentId: string, actorUserId?: string) {
    await this.assertCanRead(organizationId, actorUserId);
    await this.assertDepartmentInOrg(departmentId, organizationId);
    const bindings = await this.prisma.departmentProjectBinding.findMany({
      where: { organizationId, departmentId },
      orderBy: { createdAt: 'asc' },
    });
    if (bindings.length === 0) return [];
    const projects = await this.prisma.project.findMany({
      where: { id: { in: bindings.map((b) => b.projectId) } },
      select: { id: true, name: true },
    });
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return bindings.map((b) => this.mapBinding(b, names.get(b.projectId) ?? ''));
  }

  async create(
    organizationId: string,
    departmentId: string,
    input: { projectId: string; defaultRole: string; scope?: string },
    actorUserId?: string,
  ) {
    const actor = this.assertActor(actorUserId);
    await this.assertCanManage(organizationId, actorUserId);
    await this.assertDepartmentInOrg(departmentId, organizationId);
    const projectId = (input.projectId ?? '').trim();
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const projectName = await this.assertProjectInOrg(projectId, organizationId);
    const scope = this.normalizeScope(input.scope);
    const defaultRole = await this.resolveDefaultRole(input.defaultRole, projectId);

    // Reject a duplicate binding early with a clear message (the @@unique also
    // guards the race at commit).
    const dup = await this.prisma.departmentProjectBinding.findUnique({
      where: { departmentId_projectId: { departmentId, projectId } },
      select: { id: true },
    });
    if (dup) {
      throw new AppError('invalid', 'This department is already bound to this project', {
        code: 'BINDING_EXISTS',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const binding = await tx.departmentProjectBinding.create({
        data: {
          id: newEntityId(),
          organizationId,
          departmentId,
          projectId,
          defaultRole,
          scope,
          status: 'active',
          createdBy: actor,
        },
      });
      const materialized = await this.materializeBinding(tx, binding);
      await this.audit.record(
        {
          organizationId,
          actorUserId: actor,
          action: 'binding.created',
          entityType: 'department_binding',
          entityId: binding.id,
          metadata: { departmentId, projectId, defaultRole, scope, materialized },
        },
        tx,
      );
      return { binding, materialized };
    });
    await this.epoch.bump(projectId);
    return this.mapBinding(result.binding, projectName);
  }

  async update(
    organizationId: string,
    departmentId: string,
    bindingId: string,
    input: { defaultRole?: string; scope?: string; status?: string },
    actorUserId?: string,
  ) {
    const actor = this.assertActor(actorUserId);
    await this.assertCanManage(organizationId, actorUserId);
    const binding = await this.prisma.departmentProjectBinding.findUnique({
      where: { id: bindingId },
    });
    if (
      !binding ||
      binding.organizationId !== organizationId ||
      binding.departmentId !== departmentId
    ) {
      throw new AppError('notFound', 'Binding not found');
    }

    const patch: { defaultRole?: string; scope?: string; status?: string } = {};
    if (input.scope !== undefined) patch.scope = this.normalizeScope(input.scope);
    if (input.defaultRole !== undefined) {
      patch.defaultRole = await this.resolveDefaultRole(input.defaultRole, binding.projectId);
    }
    if (input.status !== undefined) {
      const s = input.status.trim();
      if (s !== 'active' && s !== 'suspended') {
        throw new AppError('invalid', 'status must be "active" or "suspended"', {
          code: 'INVALID_STATUS',
        });
      }
      patch.status = s;
    }

    const nextStatus = patch.status ?? binding.status;
    const nextRole = patch.defaultRole ?? binding.defaultRole;

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.departmentProjectBinding.update({
        where: { id: bindingId },
        data: patch,
      });

      let materialized = 0;
      let dematerialized = 0;
      let rerolled = 0;

      const statusChanged = patch.status !== undefined && patch.status !== binding.status;
      if (statusChanged && nextStatus === 'suspended') {
        // Suspend → drop the materialized members (manual survive).
        dematerialized = await this.dematerializeBinding(tx, bindingId);
      } else if (statusChanged && nextStatus === 'active') {
        // Re-activate → re-materialize with the (possibly new) role.
        materialized = await this.materializeBinding(tx, {
          id: bindingId,
          departmentId: binding.departmentId,
          projectId: binding.projectId,
          defaultRole: nextRole,
        });
      } else if (
        nextStatus === 'active' &&
        patch.defaultRole &&
        patch.defaultRole !== binding.defaultRole
      ) {
        // Role change on an active binding → re-roll ONLY this binding's members
        // (never the manual ones).
        const res = await tx.projectMember.updateMany({
          where: { bindingId, source: 'binding' },
          data: { role: nextRole },
        });
        rerolled = res.count;
      }

      await this.audit.record(
        {
          organizationId,
          actorUserId: actor,
          action: 'binding.changed',
          entityType: 'department_binding',
          entityId: bindingId,
          metadata: {
            departmentId: binding.departmentId,
            projectId: binding.projectId,
            from: {
              defaultRole: binding.defaultRole,
              status: binding.status,
              scope: binding.scope,
            },
            to: { defaultRole: nextRole, status: nextStatus, scope: updated.scope },
            materialized,
            dematerialized,
            rerolled,
          },
        },
        tx,
      );
      return updated;
    });
    await this.epoch.bump(binding.projectId);
    const projectName = await this.projectNameOf(binding.projectId);
    return this.mapBinding(result, projectName);
  }

  async remove(
    organizationId: string,
    departmentId: string,
    bindingId: string,
    actorUserId?: string,
  ) {
    const actor = this.assertActor(actorUserId);
    await this.assertCanManage(organizationId, actorUserId);
    const binding = await this.prisma.departmentProjectBinding.findUnique({
      where: { id: bindingId },
    });
    if (
      !binding ||
      binding.organizationId !== organizationId ||
      binding.departmentId !== departmentId
    ) {
      // Idempotent delete: nothing to do.
      return { ok: true };
    }
    await this.prisma.$transaction(async (tx) => {
      const dematerialized = await this.dematerializeBinding(tx, bindingId);
      await tx.departmentProjectBinding.delete({ where: { id: bindingId } });
      await this.audit.record(
        {
          organizationId,
          actorUserId: actor,
          action: 'binding.deleted',
          entityType: 'department_binding',
          entityId: bindingId,
          metadata: {
            departmentId: binding.departmentId,
            projectId: binding.projectId,
            dematerialized,
          },
        },
        tx,
      );
    });
    await this.epoch.bump(binding.projectId);
    return { ok: true };
  }

  private async projectNameOf(projectId: string): Promise<string> {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    return p?.name ?? '';
  }
}
