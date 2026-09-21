import { ProjectInvitationsService } from './project-invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { ProjectAccessEpochService } from './project-access-epoch.service';
import { hashInvitationToken } from '../organizations/invitation-token.util';

describe('ProjectInvitationsService (FR-PROJ-250)', () => {
  it('accept atomically creates membership and closes invitation', async () => {
    const plaintext = 'plain-token';
    const hash = hashInvitationToken(plaintext);
    const invitation = {
      id: 'inv-1',
      projectId: 'p1',
      email: 'a@b.c',
      role: 'member',
      token: hash,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    };
    const tx = {
      projectInvitation: {
        findUnique: jest.fn(async () => invitation),
        update: jest.fn(async () => ({ ...invitation, status: 'accepted' })),
      },
      projectMember: {
        upsert: jest.fn(async () => ({ id: 'pm-1' })),
      },
    };
    const prisma = {
      projectInvitation: {
        findUnique: jest.fn(async ({ where }: { where: { token: string } }) =>
          where.token === hash ? invitation : null,
        ),
      },
      project: { findUnique: jest.fn(async () => ({ name: 'Demo' })) },
      $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    };
    const epoch = { bump: jest.fn() } as unknown as ProjectAccessEpochService;
    const projects = {
      assertProjectWritable: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectsService;
    const svc = new ProjectInvitationsService(prisma as unknown as PrismaService, projects, epoch);
    const r = await svc.accept(plaintext, 'user-1');
    expect(tx.projectMember.upsert).toHaveBeenCalled();
    expect(tx.projectInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'accepted',
          acceptedUserId: 'user-1',
        }),
      }),
    );
    expect(epoch.bump).toHaveBeenCalledWith('p1');
    expect(r.projectId).toBe('p1');
  });
});
