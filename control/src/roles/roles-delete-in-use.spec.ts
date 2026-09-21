import { RolesService } from './roles.service';
import { AppError } from '@fairflow/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from '../projects/projects.service';
import type { OrgPdpService } from '../organizations/org-pdp.service';
import type { RoleAuditService } from '../outbox/role-audit.service';

/**
 * FR-ORG-380: deleting a project role that is still assigned must fail with
 * ROLE_IN_USE (→ HTTP 409 via conflict + gateway explicit code promotion).
 */
describe('RolesService.deleteRole — ROLE_IN_USE (FR-ORG-380)', () => {
  function makeService(inUseCount: number, boundCount = 0) {
    const prisma = {
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'role-1',
          key: 'custom_sales',
          name: 'Sales',
          scopeId: 'proj-1',
          scopeType: 'project',
          kind: 'custom',
        }),
        update: jest.fn(),
      },
      roleAssignment: {
        count: jest.fn().mockResolvedValue(inUseCount),
      },
      departmentProjectBinding: {
        count: jest.fn().mockResolvedValue(boundCount),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    } as unknown as PrismaService;

    const service = new RolesService(
      prisma,
      {} as ProjectsService,
      {} as OrgPdpService,
      { append: jest.fn().mockResolvedValue(undefined) } as unknown as RoleAuditService,
    );

    return { service, prisma };
  }

  it('rejects delete when the role has active assignments', async () => {
    const { service } = makeService(2);
    await expect(
      service.deleteRole({ projectId: 'proj-1', actorUserId: 'admin', roleId: 'role-1' }),
    ).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { code: 'ROLE_IN_USE' },
    } satisfies Partial<AppError>);
  });

  it('rejects delete when the role is referenced by a department binding', async () => {
    const { service } = makeService(0, 1);
    await expect(
      service.deleteRole({ projectId: 'proj-1', actorUserId: 'admin', roleId: 'role-1' }),
    ).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { code: 'ROLE_IN_USE' },
    });
  });

  it('archives the role when it is not in use', async () => {
    const { service, prisma } = makeService(0, 0);
    await service.deleteRole({ projectId: 'proj-1', actorUserId: 'admin', roleId: 'role-1' });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { isArchived: true },
    });
  });
});
