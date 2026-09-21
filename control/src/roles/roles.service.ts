import { Injectable } from '@nestjs/common';
import {
  newEntityId,
  isProjectRole,
  normalizeAction,
  parsePermissionKey,
  permissionKey,
  buildProjectCatalogWithSystem,
  expandSystemRolePermissions,
  isProjectGrantablePermission,
  MAX_GROUP_DEPTH,
  compileEffectivePermissionsWithSources,
  decideRbac,
  checkNoSelfEscalation,
  SYSTEM_PROJECT_ROLE_KEYS,
  buildOrgStructureCatalog,
  isOrgStructureGrantablePermission,
  type ProjectRole,
  type PermissionCatalog,
  type CompiledRoleInput,
  type CompiledGrantInput,
  type EffectivePermissionSet,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { AppError } from '@fairflow/shared';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { Prisma } from '../generated/prisma';
import { buildAuditPayload, computeChainHash } from '../common/audit-chain';
import type { AuditChainPayload } from '../common/audit-chain';
import { RoleAuditService } from '../outbox/role-audit.service';
import {
  buildRoleAuditWhere,
  encodeRoleAuditCursor,
  type ListRoleAuditOpts,
} from './role-audit-list.util';

/** A role with its flattened permission keys for transport. */
export interface RoleView {
  id: string;
  scopeType: string;
  scopeId: string | null;
  key: string | null;
  name: string;
  kind: string;
  isArchived: boolean;
  permissions: string[]; // subject:action keys
  createdAt: string;
  updatedAt: string;
}

export interface RoleAssignmentView {
  id: string;
  projectId: string;
  subjectType: string;
  subjectId: string;
  roleId: string;
  roleName: string;
  roleKey: string | null;
  scope: string;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** An addressed allow/deny overlay row (PermissionGrant) for transport. */
export interface PermissionGrantView {
  id: string;
  projectId: string;
  moduleId: string;
  effect: string; // allow | deny
  subject: string;
  action: string;
  resource: string;
  granteeType: string | null; // role | member | department | unit
  granteeId: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * TODO-027 — `ensureSystemRoles` is a WRITE path (5 transactions, each rewriting
 * the role's whole permission-set) and it sits inside `resolveEffective`, which
 * the gateway PEP now calls on the enforcement path. Re-seeding ~500 rows on
 * every permission check would be both a latency and a write-amplification
 * disaster, so the sync is memoized per (projectId, catalog signature): the
 * expansion only ever changes when the project's catalog changes (module set),
 * and the signature captures exactly that. TTL is a safety bound for external
 * row surgery; the seed still runs on the first call in a process and whenever
 * the catalog moves. Cleared explicitly by `invalidateSystemRoleSync` after a
 * mutation that could affect the stored sets.
 */
const SYSTEM_ROLE_SYNC = new Map<
  string,
  { signature: string; ids: Map<ProjectRole, string>; expiresAt: number }
>();

function systemRoleSyncTtlMs(): number {
  const raw = process.env.CONTROL_SYSTEM_ROLE_SYNC_TTL_MS;
  if (raw === undefined) return 60_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

/** Drop the memoized system-role sync for a project (or all projects). */
export function invalidateSystemRoleSync(projectId?: string): void {
  if (projectId) SYSTEM_ROLE_SYNC.delete(projectId);
  else SYSTEM_ROLE_SYNC.clear();
}

/**
 * RBAC roles/assignments/grants service (E2-01). All mutations are project-scoped
 * by `projectId` (isolation, V8) and audited in the same transaction (FR-PERM-13).
 * The catalog (business + system subjects, FR-PERM-24) is the validation surface.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly orgPdp: OrgPdpService,
    private readonly roleAudit: RoleAuditService,
  ) {}

  // ── catalog ────────────────────────────────────────────────────────────

  /** Effective enabled module ids for a project (drives the catalog). */
  private async projectEnabledModules(projectId: string): Promise<string[]> {
    const project = await this.projects.findOne(projectId);
    return project.effectiveModules ?? project.modules ?? [];
  }

  async getCatalog(projectId: string): Promise<PermissionCatalog> {
    const modules = await this.projectEnabledModules(projectId);
    return buildProjectCatalogWithSystem(modules);
  }

  // ── system role seed/sync (FR-PERM-1, §7.4) ──────────────────────────────

  /**
   * Ensure the five immutable system project roles exist for `projectId`, with
   * their permission-set expanded from the catalog (§7.4). Idempotent: re-runs
   * sync the permission-set to the current catalog (so enabling a module grows
   * the system roles). Returns the system roles by key.
   */
  async ensureSystemRoles(
    projectId: string,
    /** Pass the already-loaded catalog to avoid re-reading the project (hot path). */
    knownCatalog?: PermissionCatalog,
  ): Promise<Map<ProjectRole, string>> {
    const catalog = knownCatalog ?? (await this.getCatalog(projectId));
    // TODO-027: skip the (write-heavy) re-seed while the catalog is unchanged —
    // see SYSTEM_ROLE_SYNC. Correctness is unaffected: the expansion is a pure
    // function of the catalog, and the signature is the catalog.
    const signature = catalog.keys.join('|');
    const ttl = systemRoleSyncTtlMs();
    const memo = SYSTEM_ROLE_SYNC.get(projectId);
    if (ttl > 0 && memo && memo.signature === signature && memo.expiresAt > Date.now()) {
      return new Map(memo.ids);
    }
    const byKey = new Map<ProjectRole, string>();
    for (const key of SYSTEM_PROJECT_ROLE_KEYS) {
      const desired = expandSystemRolePermissions(key, catalog);
      const role = await this.prisma.$transaction(async (tx) => {
        let existing = await tx.role.findUnique({
          where: {
            scopeType_scopeId_key: { scopeType: 'project', scopeId: projectId, key },
          },
        });
        if (!existing) {
          existing = await tx.role.create({
            data: {
              id: newEntityId(),
              scopeType: 'project',
              scopeId: projectId,
              key,
              name: key,
              kind: 'system',
            },
          });
        }
        // Sync permission-set to the catalog expansion.
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
    if (ttl > 0) {
      SYSTEM_ROLE_SYNC.set(projectId, {
        signature,
        ids: new Map(byKey),
        expiresAt: Date.now() + ttl,
      });
    }
    return byKey;
  }

  // ── role CRUD ────────────────────────────────────────────────────────────

  private async toRoleView(roleId: string): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: true },
    });
    if (!role) throw new AppError('notFound', 'Role not found');
    return this.mapRole(role);
  }

  private mapRole(role: {
    id: string;
    scopeType: string;
    scopeId: string | null;
    key: string | null;
    name: string;
    kind: string;
    isArchived: boolean;
    createdAt: Date;
    updatedAt: Date;
    permissions: { subject: string; action: string }[];
  }): RoleView {
    return {
      id: role.id,
      scopeType: role.scopeType,
      scopeId: role.scopeId,
      key: role.key,
      name: role.name,
      kind: role.kind,
      isArchived: role.isArchived,
      permissions: role.permissions
        .map((p) => permissionKey(p.subject, normalizeAction(p.action) as never))
        .sort(),
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  }

  async listRoles(projectId: string): Promise<RoleView[]> {
    await this.ensureSystemRoles(projectId);
    const roles = await this.prisma.role.findMany({
      where: {
        scopeType: 'project',
        scopeId: projectId,
        isArchived: false,
      },
      include: { permissions: true },
      orderBy: { createdAt: 'asc' },
    });
    return roles.map((r) => this.mapRole(r));
  }

  /**
   * Validate that every requested permission key is in the project catalog (V1),
   * is project-grantable (§7.6), and (unless owner) within the actor's effective
   * allow-set (§7.5 no-self-escalation). Throws fail-closed.
   */
  private async validateRolePermissions(
    projectId: string,
    actorUserId: string,
    rawKeys: string[],
  ): Promise<string[]> {
    const catalog = await this.getCatalog(projectId);
    const normalized = new Set<string>();
    for (const raw of rawKeys) {
      const parsed = parsePermissionKey(raw);
      if (!parsed) {
        throw new AppError('invalid', `Malformed permission "${raw}"`, {
          code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
        });
      }
      const key = permissionKey(parsed.subject, normalizeAction(parsed.action) as never);
      if (!catalog.hasKey(key)) {
        throw new AppError('invalid', `Permission "${key}" not in catalog`, {
          code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
          subject: parsed.subject,
          action: parsed.action,
        });
      }
      if (!isProjectGrantablePermission(key)) {
        throw new AppError('access', `Permission "${key}" cannot be granted by a project role`, {
          code: 'SELF_ESCALATION_DENIED',
        });
      }
      normalized.add(key);
    }
    // No self-escalation: actor must hold every key in their effective allow-set.
    const actor = await this.resolveEffective(projectId, actorUserId);
    const check = checkNoSelfEscalation({
      isOwner: actor.role === 'owner',
      actorAllow: actor.effective.allow,
      actorDeny: actor.effective.deny,
      requested: Array.from(normalized),
    });
    if (!check.ok) {
      throw new AppError('access', 'Cannot grant permissions you do not hold', {
        code: 'SELF_ESCALATION_DENIED',
        offending: check.offending,
      });
    }
    return Array.from(normalized).sort();
  }

  /** Soft warnings (linter, FR-PERM-11): delete/manage without read on same subject. */
  private lintWarnings(keys: string[]): string[] {
    const warnings: string[] = [];
    const bySubject = new Map<string, Set<string>>();
    for (const k of keys) {
      const p = parsePermissionKey(k);
      if (!p) continue;
      let set = bySubject.get(p.subject);
      if (!set) {
        set = new Set();
        bySubject.set(p.subject, set);
      }
      set.add(p.action);
    }
    for (const [subject, actions] of bySubject) {
      if ((actions.has('delete') || actions.has('manage')) && !actions.has('read')) {
        warnings.push(`${subject}: delete/manage without read`);
      }
    }
    return warnings;
  }

  async createRole(params: {
    projectId: string;
    actorUserId: string;
    name: string;
    permissions: string[];
  }): Promise<{ role: RoleView; warnings: string[] }> {
    if (!params.name?.trim()) {
      throw new AppError('invalid', 'Role name required', { code: 'INVALID_ARGUMENT' });
    }
    const keys = await this.validateRolePermissions(
      params.projectId,
      params.actorUserId,
      params.permissions,
    );
    const warnings = this.lintWarnings(keys);
    // Name uniqueness within project scope.
    const dup = await this.prisma.role.findFirst({
      where: {
        scopeType: 'project',
        scopeId: params.projectId,
        name: params.name,
        isArchived: false,
      },
    });
    if (dup) throw new AppError('invalid', 'Role name already taken', { code: 'ROLE_NAME_TAKEN' });

    const roleId = newEntityId();
    await this.prisma.$transaction(async (tx) => {
      await tx.role.create({
        data: {
          id: roleId,
          scopeType: 'project',
          scopeId: params.projectId,
          name: params.name,
          kind: 'custom',
        },
      });
      if (keys.length > 0) {
        await tx.rolePermission.createMany({
          data: keys.map((k) => {
            const p = parsePermissionKey(k)!;
            return { id: newEntityId(), roleId, subject: p.subject, action: p.action };
          }),
        });
      }
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'role.created',
        entityType: 'role',
        entityId: roleId,
        summary: `role "${params.name}" created`,
        after: { name: params.name, permissions: keys },
      });
    });
    return { role: await this.toRoleView(roleId), warnings };
  }

  private async assertCustomRole(
    roleId: string,
    projectId: string,
  ): Promise<{ id: string; name: string }> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scopeId !== projectId || role.scopeType !== 'project') {
      throw new AppError('notFound', 'Role not found');
    }
    if (role.kind === 'system') {
      throw new AppError('access', 'System role is immutable', { code: 'SYSTEM_ROLE_IMMUTABLE' });
    }
    return { id: role.id, name: role.name };
  }

  async updateRole(params: {
    projectId: string;
    actorUserId: string;
    roleId: string;
    name?: string;
    permissions?: string[];
  }): Promise<{ role: RoleView; warnings: string[] }> {
    const existing = await this.assertCustomRole(params.roleId, params.projectId);
    const before = await this.toRoleView(params.roleId);
    let keys: string[] | undefined;
    let warnings: string[] = [];
    if (params.permissions) {
      keys = await this.validateRolePermissions(
        params.projectId,
        params.actorUserId,
        params.permissions,
      );
      warnings = this.lintWarnings(keys);
    }
    const affectedRows = await this.prisma.roleAssignment.findMany({
      where: {
        projectId: params.projectId,
        roleId: params.roleId,
        subjectType: 'user',
      },
      select: { subjectId: true },
    });
    const affectedUserIds = [...new Set(affectedRows.map((r) => r.subjectId))];
    await this.prisma.$transaction(async (tx) => {
      if (params.name && params.name !== existing.name) {
        const dup = await tx.role.findFirst({
          where: {
            scopeType: 'project',
            scopeId: params.projectId,
            name: params.name,
            isArchived: false,
            id: { not: params.roleId },
          },
        });
        if (dup)
          throw new AppError('invalid', 'Role name already taken', { code: 'ROLE_NAME_TAKEN' });
        await tx.role.update({ where: { id: params.roleId }, data: { name: params.name } });
      }
      if (keys) {
        await tx.rolePermission.deleteMany({ where: { roleId: params.roleId } });
        if (keys.length > 0) {
          await tx.rolePermission.createMany({
            data: keys.map((k) => {
              const p = parsePermissionKey(k)!;
              return {
                id: newEntityId(),
                roleId: params.roleId,
                subject: p.subject,
                action: p.action,
              };
            }),
          });
        }
      }
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'role.updated',
        entityType: 'role',
        entityId: params.roleId,
        summary: `role "${params.name ?? existing.name}" updated`,
        before: { name: before.name, permissions: before.permissions },
        after: { name: params.name ?? before.name, permissions: keys ?? before.permissions },
        affectedUserIds,
      });
    });
    return { role: await this.toRoleView(params.roleId), warnings };
  }

  async deleteRole(params: {
    projectId: string;
    actorUserId: string;
    roleId: string;
  }): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id: params.roleId },
      select: { id: true, key: true, scopeId: true, scopeType: true, kind: true },
    });
    await this.assertCustomRole(params.roleId, params.projectId);
    const inUse = await this.prisma.roleAssignment.count({
      where: { roleId: params.roleId, projectId: params.projectId },
    });
    if (inUse > 0) {
      throw new AppError('conflict', 'Role is assigned and cannot be deleted', {
        code: 'ROLE_IN_USE',
      });
    }
    // FR-MORG-10: a role referenced by a live department→project binding as its
    // defaultRole cannot be deleted (a binding stores the role key or, for a
    // keyless custom role, its id). ROLE_IN_USE.
    const roleRefs = [role?.id, role?.key].filter((v): v is string => !!v);
    const boundCount = await this.prisma.departmentProjectBinding.count({
      where: { projectId: params.projectId, defaultRole: { in: roleRefs } },
    });
    if (boundCount > 0) {
      throw new AppError('conflict', 'Role is used by a department binding and cannot be deleted', {
        code: 'ROLE_IN_USE',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id: params.roleId }, data: { isArchived: true } });
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'role.deleted',
        entityType: 'role',
        entityId: params.roleId,
        summary: 'role archived',
      });
    });
  }

  async cloneRole(params: {
    projectId: string;
    actorUserId: string;
    roleId: string;
    name: string;
  }): Promise<RoleView> {
    const source = await this.prisma.role.findUnique({
      where: { id: params.roleId },
      include: { permissions: true },
    });
    if (!source || source.scopeId !== params.projectId) {
      throw new AppError('notFound', 'Role not found');
    }
    const keys = source.permissions.map((p) =>
      permissionKey(p.subject, normalizeAction(p.action) as never),
    );
    const result = await this.createRole({
      projectId: params.projectId,
      actorUserId: params.actorUserId,
      name: params.name,
      permissions: keys,
    });
    return result.role;
  }

  // ── assignments (FR-PERM-5/18/20) ────────────────────────────────────────

  private async resolveRoleForAssignment(
    projectId: string,
    roleId: string,
  ): Promise<{ id: string; key: string | null; name: string }> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.isArchived || (role.scopeType === 'project' && role.scopeId !== projectId)) {
      throw new AppError('notFound', 'Role not found');
    }
    return { id: role.id, key: role.key, name: role.name };
  }

  async grantRole(params: {
    projectId: string;
    actorUserId: string;
    subjectType: 'user' | 'department' | 'unit';
    subjectId: string;
    roleId: string;
    scope?: string;
    expiresAt?: Date | null;
  }): Promise<RoleAssignmentView> {
    if (!params.subjectId) {
      throw new AppError('invalid', 'subjectId required', { code: 'INVALID_ARGUMENT' });
    }
    const role = await this.resolveRoleForAssignment(params.projectId, params.roleId);
    const scope = params.scope || 'project';
    // V5: module scope must reference an enabled module.
    if (scope !== 'project') {
      const m = scope.startsWith('module:') ? scope.slice('module:'.length) : '';
      const modules = await this.projectEnabledModules(params.projectId);
      if (!m || !modules.includes(m)) {
        throw new AppError('invalid', `Invalid module scope "${scope}"`, {
          code: 'INVALID_MODULE_SCOPE',
        });
      }
    }
    // V9: owner is not delegable to a group (department OR AccessUnit, BX-ACL-BE-5).
    // anti-lockout: owner stays a per-user assignment so LAST_OWNER always holds.
    if (
      (params.subjectType === 'department' || params.subjectType === 'unit') &&
      role.key === 'owner'
    ) {
      throw new AppError('invalid', 'Owner role cannot be assigned to a group', {
        code: 'OWNER_NOT_DELEGABLE',
      });
    }
    const id = newEntityId();
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.upsert({
        where: {
          projectId_subjectType_subjectId_roleId_scope: {
            projectId: params.projectId,
            subjectType: params.subjectType,
            subjectId: params.subjectId,
            roleId: params.roleId,
            scope,
          },
        },
        create: {
          id,
          projectId: params.projectId,
          subjectType: params.subjectType,
          subjectId: params.subjectId,
          roleId: params.roleId,
          scope,
          expiresAt: params.expiresAt ?? null,
          createdBy: params.actorUserId,
        },
        update: { expiresAt: params.expiresAt ?? null },
      });
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'assignment.granted',
        entityType: 'role_assignment',
        entityId: id,
        summary: `${role.name} granted to ${params.subjectType}:${params.subjectId} (${scope})`,
        after: { roleId: params.roleId, subjectId: params.subjectId, scope },
      });
    });
    const created = await this.prisma.roleAssignment.findFirst({
      where: {
        projectId: params.projectId,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        roleId: params.roleId,
        scope,
      },
    });
    return this.mapAssignment(created!, role.name, role.key);
  }

  async revokeRole(params: {
    projectId: string;
    actorUserId: string;
    assignmentId: string;
  }): Promise<void> {
    const a = await this.prisma.roleAssignment.findUnique({ where: { id: params.assignmentId } });
    if (!a || a.projectId !== params.projectId) {
      throw new AppError('notFound', 'Assignment not found');
    }
    // V7 LAST_OWNER: cannot revoke the last owner assignment of the project.
    const role = await this.prisma.role.findUnique({ where: { id: a.roleId } });
    if (role?.key === 'owner' && a.subjectType === 'user') {
      const ownerRoleIds = (
        await this.prisma.role.findMany({
          where: { scopeType: 'project', scopeId: params.projectId, key: 'owner' },
          select: { id: true },
        })
      ).map((r) => r.id);
      const owners = await this.prisma.roleAssignment.count({
        where: { projectId: params.projectId, subjectType: 'user', roleId: { in: ownerRoleIds } },
      });
      if (owners <= 1) {
        throw new AppError('invalid', 'Cannot revoke the last owner', { code: 'LAST_OWNER' });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.deleteMany({
        where: { id: params.assignmentId, projectId: params.projectId },
      });
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'assignment.revoked',
        entityType: 'role_assignment',
        entityId: params.assignmentId,
        summary: 'assignment revoked',
        before: { roleId: a.roleId, subjectId: a.subjectId, scope: a.scope },
      });
    });
  }

  async listAssignments(params: {
    projectId: string;
    subjectId?: string;
    subjectType?: string;
  }): Promise<RoleAssignmentView[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        projectId: params.projectId,
        ...(params.subjectId && { subjectId: params.subjectId }),
        ...(params.subjectType && { subjectType: params.subjectType }),
      },
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.mapAssignment(r, r.role.name, r.role.key));
  }

  private mapAssignment(
    a: {
      id: string;
      projectId: string;
      subjectType: string;
      subjectId: string;
      roleId: string;
      scope: string;
      expiresAt: Date | null;
      createdBy: string;
      createdAt: Date;
    },
    roleName: string,
    roleKey: string | null,
  ): RoleAssignmentView {
    return {
      id: a.id,
      projectId: a.projectId,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      roleId: a.roleId,
      roleName,
      roleKey,
      scope: a.scope,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
      createdBy: a.createdBy,
      createdAt: a.createdAt.toISOString(),
    };
  }

  // ── addressed permission grants (PermissionGrant write-API, BX-ACL-BE-4) ──
  //
  // PermissionGrant is the addressed allow/deny overlay the effective-permission
  // compiler already reads (see resolveEffective, deny>allow). Until now it had
  // no write-path — grants could only be read. These methods add a fail-closed
  // create/update/delete/list so a project admin can grant or deny a single
  // subject:action to a user/department/role.
  //
  // RBAC v1: a grant is a project-wide blanket (resource='*', condition=null,
  // moduleId=PROJECT_GRANT_MODULE). The resolver matches by grantee only, so the
  // UI must NOT present resource/condition as narrowing (§7.4). granteeType
  // 'unit' is accepted since BX-ACL-BE-5 — resolveEffective now resolves unit
  // grants by the user's effective AccessUnit membership, so a unit-grant is no
  // longer a silent no-op (§1.3 fail-open closed).

  /** moduleId sentinel for a project-wide blanket grant (not module-scoped). */
  private static readonly PROJECT_GRANT_MODULE = 'project';
  /** Subjects a deny grant must never target — denying them would let a non-owner
   *  mass-lock admins out of access management (LAST_OWNER rescues only owner). */
  private static readonly DENY_FORBIDDEN_SUBJECTS = new Set(['roles', 'project', 'members']);

  async listGrants(projectId: string): Promise<PermissionGrantView[]> {
    const rows = await this.prisma.permissionGrant.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((g) => this.mapGrant(g));
  }

  async upsertGrant(params: {
    projectId: string;
    actorUserId: string;
    effect: string; // allow | deny
    subject: string;
    action: string;
    granteeType: string; // role | member | department
    granteeId: string;
  }): Promise<PermissionGrantView> {
    const effect = params.effect === 'deny' ? 'deny' : params.effect === 'allow' ? 'allow' : '';
    if (!effect) {
      throw new AppError('invalid', 'effect must be "allow" or "deny"', {
        code: 'INVALID_ARGUMENT',
      });
    }
    const granteeType = params.granteeType;
    if (
      granteeType !== 'role' &&
      granteeType !== 'member' &&
      granteeType !== 'department' &&
      granteeType !== 'unit'
    ) {
      // 'unit' now resolves in resolveEffective (BX-ACL-BE-5); anything else is
      // unknown — reject rather than silently persist a grant the resolver ignores (§1.3).
      throw new AppError('invalid', `Unsupported grantee type "${granteeType}"`, {
        code: 'INVALID_GRANTEE_TYPE',
      });
    }
    // Blanket grant forbidden: a grant must address an explicit grantee. An empty
    // granteeId is a blanket allow/deny over everyone — never accept it (§6).
    const granteeId = params.granteeId?.trim() ?? '';
    if (!granteeId) {
      throw new AppError('invalid', 'granteeId required (blanket grants are not allowed)', {
        code: 'GRANT_GRANTEE_REQUIRED',
      });
    }
    const parsed = parsePermissionKey(`${params.subject}:${params.action}`);
    if (!parsed) {
      throw new AppError('invalid', `Malformed permission "${params.subject}:${params.action}"`, {
        code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
      });
    }
    const subject = parsed.subject;
    const action = normalizeAction(parsed.action);
    const key = permissionKey(subject, action as never);
    // V1: the key must be in the project catalog.
    const catalog = await this.getCatalog(params.projectId);
    if (!catalog.hasKey(key)) {
      throw new AppError('invalid', `Permission "${key}" not in catalog`, {
        code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
        subject,
        action,
      });
    }
    // §7.6: only project-grantable keys (not auth:* / billing / org*).
    if (!isProjectGrantablePermission(key)) {
      throw new AppError('access', `Permission "${key}" cannot be granted in a project`, {
        code: 'SELF_ESCALATION_DENIED',
      });
    }
    // Mass-lockout guard: a deny on an access-control subject would let a
    // non-owner strip admins of roles/project/members management — forbid (§6).
    if (effect === 'deny' && RolesService.DENY_FORBIDDEN_SUBJECTS.has(subject)) {
      throw new AppError('access', `Deny grants on "${subject}" are not allowed`, {
        code: 'GRANT_DENY_FORBIDDEN_SUBJECT',
      });
    }
    // [BLOCKER] No self-escalation (§7.5): an allow grant may only hand out a key
    // the actor already holds (owner exempt). A deny reduces access, so it is not
    // an escalation and is not checked here (the deny guards above cover it).
    if (effect === 'allow') {
      const actor = await this.resolveEffective(params.projectId, params.actorUserId);
      const check = checkNoSelfEscalation({
        isOwner: actor.role === 'owner',
        actorAllow: actor.effective.allow,
        actorDeny: actor.effective.deny,
        requested: [key],
      });
      if (!check.ok) {
        throw new AppError('access', 'Cannot grant a permission you do not hold', {
          code: 'SELF_ESCALATION_DENIED',
          offending: check.offending,
        });
      }
    }

    const moduleId = RolesService.PROJECT_GRANT_MODULE;
    const resource = '*';
    // Natural key = (project, subject, action, granteeType, granteeId, resource):
    // one grant per grantee per permission; an upsert flips its effect. The table
    // has no @@unique, so resolve the existing row by hand.
    const existing = await this.prisma.permissionGrant.findFirst({
      where: {
        projectId: params.projectId,
        subject,
        action,
        granteeType,
        granteeId,
        resource,
      },
    });
    const id = existing?.id ?? newEntityId();
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.permissionGrant.update({
          where: { id },
          data: { effect, moduleId, createdBy: params.actorUserId },
        });
      } else {
        await tx.permissionGrant.create({
          data: {
            id,
            projectId: params.projectId,
            moduleId,
            effect,
            subject,
            action,
            resource,
            granteeType,
            granteeId,
            createdBy: params.actorUserId,
          },
        });
      }
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: existing ? 'grant.updated' : 'grant.created',
        entityType: 'permission_grant',
        entityId: id,
        summary: `${effect} ${key} → ${granteeType}:${granteeId}`,
        before: existing ? { effect: existing.effect, key } : undefined,
        after: { effect, key, granteeType, granteeId },
      });
    });
    const saved = await this.prisma.permissionGrant.findUnique({ where: { id } });
    return this.mapGrant(saved!);
  }

  async deleteGrant(params: {
    projectId: string;
    actorUserId: string;
    grantId: string;
  }): Promise<void> {
    const g = await this.prisma.permissionGrant.findUnique({ where: { id: params.grantId } });
    if (!g || g.projectId !== params.projectId) {
      throw new AppError('notFound', 'Grant not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.permissionGrant.deleteMany({
        where: { id: params.grantId, projectId: params.projectId },
      });
      await this.audit(tx, {
        projectId: params.projectId,
        actorUserId: params.actorUserId,
        action: 'grant.deleted',
        entityType: 'permission_grant',
        entityId: params.grantId,
        summary: `grant revoked (${g.effect} ${g.subject}:${g.action} → ${g.granteeType}:${g.granteeId})`,
        before: {
          effect: g.effect,
          subject: g.subject,
          action: g.action,
          granteeType: g.granteeType,
          granteeId: g.granteeId,
        },
      });
    });
  }

  private mapGrant(g: {
    id: string;
    projectId: string;
    moduleId: string;
    effect: string;
    subject: string;
    action: string;
    resource: string;
    granteeType: string | null;
    granteeId: string | null;
    createdBy: string;
    createdAt: Date;
  }): PermissionGrantView {
    return {
      id: g.id,
      projectId: g.projectId,
      moduleId: g.moduleId,
      effect: g.effect,
      subject: g.subject,
      action: g.action,
      resource: g.resource,
      granteeType: g.granteeType,
      granteeId: g.granteeId,
      createdBy: g.createdBy,
      createdAt: g.createdAt.toISOString(),
    };
  }

  // ── effective permission resolve (FR-PERM-8, S5) ──────────────────────────

  /**
   * Resolve a user's effective allow/deny permission-set in a project (S5). The
   * gateway calls this to fill `x-permissions`. Department assignments of the
   * user's departments are folded in (FR-PERM-20). Expired assignments excluded.
   */
  async resolveEffective(
    projectId: string,
    userId: string,
  ): Promise<{
    allow: string[];
    deny: string[];
    role: string;
    effective: EffectivePermissionSet;
    /** Per-key provenance (FR-ACCESS-550). */
    sources: Record<string, string>;
    /** The project catalog the set was compiled against (TODO-027: the PDP
     * enforcement path reuses it instead of re-reading the project). */
    catalog: PermissionCatalog;
  }> {
    // TODO-027: read the catalog ONCE and thread it through — this method sits on
    // the gateway's enforcement path, and it used to load the project three times
    // (here, inside ensureSystemRoles, and again in the caller).
    const catalog = await this.getCatalog(projectId);
    await this.ensureSystemRoles(projectId, catalog);
    const now = new Date();

    // Department ids the user belongs to (for department-scoped assignments) and
    // AccessUnit ids the user is an effective member of (for unit-scoped ones,
    // BX-ACL-BE-5). Both are folded into the assignment/grant resolution below.
    const [deptIds, unitIds] = await Promise.all([
      this.userDepartmentIds(projectId, userId),
      this.userUnitIds(projectId, userId),
    ]);

    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        projectId,
        OR: [
          { subjectType: 'user', subjectId: userId },
          ...(deptIds.length ? [{ subjectType: 'department', subjectId: { in: deptIds } }] : []),
          ...(unitIds.length ? [{ subjectType: 'unit', subjectId: { in: unitIds } }] : []),
        ],
      },
      include: { role: { include: { permissions: true } } },
    });

    const active = assignments.filter((a) => !a.expiresAt || a.expiresAt > now);

    // Baseline role = ProjectMember.role — the SAME source the gateway PEP uses
    // (resolveRecordVisibility / ProjectAccessGuard). resolveEffective historically
    // read ONLY RoleAssignment, so a member added without an explicit assignment
    // (project creation grants none; direct member-add) projected as role="" → the FE
    // locked the user out даже когда enforcement его пускал. Treat the membership role
    // as the floor; explicit assignments (department/custom/module-scoped) layer on top.
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    const baselineKey =
      membership?.role && isProjectRole(membership.role) ? (membership.role as ProjectRole) : null;

    const roleInputs: CompiledRoleInput[] = active.map((a) => ({
      permissionKeys: a.role.permissions.map((p) =>
        permissionKey(p.subject, normalizeAction(p.action) as never),
      ),
      moduleScope: a.scope.startsWith('module:') ? a.scope.slice('module:'.length) : undefined,
      source: `assignment:${a.role.key ?? a.roleId}`,
    }));

    const grantRows = await this.prisma.permissionGrant.findMany({ where: { projectId } });
    const grants: CompiledGrantInput[] = grantRows
      .filter((g) => {
        if (g.effect === 'deny' && !g.granteeId) return true; // blanket deny applies to all
        if (g.granteeType === 'member' && g.granteeId === userId) return true;
        if (g.granteeType === 'department' && g.granteeId && deptIds.includes(g.granteeId))
          return true;
        // unit-scoped grants resolved by the user's effective AccessUnit membership
        // (BX-ACL-BE-5, closes the §1.3 fail-open where a unit grant was silently ignored).
        if (g.granteeType === 'unit' && g.granteeId && unitIds.includes(g.granteeId)) return true;
        // role-scoped grants resolved by matching the user's role keys
        if (g.granteeType === 'role' && active.some((a) => a.role.key === g.granteeId)) return true;
        return false;
      })
      .map((g) => ({
        effect: g.effect === 'deny' ? 'deny' : 'allow',
        key: permissionKey(g.subject, normalizeAction(g.action) as never),
        source: `grant:${g.effect}`,
      }));

    const catalogKeys = new Set(catalog.keys);
    // Add the baseline membership role's permission set (same expansion as the system
    // roles), so a plain member without an explicit assignment still resolves rights.
    if (baselineKey) {
      roleInputs.push({
        permissionKeys: expandSystemRolePermissions(baselineKey, catalog),
        moduleScope: undefined,
        source: `baseline:${baselineKey}`,
      });
    }
    const compiled = compileEffectivePermissionsWithSources(roleInputs, grants, catalogKeys);
    const effective = { allow: compiled.allow, deny: compiled.deny };

    // Dominant project role (highest rank among assignments + the membership baseline).
    const role = this.dominantRole([...active.map((a) => a.role.key), baselineKey]);

    return {
      allow: effective.allow,
      deny: effective.deny,
      role,
      effective,
      catalog,
      sources: compiled.sources,
    };
  }

  private dominantRole(keys: (string | null)[]): string {
    const rank: Record<string, number> = { viewer: 1, member: 2, manager: 3, admin: 4, owner: 5 };
    let best = '';
    let bestRank = 0;
    for (const k of keys) {
      if (k && rank[k] && rank[k] > bestRank) {
        best = k;
        bestRank = rank[k];
      }
    }
    return best;
  }

  /** Department ids of the user within the project's organization (for dept roles). */
  private async userDepartmentIds(projectId: string, userId: string): Promise<string[]> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    // DEORG-W1: every project is owned by the System — resolve the user's
    // departments from the system structure by the project's anchor (ownerId).
    if (!project) return [];
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: project.ownerId, userId, departmentId: { not: null } },
      select: { departmentId: true },
    });
    return employees.map((e) => e.departmentId!).filter(Boolean);
  }

  /**
   * AccessUnit ids the user is an EFFECTIVE member of within the project scope —
   * the units whose RoleAssignment(subjectType='unit') / PermissionGrant
   * (granteeType='unit') resolve to this user (BX-ACL-BE-5).
   *
   * Effective membership follows group composition UPWARD: a role/grant addressed
   * to a container unit reaches the members of its child groups. Direct user
   * memberships seed a BFS up the `memberType='group'` containment edges.
   *
   * Bounds mirror the visibility resolver (RFC-ACCESS-GROUPS): the walk is capped
   * at MAX_GROUP_DEPTH nodes and hard-stops at any unit outside the project scope
   * (cross-scope hard-stop + dangling-id drop) so composition can never leak
   * rights across a scope boundary. Fail-closed: an unresolvable unit contributes
   * nothing rather than silently widening access.
   */
  private async userUnitIds(projectId: string, userId: string): Promise<string[]> {
    const units = await this.prisma.accessUnit.findMany({
      where: { scopeType: 'PROJECT', scopeId: projectId, archivedAt: null },
      select: { id: true, scopeId: true },
    });
    if (!units.length) return [];
    const allowedScopeIds = new Set<string>([projectId]);
    const scopeOf = new Map(units.map((u) => [u.id, u.scopeId]));
    const members = await this.prisma.accessUnitMember.findMany({
      where: { unitId: { in: units.map((u) => u.id) } },
      select: { unitId: true, memberType: true, memberId: true },
    });
    // childUnitId → parent unit ids that contain it as a group; user's direct units.
    const parentsOf = new Map<string, string[]>();
    const seed: string[] = [];
    for (const m of members) {
      if (m.memberType === 'group') {
        const list = parentsOf.get(m.memberId) ?? [];
        list.push(m.unitId);
        parentsOf.set(m.memberId, list);
      } else if (m.memberType === 'user' && m.memberId === userId) {
        seed.push(m.unitId);
      }
    }
    const effective = new Set<string>();
    const queue = [...seed];
    let steps = 0;
    const maxSteps = units.length * (MAX_GROUP_DEPTH + 1) + 1; // failsafe against cycles
    while (queue.length) {
      if (steps++ > maxSteps) break;
      const id = queue.shift()!;
      if (effective.has(id)) continue;
      // Cross-scope hard-stop (also drops dangling ids not in this project scope).
      if (!allowedScopeIds.has(scopeOf.get(id) ?? '')) continue;
      effective.add(id);
      for (const parent of parentsOf.get(id) ?? []) {
        if (!effective.has(parent)) queue.push(parent);
      }
    }
    return [...effective];
  }

  // ── simulator (FR-PERM-14, S7) ────────────────────────────────────────────

  async simulate(params: {
    projectId: string;
    userId: string;
    subject: string;
    action: string;
  }): Promise<{ decision: string; reason: string; matchedKeys: string[]; role: string }> {
    const { effective, role } = await this.resolveEffective(params.projectId, params.userId);
    const catalog = await this.getCatalog(params.projectId);
    const d = decideRbac(params.subject, params.action, effective, catalog);
    return { decision: d.decision, reason: d.reason, matchedKeys: d.matchedKeys, role };
  }

  // ── org-scoped custom roles (P8 T4.1, HR-case) ────────────────────────────
  //
  // Custom ORGANIZATION-scope roles reuse the same Role/RolePermission/RoleAssignment
  // tables as project roles, but validate against the org-structure catalog
  // (buildOrgStructureCatalog) with org grantability + org no-self-escalation —
  // the project methods above are untouched (contract-safe). An org RoleAssignment
  // reuses `RoleAssignment.projectId` to hold the orgId and sets
  // scope='organization' (see OrgPdpService storage note); OrgPdpService.resolveOrgEffective
  // reads exactly those rows.

  /**
   * Validate that every requested key is a grantable org-structure key AND (unless
   * the actor is the org owner) within the actor's own effective org allow-set
   * (§7.5 no-self-escalation extended to org scope). Fail-closed.
   */
  private async validateOrgRolePermissions(
    organizationId: string,
    actorUserId: string,
    rawKeys: string[],
  ): Promise<string[]> {
    const catalog = buildOrgStructureCatalog();
    const normalized = new Set<string>();
    for (const raw of rawKeys) {
      const parsed = parsePermissionKey(raw);
      if (!parsed) {
        throw new AppError('invalid', `Malformed permission "${raw}"`, {
          code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
        });
      }
      const key = permissionKey(parsed.subject, normalizeAction(parsed.action) as never);
      if (!catalog.hasKey(key) || !isOrgStructureGrantablePermission(key)) {
        throw new AppError('invalid', `Permission "${key}" not in org catalog`, {
          code: 'ROLE_PERMISSION_NOT_IN_CATALOG',
          subject: parsed.subject,
          action: parsed.action,
        });
      }
      normalized.add(key);
    }
    // No self-escalation: actor must hold every requested key. The org owner
    // (platform_owner) may grant anything in the vocabulary.
    const actor = await this.orgPdp.resolveOrgEffective(organizationId, actorUserId);
    const check = checkNoSelfEscalation({
      isOwner: actor.orgRole === 'platform_owner',
      actorAllow: actor.allow,
      actorDeny: actor.deny,
      requested: Array.from(normalized),
    });
    if (!check.ok) {
      throw new AppError('access', 'Cannot grant org permissions you do not hold', {
        code: 'SELF_ESCALATION_DENIED',
        offending: check.offending,
      });
    }
    return Array.from(normalized).sort();
  }

  /** List custom + system org roles for an organization (seeds system roles first). */
  async listOrgRoles(organizationId: string): Promise<RoleView[]> {
    await this.orgPdp.ensureSystemOrgRoles(organizationId);
    const roles = await this.prisma.role.findMany({
      where: { scopeType: 'organization', scopeId: organizationId, isArchived: false },
      include: { permissions: true },
      orderBy: { createdAt: 'asc' },
    });
    return roles.map((r) => this.mapRole(r));
  }

  async createOrgRole(params: {
    organizationId: string;
    actorUserId: string;
    name: string;
    permissions: string[];
  }): Promise<RoleView> {
    if (!params.name?.trim()) {
      throw new AppError('invalid', 'Role name required', { code: 'INVALID_ARGUMENT' });
    }
    const keys = await this.validateOrgRolePermissions(
      params.organizationId,
      params.actorUserId,
      params.permissions,
    );
    const dup = await this.prisma.role.findFirst({
      where: {
        scopeType: 'organization',
        scopeId: params.organizationId,
        name: params.name,
        isArchived: false,
      },
    });
    if (dup) throw new AppError('invalid', 'Role name already taken', { code: 'ROLE_NAME_TAKEN' });

    const roleId = newEntityId();
    await this.prisma.$transaction(async (tx) => {
      await tx.role.create({
        data: {
          id: roleId,
          scopeType: 'organization',
          scopeId: params.organizationId,
          name: params.name,
          kind: 'custom',
        },
      });
      if (keys.length > 0) {
        await tx.rolePermission.createMany({
          data: keys.map((k) => {
            const p = parsePermissionKey(k)!;
            return { id: newEntityId(), roleId, subject: p.subject, action: p.action };
          }),
        });
      }
      await this.audit(tx, {
        orgId: params.organizationId,
        actorUserId: params.actorUserId,
        action: 'role.created',
        entityType: 'role',
        entityId: roleId,
        summary: `org role "${params.name}" created`,
        after: { name: params.name, permissions: keys },
      });
    });
    return this.toRoleView(roleId);
  }

  private async assertCustomOrgRole(
    roleId: string,
    organizationId: string,
  ): Promise<{ id: string; name: string }> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scopeId !== organizationId || role.scopeType !== 'organization') {
      throw new AppError('notFound', 'Role not found');
    }
    if (role.kind === 'system') {
      throw new AppError('access', 'System role is immutable', { code: 'SYSTEM_ROLE_IMMUTABLE' });
    }
    return { id: role.id, name: role.name };
  }

  async updateOrgRole(params: {
    organizationId: string;
    actorUserId: string;
    roleId: string;
    name?: string;
    permissions?: string[];
  }): Promise<RoleView> {
    const existing = await this.assertCustomOrgRole(params.roleId, params.organizationId);
    const before = await this.toRoleView(params.roleId);
    let keys: string[] | undefined;
    if (params.permissions) {
      keys = await this.validateOrgRolePermissions(
        params.organizationId,
        params.actorUserId,
        params.permissions,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (params.name && params.name !== existing.name) {
        const dup = await tx.role.findFirst({
          where: {
            scopeType: 'organization',
            scopeId: params.organizationId,
            name: params.name,
            isArchived: false,
            id: { not: params.roleId },
          },
        });
        if (dup)
          throw new AppError('invalid', 'Role name already taken', { code: 'ROLE_NAME_TAKEN' });
        await tx.role.update({ where: { id: params.roleId }, data: { name: params.name } });
      }
      if (keys) {
        await tx.rolePermission.deleteMany({ where: { roleId: params.roleId } });
        if (keys.length > 0) {
          await tx.rolePermission.createMany({
            data: keys.map((k) => {
              const p = parsePermissionKey(k)!;
              return {
                id: newEntityId(),
                roleId: params.roleId,
                subject: p.subject,
                action: p.action,
              };
            }),
          });
        }
      }
      await this.audit(tx, {
        orgId: params.organizationId,
        actorUserId: params.actorUserId,
        action: 'role.updated',
        entityType: 'role',
        entityId: params.roleId,
        summary: `org role "${params.name ?? existing.name}" updated`,
        before: { name: before.name, permissions: before.permissions },
        after: { name: params.name ?? before.name, permissions: keys ?? before.permissions },
      });
    });
    return this.toRoleView(params.roleId);
  }

  async deleteOrgRole(params: {
    organizationId: string;
    actorUserId: string;
    roleId: string;
  }): Promise<void> {
    await this.assertCustomOrgRole(params.roleId, params.organizationId);
    const inUse = await this.prisma.roleAssignment.count({
      where: { roleId: params.roleId, projectId: params.organizationId },
    });
    if (inUse > 0) {
      throw new AppError('conflict', 'Role is assigned and cannot be deleted', {
        code: 'ROLE_IN_USE',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id: params.roleId }, data: { isArchived: true } });
      await this.audit(tx, {
        orgId: params.organizationId,
        actorUserId: params.actorUserId,
        action: 'role.deleted',
        entityType: 'role',
        entityId: params.roleId,
        summary: 'org role archived',
      });
    });
  }

  /**
   * Assign a custom/system org role to a user (org-scoped RoleAssignment). Reuses
   * the projectId column to hold the orgId + scope='organization' (see
   * OrgPdpService). Idempotent upsert; audited.
   */
  async grantOrgRole(params: {
    organizationId: string;
    actorUserId: string;
    userId: string;
    roleId: string;
    expiresAt?: Date | null;
  }): Promise<RoleAssignmentView> {
    if (!params.userId) {
      throw new AppError('invalid', 'userId required', { code: 'INVALID_ARGUMENT' });
    }
    const role = await this.prisma.role.findUnique({ where: { id: params.roleId } });
    if (
      !role ||
      role.isArchived ||
      role.scopeType !== 'organization' ||
      role.scopeId !== params.organizationId
    ) {
      throw new AppError('notFound', 'Role not found');
    }
    const scope = OrgPdpService.ORG_SCOPE;
    const id = newEntityId();
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.upsert({
        where: {
          projectId_subjectType_subjectId_roleId_scope: {
            projectId: params.organizationId,
            subjectType: 'user',
            subjectId: params.userId,
            roleId: params.roleId,
            scope,
          },
        },
        create: {
          id,
          projectId: params.organizationId,
          subjectType: 'user',
          subjectId: params.userId,
          roleId: params.roleId,
          scope,
          expiresAt: params.expiresAt ?? null,
          createdBy: params.actorUserId,
        },
        update: { expiresAt: params.expiresAt ?? null },
      });
      await this.audit(tx, {
        orgId: params.organizationId,
        actorUserId: params.actorUserId,
        action: 'assignment.granted',
        entityType: 'role_assignment',
        entityId: id,
        summary: `org role ${role.name} granted to user:${params.userId}`,
        after: { roleId: params.roleId, subjectId: params.userId },
      });
    });
    const created = await this.prisma.roleAssignment.findFirst({
      where: {
        projectId: params.organizationId,
        subjectType: 'user',
        subjectId: params.userId,
        roleId: params.roleId,
        scope,
      },
    });
    return this.mapAssignment(created!, role.name, role.key);
  }

  async revokeOrgRole(params: {
    organizationId: string;
    actorUserId: string;
    assignmentId: string;
  }): Promise<void> {
    const a = await this.prisma.roleAssignment.findUnique({ where: { id: params.assignmentId } });
    if (!a || a.projectId !== params.organizationId || a.scope !== OrgPdpService.ORG_SCOPE) {
      throw new AppError('notFound', 'Assignment not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.deleteMany({
        where: { id: params.assignmentId, projectId: params.organizationId },
      });
      await this.audit(tx, {
        orgId: params.organizationId,
        actorUserId: params.actorUserId,
        action: 'assignment.revoked',
        entityType: 'role_assignment',
        entityId: params.assignmentId,
        summary: 'org role assignment revoked',
        before: { roleId: a.roleId, subjectId: a.subjectId },
      });
    });
  }

  // ── audit (FR-PERM-13) ────────────────────────────────────────────────────

  /**
   * Append a chained RoleAuditLog record (P8 T5.1, decision Р-5). MUST be called
   * inside the mutation's `$transaction` so the audit write commits/rolls back
   * atomically with the role/assignment/grant change. Delegates to the shared
   * {@link RoleAuditService} single-writer (also used by project-membership role
   * changes) — the chain/outbox mechanics live in ONE place, not forked per caller.
   */
  private async audit(
    tx: Prisma.TransactionClient,
    entry: {
      projectId?: string;
      orgId?: string;
      actorUserId?: string;
      action: string;
      entityType: string;
      entityId?: string;
      summary?: string;
      before?: unknown;
      after?: unknown;
      permissionDiff?: { added: string[]; removed: string[] };
      affectedUserIds?: string[];
    },
  ): Promise<void> {
    await this.roleAudit.append(tx, entry);
  }

  /**
   * Recompute a RoleAuditLog chain and return the first tampered record (or null
   * if intact). Scope is either a project (`{ projectId }`) or an org
   * (`{ orgId }`). Starts at the earliest chained record so pre-chain legacy rows
   * (W7 genesis backfill pending) do not false-positive.
   */
  async verifyChain(
    scope: { projectId: string } | { orgId: string },
  ): Promise<RoleAuditChainVerifyResult> {
    const projectId = 'projectId' in scope ? scope.projectId : undefined;
    const orgId = 'orgId' in scope ? scope.orgId : undefined;
    const rows = await this.prisma.roleAuditLog.findMany({
      where: {
        chainHash: { not: null },
        ...(projectId ? { projectId } : { orgId }),
      },
      orderBy: { createdAt: 'asc' },
    });
    const scopeType: AuditChainPayload['scopeType'] = projectId ? 'role:project' : 'role:org';
    const scopeId = projectId ?? orgId ?? '';
    let expectedPrev: string | null = null;
    let checked = 0;
    for (const row of rows) {
      const payload = buildAuditPayload({
        scopeType,
        scopeId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before ?? null,
        after: row.after ?? null,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
      });
      const recomputed = computeChainHash(expectedPrev, payload);
      if (row.prevHash !== expectedPrev || row.chainHash !== recomputed) {
        return { ok: false, checked, brokenId: row.id };
      }
      expectedPrev = row.chainHash;
      checked += 1;
    }
    return { ok: true, checked, brokenId: null };
  }

  async listAuditLog(
    params: ListRoleAuditOpts,
  ): Promise<{ list: RoleAuditLogView[]; nextCursor: string }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const where = buildRoleAuditWhere(params);
    const rows = await this.prisma.roleAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const list = hasMore ? rows.slice(0, limit) : rows;
    const tail = hasMore ? list[list.length - 1] : null;
    const nextCursor = tail ? encodeRoleAuditCursor(tail.createdAt, tail.id) : '';
    return {
      list: list.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        summary: r.summary,
        actorUserId: r.actorUserId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}

export interface RoleAuditLogView {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface RoleAuditChainVerifyResult {
  ok: boolean;
  /** Number of records verified before the break (or in total when ok). */
  checked: number;
  /** Id of the first tampered record, or null when the chain is intact. */
  brokenId: string | null;
}
