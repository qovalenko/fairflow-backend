import { Injectable } from '@nestjs/common';
import {
  newEntityId,
  permissionKey,
  parsePermissionKey,
  normalizeAction,
  expandSystemOrgRolePermissions,
  SYSTEM_ORG_ROLE_KEYS,
  ORG_STRUCTURE_KEYS,
  type SystemOrgRoleKey,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma';

/**
 * Org-structure PDP (P8 T4.1, E-ORG). Resolves a user's effective org-structure
 * permission-set so the org services gate concrete `subject:action` keys
 * (`org:employees:manage`, `org:departments:manage`, …) instead of the binary
 * `orgRoleCanManage`. This unlocks granular custom org roles (e.g. an "HR" role =
 * manage employees WITHOUT manage departments) while preserving the default
 * behaviour exactly.
 *
 * The layers mirror the project PDP (roles.service.resolveEffective):
 *   1. system role from `Employee.role` (mapped to the org system role's
 *      permission-set — the migration-window floor);
 *   2. org-scoped `RoleAssignment` (subjectType='user') — custom org roles layer
 *      on top;
 *   3. org-scoped `PermissionGrant` overlay (deny > allow).
 *
 * Dual-source fallback (W7 migration window, mirrors AccessUnit): when NO org
 * `RoleAssignment`/`PermissionGrant` exists for the user, the effective set is
 * derived purely from `Employee.role` via the system-role expansion — which is,
 * by construction, strictly equivalent to the old `orgRoleCanManage(Employee.role)`
 * for every manage-gated call (owner/admin ⇒ full manage; employee ⇒ read-only).
 *
 * Org-scoped RoleAssignment storage note: the RBAC schema is project-first
 * (`RoleAssignment.projectId` is NOT NULL and has no FK). Org-scoped assignments
 * reuse that column to hold the `organizationId` and set `scope='organization'`
 * as the discriminator — a minimal semantic widening, no breaking migration.
 * Entity ids are globally unique, so an orgId can never collide with a projectId;
 * the project resolver filters by the concrete projectId and never sees these.
 */
@Injectable()
export class OrgPdpService {
  /** Discriminator value for an org-scoped RoleAssignment/PermissionGrant. */
  static readonly ORG_SCOPE = 'organization';

  /** `createdBy` marker on a system-role assignment minted by the provisioner. */
  static readonly PROVISION_ACTOR = 'system:org-provision';

  /**
   * Per-process marker (W7): orgs whose system-role `RoleAssignment`s have already
   * been backfilled. Guards the O(employees) backfill off the hot manage-gate path
   * — after the first resolve per org per process it is a pure Set hit, no DB read.
   * A process restart simply re-runs the idempotent backfill once (upsert, no dupes).
   */
  private readonly provisionedOrgs = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Map an `Employee.role` string to a system org-role key (fail-safe: employee). */
  private toSystemOrgRoleKey(role: string | undefined | null): SystemOrgRoleKey {
    if (role === 'platform_owner') return 'platform_owner';
    if (role === 'platform_admin') return 'platform_admin';
    return 'employee';
  }

  /**
   * Ensure the three immutable system org roles exist for `organizationId`
   * (mirrors RolesService.ensureSystemRoles for the project scope). Idempotent:
   * re-runs sync the permission-set to the current org vocabulary. Called lazily
   * on the first org-permission resolve.
   */
  async ensureSystemOrgRoles(organizationId: string): Promise<Map<SystemOrgRoleKey, string>> {
    const byKey = new Map<SystemOrgRoleKey, string>();
    for (const key of SYSTEM_ORG_ROLE_KEYS) {
      const desired = expandSystemOrgRolePermissions(key);
      const role = await this.prisma.$transaction(async (tx) => {
        let existing = await tx.role.findUnique({
          where: {
            scopeType_scopeId_key: {
              scopeType: 'organization',
              scopeId: organizationId,
              key,
            },
          },
        });
        if (!existing) {
          existing = await tx.role.create({
            data: {
              id: newEntityId(),
              scopeType: 'organization',
              scopeId: organizationId,
              key,
              name: key,
              kind: 'system',
            },
          });
        }
        // Sync the permission-set to the current vocabulary expansion.
        await tx.rolePermission.deleteMany({ where: { roleId: existing.id } });
        if (desired.length > 0) {
          await tx.rolePermission.createMany({
            data: desired.map((k) => {
              const parsed = parsePermissionKey(k)!;
              return {
                id: newEntityId(),
                roleId: existing!.id,
                subject: parsed.subject,
                action: parsed.action,
              };
            }),
          });
        }
        return existing;
      });
      byKey.set(key, role.id);
    }
    return byKey;
  }

  /**
   * Provision org roles on live data (W7 / T4.1): ensure the three immutable
   * system org roles exist, then backfill a system-role `RoleAssignment` for every
   * ACTIVE employee, mapping `Employee.role` → the matching system role. Idempotent
   * (upsert on the assignment's compound unique) and guarded by a per-process
   * marker so the O(employees) backfill runs at most once per org per process — the
   * subsequent hot-path resolves short-circuit on the Set.
   *
   * Materializing these assignments closes the migration gap: the dual-source
   * resolve now has BOTH the Layer-1 floor (Employee.role expansion) and a concrete
   * Layer-2 assignment. Because both derive from the SAME `expandSystemOrgRolePermissions`
   * source, the resolved union is byte-for-byte identical — the default behaviour is
   * preserved exactly (T4.1 acceptance) — while the assignment layer becomes the
   * eventual single source once the floor is retired.
   */
  async provisionOrgRoles(organizationId: string): Promise<Map<SystemOrgRoleKey, string>> {
    const roleIds = await this.ensureSystemOrgRoles(organizationId);
    if (this.provisionedOrgs.has(organizationId)) return roleIds;
    await this.backfillSystemRoleAssignments(organizationId, roleIds);
    this.provisionedOrgs.add(organizationId);
    return roleIds;
  }

  /** Backfill a system-role assignment for each active employee (idempotent upsert). */
  private async backfillSystemRoleAssignments(
    organizationId: string,
    roleIdByKey: Map<SystemOrgRoleKey, string>,
  ): Promise<void> {
    const employees = await this.prisma.employee.findMany({
      where: { organizationId, isActive: true },
      select: { userId: true, role: true },
    });
    for (const emp of employees) {
      const roleId = roleIdByKey.get(this.toSystemOrgRoleKey(emp.role));
      if (!roleId) continue;
      await this.prisma.roleAssignment.upsert({
        where: {
          projectId_subjectType_subjectId_roleId_scope: {
            projectId: organizationId,
            subjectType: 'user',
            subjectId: emp.userId,
            roleId,
            scope: OrgPdpService.ORG_SCOPE,
          },
        },
        create: {
          id: newEntityId(),
          projectId: organizationId,
          subjectType: 'user',
          subjectId: emp.userId,
          roleId,
          scope: OrgPdpService.ORG_SCOPE,
          createdBy: OrgPdpService.PROVISION_ACTOR,
        },
        update: {},
      });
    }
  }

  /**
   * Keep an employee's system-role assignment in lock-step with `Employee.role`
   * inside the CALLER's transaction (add / update-role / reactivate). Upserts the
   * assignment for the mapped system role and removes any stale system-role
   * assignment (role changed). No-op when the system roles are not yet provisioned
   * — the Layer-1 floor still covers the resolve and the next `provisionOrgRoles`
   * backfill lands the row. Only touches the THREE system roles; custom-role
   * assignments (grantOrgRole) are managed independently and left untouched.
   */
  async syncEmployeeRoleAssignment(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    role: string,
    actorUserId: string,
  ): Promise<void> {
    const systemRoles = await tx.role.findMany({
      where: { scopeType: 'organization', scopeId: organizationId, kind: 'system' },
      select: { id: true, key: true },
    });
    if (systemRoles.length === 0) return;
    const targetKey = this.toSystemOrgRoleKey(role);
    const target = systemRoles.find((r) => r.key === targetKey);
    if (!target) return;
    const staleIds = systemRoles.filter((r) => r.id !== target.id).map((r) => r.id);
    if (staleIds.length > 0) {
      await tx.roleAssignment.deleteMany({
        where: {
          projectId: organizationId,
          scope: OrgPdpService.ORG_SCOPE,
          subjectType: 'user',
          subjectId: userId,
          roleId: { in: staleIds },
        },
      });
    }
    await tx.roleAssignment.upsert({
      where: {
        projectId_subjectType_subjectId_roleId_scope: {
          projectId: organizationId,
          subjectType: 'user',
          subjectId: userId,
          roleId: target.id,
          scope: OrgPdpService.ORG_SCOPE,
        },
      },
      create: {
        id: newEntityId(),
        projectId: organizationId,
        subjectType: 'user',
        subjectId: userId,
        roleId: target.id,
        scope: OrgPdpService.ORG_SCOPE,
        createdBy: actorUserId || OrgPdpService.PROVISION_ACTOR,
      },
      update: {},
    });
  }

  /**
   * Drop an employee's SYSTEM-role assignments inside the caller's transaction
   * (offboard / deactivate) — mirrors freeing the seat: the assignment layer tracks
   * active membership. Custom-role assignments are left to explicit revoke.
   * `Employee.role` itself stays for audit/reactivation, but it grants nothing:
   * resolveOrgEffective returns an EMPTY set for an inactive member (fail-closed,
   * FR-ORG-490).
   */
  async clearEmployeeSystemRoleAssignments(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const systemRoles = await tx.role.findMany({
      where: { scopeType: 'organization', scopeId: organizationId, kind: 'system' },
      select: { id: true },
    });
    if (systemRoles.length === 0) return;
    await tx.roleAssignment.deleteMany({
      where: {
        projectId: organizationId,
        scope: OrgPdpService.ORG_SCOPE,
        subjectType: 'user',
        subjectId: userId,
        roleId: { in: systemRoles.map((r) => r.id) },
      },
    });
  }

  /**
   * Resolve a user's effective org-structure permission-set (allow/deny) plus
   * their org role. `orgRole` is the `Employee.role` (empty when not a member).
   *
   * Fallback (dual-source): the `Employee.role` system-role expansion is always
   * folded in as the floor. Custom org `RoleAssignment`s and `PermissionGrant`s
   * layer on top when present. When only the floor is present the result is
   * strictly equivalent to `orgRoleCanManage(Employee.role)`.
   */
  async resolveOrgEffective(
    organizationId: string,
    userId: string,
  ): Promise<{ allow: string[]; deny: string[]; orgRole: string; isMember: boolean }> {
    const system = await this.prisma.systemSettings.findUnique({
      where: { id: organizationId },
      select: { isActive: true },
    });
    if (!system?.isActive) {
      return { allow: [], deny: [], orgRole: '', isMember: false };
    }

    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, isActive: true, departmentId: true },
    });
    // Non-member OR deactivated member → empty set (fail-closed; caller decides
    // read vs manage). FR-ORG-490: an offboarded employee must lose org access
    // immediately — the Layer-1 floor is NOT folded in for an inactive member,
    // and the role is not reported (an inactive platform_owner must never pass
    // an `orgRole === 'platform_owner'` shortcut downstream).
    if (!employee || !employee.isActive) {
      return { allow: [], deny: [], orgRole: '', isMember: false };
    }

    const catalogKeys = new Set<string>(ORG_STRUCTURE_KEYS);
    const allow = new Set<string>();
    const deny = new Set<string>();

    // Layer 1 — system role floor from Employee.role (the migration-window
    // dual-source that keeps the default behaviour byte-for-byte).
    const systemKey = this.toSystemOrgRoleKey(employee.role);
    for (const k of expandSystemOrgRolePermissions(systemKey)) allow.add(k);

    // Layer 2 — org-scoped RoleAssignment (custom roles). Only 'organization'
    // scope with projectId==orgId (see storage note). Expired assignments excluded.
    const now = new Date();
    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        projectId: organizationId,
        scope: OrgPdpService.ORG_SCOPE,
        subjectType: 'user',
        subjectId: userId,
      },
      include: { role: { include: { permissions: true } } },
    });
    const userRoleKeys = new Set<string>([this.toSystemOrgRoleKey(employee.role)]);
    for (const a of assignments) {
      if (a.expiresAt && a.expiresAt <= now) continue;
      // Only org-scoped roles contribute (defence-in-depth).
      if (a.role.scopeType !== 'organization' || a.role.scopeId !== organizationId) continue;
      if (a.role.key) userRoleKeys.add(a.role.key);
      for (const p of a.role.permissions) {
        const key = permissionKey(p.subject, normalizeAction(p.action) as never);
        if (catalogKeys.has(key)) allow.add(key);
      }
    }

    // Layer 3 — org-scoped PermissionGrant overlay (deny > allow). Reuses the
    // grant's projectId column to hold the orgId (moduleId='organization').
    const grants = await this.prisma.permissionGrant.findMany({
      where: { projectId: organizationId, moduleId: OrgPdpService.ORG_SCOPE },
    });
    for (const g of grants) {
      const key = permissionKey(g.subject, normalizeAction(g.action) as never);
      if (!catalogKeys.has(key)) continue;
      // Blanket deny (no grantee) applies to everyone; addressed grants match the user.
      const applies =
        (g.effect === 'deny' && !g.granteeId) ||
        (g.granteeType === 'member' && g.granteeId === userId) ||
        (g.granteeType === 'department' && g.granteeId && employee.departmentId === g.granteeId) ||
        (g.granteeType === 'role' && g.granteeId && userRoleKeys.has(g.granteeId));
      if (!applies) continue;
      if (g.effect === 'deny') deny.add(key);
      else allow.add(key);
    }

    // FR-ORG-600: a department leader must reach the subtree journal. The default
    // `employee` role does not carry `org:audit:read`, so without this the
    // gateway+PDP path is dead for the intended user. Deny grants still win.
    if (!allow.has('org:audit:read')) {
      const led = await this.prisma.department.findFirst({
        where: { organizationId, leaderUserId: userId },
        select: { id: true },
      });
      if (led) allow.add('org:audit:read');
    }

    // deny > allow.
    for (const d of deny) allow.delete(d);

    return {
      allow: [...allow].sort(),
      deny: [...deny].sort(),
      orgRole: employee.role,
      isMember: true,
    };
  }

  /**
   * Enforcement helper: does the user hold `subject:action` on the org? Ensures
   * the system org roles exist (lazy seed) then resolves the effective set. The
   * result is fail-closed — an unknown key or a non-member yields false.
   */
  async can(
    organizationId: string,
    userId: string,
    subject: string,
    action: string,
  ): Promise<boolean> {
    const { allow } = await this.resolveOrgEffective(organizationId, userId);
    return allow.includes(`${subject}:${normalizeAction(action)}`);
  }

  /**
   * Convenience mirror of the OLD binary gate, expressed through the PDP: true iff
   * the user may perform the given manage action. Used by the org services to
   * replace `orgRoleCanManage` at each call site with the concrete subject.
   */
  async canManage(organizationId: string, userId: string, subject: string): Promise<boolean> {
    return this.can(organizationId, userId, subject, 'manage');
  }

  /**
   * Sanity self-check retained for tests/tooling: the system `employee` role must
   * never carry any `:manage` key (else the default gate would widen). Pure.
   */
  static assertDefaultsSafe(): void {
    const employeeKeys = new Set(expandSystemOrgRolePermissions('employee'));
    for (const k of employeeKeys) {
      if (k.endsWith(':manage')) {
        throw new Error(`org employee default carries a manage key: ${k}`);
      }
    }
    // owner/admin carry the full vocabulary (equivalent to orgRoleCanManage=true).
    const ownerKeys = expandSystemOrgRolePermissions('platform_owner');
    if (ownerKeys.length !== ORG_STRUCTURE_KEYS.length) {
      throw new Error('org owner role does not carry the full vocabulary');
    }
  }
}
