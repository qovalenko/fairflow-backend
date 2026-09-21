import { Injectable } from '@nestjs/common';
import { newEntityId, projectRoleCan } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { RoleAuditService } from '../outbox/role-audit.service';

const SHAREABLE_RESOURCES = new Set(['contacts', 'companies', 'deals', 'orders', 'activities']);
const GRANTEE_TYPES = new Set(['user', 'department', 'unit']);

/**
 * Phase 4d / E2-11: explicit per-record sharing grants (spec §13.4). A RecordShare
 * is an access-**grant** ("record ↔ user/unit"), NOT ownership: it extends a
 * record's visibility to specific subjects on top of the VisibilityPolicy without
 * touching ownerId. Control owns the table; the visibility resolver folds the
 * viewer's *active* grants into the scope so CRM domains never query sharing.
 *
 * Carrying invariant (OQ-ACCESS-030 / FR-ACCESS-400): share/unshare is allowed for
 * project owner/admin (`manage`), managers, the record owner, and managers revoking
 * a subordinate's grant (FR-ACCESS-420).
 */
@Injectable()
export class RecordSharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleAudit: RoleAuditService,
  ) {}

  private async memberRole(projectId: string, actorUserId: string): Promise<string> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actorUserId } },
      select: { role: true },
    });
    return member?.role ?? '';
  }

  /**
   * FR-ACCESS-400: owner/admin (manage), manager, or the record owner may share.
   */
  private async assertCanShare(
    projectId: string,
    actorUserId: string,
    recordOwnerUserId?: string,
  ): Promise<void> {
    const actor = (actorUserId ?? '').trim();
    if (!actor) throw new AppError('auth', 'Authentication required');

    const role = await this.memberRole(projectId, actor);
    if (!role) throw new AppError('access', 'Sharing a record requires project membership');
    if (projectRoleCan(role, 'manage')) return;
    if (role === 'manager') return;
    const owner = (recordOwnerUserId ?? '').trim();
    if (owner && owner === actor) return;

    throw new AppError(
      'access',
      'Sharing a record requires manage rights, manager role, or record ownership',
    );
  }

  /**
   * FR-ACCESS-420: owner/admin, manager (incl. revoking subordinate grants), or the
   * share creator may unshare.
   */
  private async assertCanUnshare(
    projectId: string,
    actorUserId: string,
    share: { createdBy: string | null },
  ): Promise<void> {
    const actor = (actorUserId ?? '').trim();
    if (!actor) throw new AppError('auth', 'Authentication required');

    const role = await this.memberRole(projectId, actor);
    if (!role) throw new AppError('access', 'Revoking a share requires project membership');
    if (projectRoleCan(role, 'manage')) return;
    if (share.createdBy === actor) return;
    if (role === 'manager' && share.createdBy && share.createdBy !== actor) {
      const creatorRole = await this.memberRole(projectId, share.createdBy);
      // Empty creatorRole = leaver: manager may still revoke the orphaned grant.
      if (!creatorRole || (creatorRole !== 'manager' && !projectRoleCan(creatorRole, 'manage'))) {
        return;
      }
    }

    throw new AppError(
      'access',
      'Revoking a share requires manage rights, manager role, or share ownership',
    );
  }

  async share(
    projectId: string,
    resource: string,
    recordId: string,
    granteeType: string,
    granteeId: string,
    actorUserId: string,
    expiresAt?: Date | null,
    recordOwnerUserId?: string,
  ) {
    if (!projectId || !recordId || !granteeId) {
      throw new AppError('invalid', 'projectId, recordId and granteeId are required');
    }
    if (!SHAREABLE_RESOURCES.has(resource)) {
      throw new AppError('invalid', `Resource "${resource}" cannot be shared`);
    }
    if (!GRANTEE_TYPES.has(granteeType)) {
      throw new AppError('invalid', 'granteeType must be "user", "department" or "unit"');
    }
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new AppError('invalid', 'expiresAt is not a valid date');
    }
    await this.assertCanShare(projectId, actorUserId, recordOwnerUserId);

    return this.prisma.$transaction(async (tx) => {
      const share = await tx.recordShare.upsert({
        where: {
          projectId_resource_recordId_granteeType_granteeId: {
            projectId,
            resource,
            recordId,
            granteeType,
            granteeId,
          },
        },
        create: {
          id: newEntityId(),
          projectId,
          resource,
          recordId,
          granteeType,
          granteeId,
          createdBy: actorUserId,
          expiresAt: expiresAt ?? null,
        },
        update: { expiresAt: expiresAt ?? null },
      });

      await this.roleAudit.append(tx, {
        projectId,
        actorUserId,
        action: 'share.created',
        entityType: 'record_share',
        entityId: share.id,
        summary: `shared ${resource}/${recordId} with ${granteeType} ${granteeId}`,
        before: null,
        after: {
          resource,
          recordId,
          granteeType,
          granteeId,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
        routingKey: 'control.record.shared',
      });
      return share;
    });
  }

  /** Active (non-expired) grants for a record, newest-first. */
  async list(projectId: string, resource: string, recordId: string) {
    return this.prisma.recordShare.findMany({
      where: {
        projectId,
        resource,
        recordId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async unshare(id: string, projectId: string, actorUserId: string) {
    if (!id) throw new AppError('invalid', 'id required');
    if (!projectId) throw new AppError('invalid', 'projectId required');

    const existing = await this.prisma.recordShare.findFirst({
      where: { id, projectId },
      select: {
        resource: true,
        recordId: true,
        granteeType: true,
        granteeId: true,
        createdBy: true,
      },
    });
    if (existing) {
      await this.assertCanUnshare(projectId, actorUserId, existing);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.recordShare.deleteMany({ where: { id, projectId } });

      if (existing) {
        await this.roleAudit.append(tx, {
          projectId,
          actorUserId,
          action: 'share.revoked',
          entityType: 'record_share',
          entityId: id,
          summary: `revoked ${existing.resource}/${existing.recordId} from ${existing.granteeType} ${existing.granteeId}`,
          before: {
            resource: existing.resource,
            recordId: existing.recordId,
            granteeType: existing.granteeType,
            granteeId: existing.granteeId,
          },
          after: null,
          routingKey: 'control.record.unshared',
        });
      }
    });
    return { ok: true };
  }
}
