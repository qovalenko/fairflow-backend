import { Injectable } from '@nestjs/common';
import { newEntityId, isProjectRole, AppError } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { ProjectAccessEpochService } from './project-access-epoch.service';
import { hashInvitationToken, mintInvitationToken } from '../organizations/invitation-token.util';

const INVITE_TTL_DAYS = 7;

@Injectable()
export class ProjectInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly epoch: ProjectAccessEpochService,
  ) {}

  private expiry(): Date {
    return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  private async resolveByToken(plaintext: string) {
    const t = plaintext?.trim();
    if (!t) throw new AppError('invalid', 'token required');
    const hash = hashInvitationToken(t);
    let row = await this.prisma.projectInvitation.findUnique({ where: { token: hash } });
    if (!row) {
      row = await this.prisma.projectInvitation.findUnique({ where: { token: t } });
    }
    return row;
  }

  private normalizeRole(role: string | undefined): string {
    return isProjectRole(role) ? role : 'viewer';
  }

  async create(
    projectId: string,
    email: string,
    role: string | undefined,
    invitedByUserId: string,
    actorUserId?: string,
  ) {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      throw new AppError('invalid', 'A valid email is required');
    }
    await this.projects.assertCanManage(projectId, actorUserId);
    await this.projects.assertProjectWritable(projectId);
    const project = await this.projects.findOne(projectId);

    return this.prisma.$transaction(async (tx) => {
      await tx.projectInvitation.updateMany({
        where: { projectId, email: emailNorm, status: 'pending' },
        data: { status: 'revoked' },
      });
      const { plaintext, hash } = mintInvitationToken();
      const invitation = await tx.projectInvitation.create({
        data: {
          id: newEntityId(),
          projectId,
          email: emailNorm,
          role: this.normalizeRole(role),
          token: hash,
          status: 'pending',
          invitedByUserId: invitedByUserId || actorUserId || '',
          expiresAt: this.expiry(),
        },
      });
      return {
        invitation,
        projectName: (project as { name?: string }).name ?? '',
        emailToken: plaintext,
      };
    });
  }

  async getByToken(token: string) {
    const invitation = await this.resolveByToken(token);
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    const project = await this.prisma.project.findUnique({
      where: { id: invitation.projectId },
      select: { name: true },
    });
    const expired = invitation.expiresAt.getTime() < Date.now();
    return {
      ...invitation,
      projectName: project?.name ?? '',
      expired,
    };
  }

  /**
   * Atomically accept: create ProjectMember + close invitation (FR-PROJ-250).
   * Caller must supply the auth user resolved from the invitation email.
   */
  async accept(token: string, userId: string) {
    const invitation = await this.resolveByToken(token);
    if (!invitation) throw new AppError('notFound', 'Invitation not found');
    if (invitation.status !== 'pending') {
      throw new AppError('invalid', 'Invitation is no longer valid');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new AppError('invalid', 'Invitation has expired');
    }
    await this.projects.assertProjectWritable(invitation.projectId);
    const uid = userId?.trim();
    if (!uid) throw new AppError('auth', 'userId required');

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.projectInvitation.findUnique({ where: { id: invitation.id } });
      if (!current || current.status !== 'pending') {
        throw new AppError('invalid', 'Invitation is no longer valid');
      }
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: invitation.projectId, userId: uid } },
        create: {
          id: newEntityId(),
          projectId: invitation.projectId,
          userId: uid,
          role: invitation.role,
        },
        update: { role: invitation.role },
      });
      await tx.projectInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'accepted',
          acceptedUserId: uid,
          acceptedAt: new Date(),
        },
      });
    });
    await this.epoch.bump(invitation.projectId);
    const project = await this.prisma.project.findUnique({
      where: { id: invitation.projectId },
      select: { name: true },
    });
    return {
      projectId: invitation.projectId,
      projectName: project?.name ?? '',
      role: invitation.role,
    };
  }
}
