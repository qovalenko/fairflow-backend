import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { newEntityId, isOrgRole, isProjectRole } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { DepartmentBindingsService } from './department-bindings.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { hashInvitationToken, mintInvitationToken } from './invitation-token.util';

const INVITE_TTL_DAYS = 7;

/** Project membership an invitation grants on accept (FR-ONB-10 / FR-AUTH-7). */
export interface ProjectGrant {
  projectId: string;
  role: string; // project role: owner|admin|manager|member|viewer
}

/**
 * Normalize/validate the wizard-step-4 project grants. An invalid project role
 * is clamped to `viewer` (predictable default, never an escalation to `owner`);
 * grants without a projectId are dropped. Returns a de-duplicated list (last
 * role wins per project).
 */
function normalizeProjectGrants(raw: unknown): ProjectGrant[] {
  if (!Array.isArray(raw)) return [];
  const byProject = new Map<string, string>();
  for (const g of raw) {
    const projectId = String((g as ProjectGrant)?.projectId ?? '').trim();
    if (!projectId) continue;
    const role = (g as ProjectGrant)?.role;
    byProject.set(projectId, isProjectRole(role) ? role : 'viewer');
  }
  return [...byProject.entries()].map(([projectId, role]) => ({ projectId, role }));
}

/**
 * Organization invitations (business-process spec §14, plan phase 2c).
 *
 * An owner/admin invites a person by **email** (who may not have an account
 * yet). The opaque {@link Invitation.token} travels in the email link. On accept
 * the gateway provisions the auth user (cross-domain) and calls
 * {@link InvitationService.accept} with the resolved userId — this service then
 * creates the {@link Employee} membership and closes the invitation.
 *
 * Cross-domain note: provisioning the auth user happens at the gateway (it holds
 * the `gateway:invoke` service key that auth's inbound guard requires); control
 * never calls auth directly. Accept trusts the gateway-supplied userId, which is
 * always resolved from this invitation's own email.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrgAuditService))
    private readonly audit: OrgAuditService,
    private readonly pdp: OrgPdpService,
    @Inject(forwardRef(() => DepartmentBindingsService))
    private readonly bindings: DepartmentBindingsService,
    private readonly epoch: ProjectAccessEpochService,
  ) {}

  /** Fail-closed: a missing requester identity is treated as unauthenticated. */
  private assertActor(actorUserId: string | undefined): string {
    const actor = (actorUserId ?? '').trim();
    if (!actor) {
      throw new AppError('auth', 'Authentication required');
    }
    return actor;
  }

  /**
   * P8-T4.1: gate invitation mutations on `org:invitations:manage` through the PDP
   * instead of the binary `orgRoleCanManage`. Default behaviour is preserved
   * (owner/admin carry it; employee does not — invitations were never a plain-member
   * read either); a custom org role can now grant invitation management on its own.
   * Error code/message unchanged.
   */
  private async assertCanManage(organizationId: string, actorUserId: string | undefined) {
    const actor = this.assertActor(actorUserId);
    if (!(await this.pdp.canManage(organizationId, actor, 'org:invitations'))) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }
  }

  /** Invitable org roles never include platform_owner. */
  private normalizeRole(role: string | undefined): string {
    if (!isOrgRole(role) || role === 'platform_owner') return 'employee';
    return role;
  }

  private async assertDepartmentInOrg(departmentId: string, organizationId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { organizationId: true },
    });
    if (!dept || dept.organizationId !== organizationId) {
      throw new AppError('invalid', 'Department does not belong to this organization');
    }
  }

  /**
   * Keep only grants whose project is owned by THIS organization (FR-ONB-10
   * isolation, BR-ONB-14). A grant for a foreign/non-existent project is silently
   * dropped — an org-admin can only grant access to projects the org controls,
   * never widen a user into another tenant's project via the invite.
   */
  private async scopeProjectGrants(
    organizationId: string,
    grants: ProjectGrant[],
  ): Promise<ProjectGrant[]> {
    if (grants.length === 0) return [];
    const ids = [...new Set(grants.map((g) => g.projectId))];
    const owned = await this.prisma.project.findMany({
      where: { id: { in: ids }, ownerId: organizationId },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((p) => p.id));
    return grants.filter((g) => ownedSet.has(g.projectId));
  }

  private expiry(): Date {
    return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  /** Lookup by bearer token from the email link (hashed at rest, FR-AUTH-280). */
  private async resolveByToken(plaintext: string) {
    const t = plaintext?.trim();
    if (!t) throw new AppError('invalid', 'token required');
    const hash = hashInvitationToken(t);
    let invitation = await this.prisma.invitation.findUnique({ where: { token: hash } });
    if (!invitation) {
      // Legacy rows minted before hashing (dev migration tail).
      invitation = await this.prisma.invitation.findUnique({ where: { token: t } });
    }
    return invitation;
  }

  async create(
    organizationId: string,
    email: string,
    role: string | undefined,
    departmentId: string | undefined,
    invitedByUserId: string,
    actorUserId?: string,
    projectGrantsRaw?: unknown,
  ) {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      throw new AppError('invalid', 'A valid email is required');
    }
    await this.assertCanManage(organizationId, actorUserId);
    if (departmentId) await this.assertDepartmentInOrg(departmentId, organizationId);

    // Onboarding step 4 (FR-ONB-10): project memberships to grant on accept.
    // Only grants for projects owned by THIS organization are accepted — a grant
    // for a foreign project would let an org-admin hand access to a project they
    // don't control. Foreign/non-existent projectIds are dropped (fail-closed).
    const grants = await this.scopeProjectGrants(
      organizationId,
      normalizeProjectGrants(projectGrantsRaw),
    );

    return this.prisma.$transaction(async (tx) => {
      // Supersede any still-pending invite for the same address (no duplicates).
      await tx.invitation.updateMany({
        where: { organizationId, email: emailNorm, status: 'pending' },
        data: { status: 'revoked' },
      });

      const { plaintext, hash } = mintInvitationToken();
      const invitation = await tx.invitation.create({
        data: {
          id: newEntityId(),
          organizationId,
          email: emailNorm,
          role: this.normalizeRole(role),
          departmentId: departmentId || null,
          token: hash,
          status: 'pending',
          invitedByUserId: invitedByUserId || actorUserId || '',
          expiresAt: this.expiry(),
          projectGrants: grants.length ? (grants as unknown as object) : undefined,
        },
      });
      await this.audit.record(
        {
          organizationId,
          actorUserId: actorUserId ?? invitedByUserId,
          action: 'invitation.created',
          entityType: 'invitation',
          entityId: invitation.id,
          metadata: { email: emailNorm, role: invitation.role },
        },
        tx,
      );
      return Object.assign(invitation, { emailToken: plaintext });
    });
  }

  async list(organizationId: string, actorUserId?: string) {
    await this.assertCanManage(organizationId, actorUserId);
    await this.expireStalePendingInvitations(organizationId);
    return this.prisma.invitation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** FR-ORG-420: lazily mark pending invites past TTL as expired (TODO-426). */
  private async expireStalePendingInvitations(organizationId: string) {
    const now = new Date();
    await this.prisma.invitation.updateMany({
      where: {
        organizationId,
        status: 'pending',
        expiresAt: { lt: now },
      },
      data: { status: 'expired' },
    });
  }

  async revoke(id: string, actorUserId?: string) {
    const invitation = await this.prisma.invitation.findUnique({ where: { id } });
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    await this.assertCanManage(invitation.organizationId, actorUserId);
    if (invitation.status === 'accepted') {
      throw new AppError('invalid', 'Cannot revoke an accepted invitation');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.invitation.update({
        where: { id },
        data: { status: 'revoked' },
      });
      await this.audit.record(
        {
          organizationId: invitation.organizationId,
          actorUserId,
          action: 'invitation.revoked',
          entityType: 'invitation',
          entityId: id,
          metadata: { email: invitation.email },
        },
        tx,
      );
      return updated;
    });
  }

  /** Re-arm an invitation (fresh token + expiry) so the email link works again. */
  async resend(id: string, actorUserId?: string) {
    const invitation = await this.prisma.invitation.findUnique({ where: { id } });
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    await this.assertCanManage(invitation.organizationId, actorUserId);
    if (invitation.status === 'accepted') {
      throw new AppError('invalid', 'Invitation already accepted');
    }
    return this.prisma.$transaction(async (tx) => {
      // FR-ORG-410: re-arming makes THIS invite the single pending one for the
      // address. A revoked/expired invite can be resent while a newer pending
      // one exists for the same email — supersede it first (same semantics as
      // create), otherwise the partial unique index rejects the update with a
      // raw P2002 instead of a clean outcome.
      await tx.invitation.updateMany({
        where: {
          organizationId: invitation.organizationId,
          email: invitation.email,
          status: 'pending',
          id: { not: id },
        },
        data: { status: 'revoked' },
      });
      const { plaintext, hash } = mintInvitationToken();
      const updated = await tx.invitation.update({
        where: { id },
        data: { status: 'pending', token: hash, expiresAt: this.expiry() },
      });
      await this.audit.record(
        {
          organizationId: invitation.organizationId,
          actorUserId,
          action: 'invitation.resent',
          entityType: 'invitation',
          entityId: id,
          metadata: { email: invitation.email },
        },
        tx,
      );
      return Object.assign(updated, { emailToken: plaintext });
    });
  }

  /** Lookup by token (gateway uses this to resolve the invitee email + state). */
  async getByToken(token: string) {
    const invitation = await this.resolveByToken(token);
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    if (invitation.status === 'pending' && invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      });
      throw new AppError('invalid', 'Invitation has expired');
    }
    // DEORG-W1: the Organization relation is gone. Resolve the system name from the
    // SystemSettings singleton keyed by the invitation's system anchor.
    const system = await this.prisma.systemSettings.findUnique({
      where: { id: invitation.organizationId },
      select: { name: true },
    });
    return { ...invitation, organization: system };
  }

  /**
   * Finalize an invitation for an already-resolved auth user (provisioned by the
   * gateway). Creates the Employee membership, the project memberships carried by
   * the invite's `projectGrants` (FR-ONB-10), and marks the invite accepted —
   * all atomically. Returns the granted projects so the gateway can land the
   * accepter on `/p/<projectId>` instead of the §4.5 stub.
   */
  async accept(token: string, userId: string) {
    if (!userId) throw new AppError('invalid', 'userId required');
    const invitation = await this.resolveByToken(token);
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    if (invitation.status === 'accepted') {
      if (invitation.acceptedUserId === userId) {
        const grants = normalizeProjectGrants(invitation.projectGrants);
        return { organizationId: invitation.organizationId, userId, projectGrants: grants };
      }
      throw new AppError('invalid', 'Invitation already accepted');
    }
    if (invitation.status !== 'pending') {
      throw new AppError('invalid', 'Invitation is no longer valid');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      });
      throw new AppError('invalid', 'Invitation has expired');
    }

    const role = this.normalizeRole(invitation.role);
    // Re-scope grants to org-owned projects at accept time too (a project could
    // have been archived/transferred since the invite was created) — fail-closed.
    const grants = await this.scopeProjectGrants(
      invitation.organizationId,
      normalizeProjectGrants(invitation.projectGrants),
    );
    // W7: make sure the system org roles exist so the in-transaction assignment
    // sync below has a target (no-op otherwise; the floor still covers the resolve).
    await this.pdp.ensureSystemOrgRoles(invitation.organizationId).catch(() => undefined);
    const touchedProjects = await this.prisma.$transaction(async (tx) => {
      // Prior department (if the accepter was already an employee) — needed to
      // decide whether accept moves them between departments (transfer semantics).
      const prior = await tx.employee.findUnique({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId },
        },
        select: { departmentId: true, isActive: true },
      });
      const employee = await tx.employee.upsert({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId },
        },
        create: {
          id: newEntityId(),
          organizationId: invitation.organizationId,
          userId,
          role,
          departmentId: invitation.departmentId,
        },
        // An ACTIVE member re-accepting keeps their current role (never downgrade
        // an owner re-accept). A RE-HIRE (offboarded → active) takes the
        // INVITATION's role (FR-ORG-430): the inactive membership must not
        // resurrect its old — possibly wider — role behind the inviter's back.
        update: {
          isActive: true,
          departmentId: invitation.departmentId ?? undefined,
          ...(prior && !prior.isActive ? { role } : {}),
        },
      });
      // W7: land the system-role assignment for the accepted member in the SAME
      // transaction (uses the persisted role — never downgrades an owner re-accept).
      await this.pdp.syncEmployeeRoleAssignment(
        tx,
        invitation.organizationId,
        userId,
        employee.role,
        userId,
      );
      // FR-ONB-10: project membership(s) granted by the invite — atomic with the
      // Employee. Upsert keeps accept idempotent and never downgrades an owner.
      for (const g of grants) {
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId: g.projectId, userId } },
          create: { id: newEntityId(), projectId: g.projectId, userId, role: g.role },
          update: { role: g.role },
        });
      }
      // FR-MORG-24: materialize the accepter's department→project binding
      // memberships. Run AFTER the projectGrants upserts so an explicit grant
      // wins — the binding hook never overwrites an existing (project,user) pair.
      // If accept moved an existing employee to a new department, drop the old
      // department's binding-members first (same transfer semantics as
      // OrgStructureService.updateEmployee).
      const touched: string[] = [];
      const oldDept = prior?.departmentId ?? null;
      const newDept = employee.departmentId ?? null;
      if (prior && oldDept && oldDept !== newDept) {
        touched.push(...(await this.bindings.bindingMembershipRemoveEmployee(tx, userId, oldDept)));
      }
      touched.push(...(await this.bindings.bindingMembershipAddEmployee(tx, userId, newDept)));
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted', acceptedUserId: userId, acceptedAt: new Date() },
      });
      await this.audit.record(
        {
          organizationId: invitation.organizationId,
          actorUserId: userId,
          action: 'invitation.accepted',
          entityType: 'invitation',
          entityId: invitation.id,
          metadata: {
            email: invitation.email,
            role,
            projectGrants: grants.map((g) => `${g.projectId}:${g.role}`),
          },
        },
        tx,
      );
      return touched;
    });
    // FR-MORG-31: invalidate the gateway permission cache for every project whose
    // membership changed via the binding hooks (best-effort, after commit).
    for (const projectId of [...new Set(touchedProjects)]) await this.epoch.bump(projectId);

    return { organizationId: invitation.organizationId, userId, projectGrants: grants };
  }
}
