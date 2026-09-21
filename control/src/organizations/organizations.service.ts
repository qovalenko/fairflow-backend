import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { UserDirectoryService } from '../user-directory/user-directory.service';

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'org'
  );
}

async function ensureUniqueSlug(
  findBySlug: (slug: string) => Promise<{ id: string } | null>,
  rawSlug: string,
): Promise<string> {
  const base = slugify(rawSlug);
  let candidate = base;
  let suffix = 2;

  while (await findBySlug(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

/** Optional requisites editable on the org profile screen. */
export type OrgRequisites = {
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  legalAddress?: string | null;
  actualAddress?: string | null;
  phone?: string | null;
  email?: string | null;
  logoUrl?: string | null;
  description?: string | null;
};

/** Keep only keys whose value is defined (partial-update semantics). */
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrgAuditService))
    private readonly audit: OrgAuditService,
    private readonly pdp: OrgPdpService,
    private readonly directory: UserDirectoryService,
  ) {}

  /** FR-ORG-007: true once the singleton SystemSettings row exists (bootstrap complete). */
  async hasSystem(): Promise<boolean> {
    return (await this.prisma.systemSettings.count()) > 0;
  }

  async create(data: { name: string; slug?: string; userId: string } & OrgRequisites) {
    // box is single-tenant: exactly one organization ever exists. Enforce the
    // invariant server-side (fail-closed) — never rely on the FE OrgSetupRecovery
    // guard, which a crafted request bypasses. First bootstrap creates the org;
    // any subsequent create is a conflict.
    const existing = await this.prisma.systemSettings.count();
    if (existing > 0) {
      throw new AppError('conflict', 'An organization already exists');
    }

    const requestedSlug = data.slug?.trim();
    const slugBase = requestedSlug || data.name;
    const slug = await ensureUniqueSlug(
      async (candidate) =>
        this.prisma.systemSettings.findUnique({
          where: { slug: candidate },
          select: { id: true },
        }),
      slugBase,
    );

    if (requestedSlug && slug !== slugify(requestedSlug)) {
      throw new AppError('invalid', 'Organization with this slug already exists');
    }

    const requisites = pickDefined({
      inn: data.inn ?? undefined,
      kpp: data.kpp ?? undefined,
      ogrn: data.ogrn ?? undefined,
      legalAddress: data.legalAddress ?? undefined,
      actualAddress: data.actualAddress ?? undefined,
      phone: data.phone ?? undefined,
      email: data.email ?? undefined,
      logoUrl: data.logoUrl ?? undefined,
      description: data.description ?? undefined,
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.systemSettings.create({
        data: { id: newEntityId(), name: data.name, slug, ...requisites },
      });
      await tx.employee.create({
        data: {
          id: newEntityId(),
          organizationId: org.id,
          userId: data.userId,
          role: 'platform_owner',
        },
      });
      return { org, role: 'platform_owner' as const };
    });
    // P8-T4.1/W7: provision the three immutable system org roles up front AND
    // backfill the owner's system-role assignment (provisionOrgRoles). Idempotent
    // and best-effort — the PDP fallback (Employee.role floor) holds even if this
    // is skipped, so a seed failure never blocks org creation.
    await this.pdp.provisionOrgRoles(result.org.id).catch(() => undefined);
    return result;
  }

  async findOne(id: string) {
    const org = await this.prisma.systemSettings.findUnique({ where: { id } });
    if (!org) throw new AppError('notFound', 'Organization not found');
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: id },
    });
    return { ...org, employees };
  }

  /** Fail-closed: a missing requester identity is treated as unauthenticated. */
  private assertActor(actorUserId: string | undefined): string {
    const actor = (actorUserId ?? '').trim();
    if (!actor) {
      throw new AppError('auth', 'Authentication required');
    }
    return actor;
  }

  /**
   * Org with the requester's role. Only members may read it (PII: org requisites).
   * Fail-closed — an empty userId is unauthenticated, not "skip the membership
   * check" (contract control.md §1 S-1/M-1).
   */
  async get(id: string, userId?: string) {
    const actor = this.assertActor(userId);
    const org = await this.prisma.systemSettings.findUnique({ where: { id } });
    if (!org) throw new AppError('notFound', 'Organization not found');
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: actor } },
      select: { role: true, isActive: true },
    });
    // Fail-closed: a deactivated (offboarded) member is NOT a member (FR-ORG-490).
    if (!employee?.isActive) {
      throw new AppError('access', 'You are not a member of this organization');
    }
    return { org, role: employee.role };
  }

  /**
   * P8-T4.1: gate an org-profile mutation on `org:profile:manage` through the PDP
   * instead of the binary `orgRoleCanManage`. Default behaviour is preserved
   * (owner/admin carry it; employee does not); a custom org role can now grant
   * profile management independently. Error code/message unchanged.
   */
  private async assertCanManage(organizationId: string, actorUserId: string | undefined) {
    const actor = this.assertActor(actorUserId);
    if (!(await this.pdp.canManage(organizationId, actor, 'org:profile'))) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }
  }

  /** Partial update of name + requisites. Requires owner/admin. */
  async update(id: string, data: { name?: string } & OrgRequisites, actorUserId?: string) {
    const existing = await this.prisma.systemSettings.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new AppError('notFound', 'Organization not found');
    await this.assertCanManage(id, actorUserId);
    const patch = pickDefined({
      name: data.name,
      inn: data.inn,
      kpp: data.kpp,
      ogrn: data.ogrn,
      legalAddress: data.legalAddress,
      actualAddress: data.actualAddress,
      phone: data.phone,
      email: data.email,
      logoUrl: data.logoUrl,
      description: data.description,
    });
    const org = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.systemSettings.update({ where: { id }, data: patch });
      await this.audit.record(
        {
          organizationId: id,
          actorUserId,
          action: 'organization.updated',
          entityType: 'organization',
          entityId: id,
          metadata: { fields: Object.keys(patch) },
        },
        tx,
      );
      return updated;
    });
    return { org };
  }

  /**
   * Deactivate the organization (FR-MORG-43, spec §3.3): soft state change
   * (isActive=false). Data is preserved — there is no hard-delete RPC. Only the
   * platform_owner may deactivate (OQ-MORG-6). Reactivation flips it back
   * (OQ-MORG-5). Audited via OrgAuditService, which projects the fact onto the
   * bus — deactivation emits the dedicated `control.org.deactivated` key
   * (control-event-map), reactivation/profile edits stay on `control.org.changed`.
   *
   * On deactivation the members' auth sessions are revoked in-process (fail-soft):
   * their tokens hit the gateway JTI deny-list immediately. If auth is unreachable
   * the deactivation is NOT rolled back — the sessions expire on their own TTL and
   * the emitted event lets consumers reconcile.
   */
  async setActive(id: string, isActive: boolean, actorUserId?: string) {
    const existing = await this.prisma.systemSettings.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!existing) throw new AppError('notFound', 'Organization not found');
    // Deactivation/reactivation is an owner-only action (not admin).
    const actor = this.assertActor(actorUserId);
    const employee = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: actor } },
      select: { role: true },
    });
    if (employee?.role !== 'platform_owner') {
      throw new AppError('access', 'Only the organization owner can do this');
    }
    const org = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.systemSettings.update({
        where: { id },
        data: { isActive },
      });
      await this.audit.record(
        {
          organizationId: id,
          actorUserId,
          action: isActive ? 'organization.reactivated' : 'organization.deactivated',
          entityType: 'organization',
          entityId: id,
        },
        tx,
      );
      return updated;
    });

    // Access cascade — only on deactivation. Collect the org's active members and
    // revoke their auth sessions. Fail-soft: revokeSessions never throws (returns
    // null on auth-down); the deactivation above is already committed.
    if (!isActive) {
      const members = await this.prisma.employee.findMany({
        where: { organizationId: id, isActive: true },
        select: { userId: true },
      });
      const userIds = [...new Set(members.map((m) => m.userId).filter(Boolean))];
      if (userIds.length > 0) {
        const revoked = await this.directory.revokeSessions(userIds);
        if (revoked === null) {
          this.logger.warn(
            `Org ${id} deactivated but session revocation failed for ${userIds.length} member(s) — auth unreachable; tokens will lapse on TTL.`,
          );
        }
      }
    }

    return { org };
  }

  async listMy(userId: string) {
    if (!userId) return [];
    // box is single-tenant: one implicit organization = the System. The former
    // Organization relation is gone — resolve the singleton SystemSettings once and
    // attach the caller's employee role per membership row.
    const rows = await this.prisma.employee.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const system = await this.prisma.systemSettings.findUnique({
      where: { id: rows[0].organizationId },
    });
    if (!system) return [];
    return (
      rows
        // Offboarded (isActive=false) memberships grant nothing (FR-ORG-490).
        .filter((row) => row.organizationId === system.id && row.isActive)
        .map((row) => ({
          id: system.id,
          name: system.name,
          slug: system.slug,
          role: row.role,
        }))
    );
  }

  /**
   * DEORG-BE-16 (движок доступа org→system): resolve the single system anchor id
   * — the id of the `SystemSettings` singleton. box is single-tenant: the instance
   * IS the one implicit organization (the System), so a client-supplied
   * `organization_id` is untrusted and MUST NOT select scope. Every org-scoped
   * gRPC method resolves the anchor here and IGNORES the request body, severing the
   * organizationId thread from untrusted input (defense-in-depth ahead of the
   * gateway setting x-organization-id server-side in W3). Throws pre-bootstrap
   * (no system row yet) — these methods are only reachable after bootstrap.
   */
  async resolveSystemAnchorId(): Promise<string> {
    const system = await this.prisma.systemSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!system) {
      throw new AppError('access', 'System is not initialized — bootstrap required');
    }
    return system.id;
  }
}
