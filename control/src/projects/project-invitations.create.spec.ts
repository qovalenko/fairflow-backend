import { ProjectInvitationsService } from './project-invitations.service';
import { AppError } from '@fairflow/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from './projects.service';
import type { ProjectAccessEpochService } from './project-access-epoch.service';

describe('ProjectInvitationsService.create', () => {
  function makeService() {
    const tx = {
      projectInvitation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'inv-1',
          ...data,
        })),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const projects = {
      assertCanManage: jest.fn().mockResolvedValue(undefined),
      assertProjectWritable: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue({ name: 'Demo Project' }),
    } as unknown as ProjectsService;
    const epoch = {} as unknown as ProjectAccessEpochService;
    const service = new ProjectInvitationsService(prisma, projects, epoch);
    return { service, tx, projects };
  }

  it('rejects invalid email addresses', async () => {
    const { service } = makeService();
    await expect(
      service.create('p1', 'not-an-email', 'member', 'admin', 'admin'),
    ).rejects.toMatchObject({ errorCode: 'invalid' } satisfies Partial<AppError>);
  });

  it('revokes pending invites and mints a new hashed token', async () => {
    const { service, tx, projects } = makeService();
    const result = await service.create('p1', 'User@Example.com', 'admin', 'inviter', 'admin');

    expect(projects.assertCanManage).toHaveBeenCalledWith('p1', 'admin');
    expect(tx.projectInvitation.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', email: 'user@example.com', status: 'pending' },
      data: { status: 'revoked' },
    });
    expect(tx.projectInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'p1',
          email: 'user@example.com',
          role: 'admin',
          status: 'pending',
        }),
      }),
    );
    expect(result.projectName).toBe('Demo Project');
    expect(result.emailToken).toEqual(expect.any(String));
  });
});
