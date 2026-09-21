import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

/** FR-ORG-220 — getDepartmentSummary aggregates per department. */
describe('OrgStructureService.getDepartmentSummary (FR-ORG-220)', () => {
  const orgId = 'org-1';
  const deptId = 'dept-a';
  const actor = 'admin-1';

  function makePrisma(seed: {
    employees?: Array<{
      organizationId: string;
      userId: string;
      departmentId: string | null;
      isActive: boolean;
    }>;
    invitations?: Array<{
      id: string;
      organizationId: string;
      departmentId: string | null;
      status: string;
      expiresAt: Date;
    }>;
    department?: { id: string; organizationId: string } | null;
  }) {
    return {
      systemSettings: {
        findUnique: jest.fn(() => Promise.resolve({ isActive: true })),
      },
      employee: {
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: { organizationId_userId?: { organizationId: string; userId: string } };
          }) => {
            const key = where.organizationId_userId;
            if (!key) return Promise.resolve(null);
            if (key.userId === actor) {
              return Promise.resolve({
                organizationId: orgId,
                userId: actor,
                isActive: true,
                role: 'platform_admin',
                departmentId: null,
              });
            }
            return Promise.resolve(null);
          },
        ),
        count: jest.fn(
          ({
            where,
          }: {
            where: { organizationId?: string; departmentId?: string; isActive?: boolean };
          }) =>
            Promise.resolve(
              (seed.employees ?? []).filter(
                (e) =>
                  e.organizationId === where.organizationId &&
                  e.departmentId === where.departmentId &&
                  e.isActive === where.isActive,
              ).length,
            ),
        ),
      },
      department: {
        findFirst: jest.fn(() => Promise.resolve(seed.department ?? null)),
      },
      invitation: {
        count: jest.fn(
          ({
            where,
          }: {
            where: {
              organizationId: string;
              departmentId: string;
              status: string;
              expiresAt: { gt: Date };
            };
          }) =>
            Promise.resolve(
              (seed.invitations ?? []).filter(
                (i) =>
                  i.organizationId === where.organizationId &&
                  i.departmentId === where.departmentId &&
                  i.status === where.status &&
                  i.expiresAt > where.expiresAt.gt,
              ).length,
            ),
        ),
      },
    } as unknown as PrismaService;
  }

  function makeService(prisma: PrismaService) {
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    return new OrgStructureService(
      prisma,
      {} as OrgAuditService,
      {} as SeatsService,
      pdp,
      {} as import('./department-bindings.service').DepartmentBindingsService,
      {} as import('../projects/project-access-epoch.service').ProjectAccessEpochService,
      {} as import('../user-directory/user-directory.service').UserDirectoryService,
      {
        emit: jest.fn(),
      } as unknown as import('../outbox/control-event.emitter').ControlEventEmitter,
    );
  }

  it('returns employee and pending invitation counts for an existing department', async () => {
    const future = new Date(Date.now() + 86_400_000);
    const prisma = makePrisma({
      department: { id: deptId, organizationId: orgId },
      employees: [
        { organizationId: orgId, userId: 'u1', departmentId: deptId, isActive: true },
        { organizationId: orgId, userId: 'u2', departmentId: deptId, isActive: true },
        { organizationId: orgId, userId: 'u3', departmentId: deptId, isActive: false },
      ],
      invitations: [
        {
          id: 'inv-1',
          organizationId: orgId,
          departmentId: deptId,
          status: 'pending',
          expiresAt: future,
        },
      ],
    });
    const service = makeService(prisma);
    const summary = await service.getDepartmentSummary(orgId, deptId, actor);
    expect(summary).toEqual({
      employeeCount: 2,
      activeSeats: 2,
      pendingInvitations: 1,
      unassignedRecordsCount: 0,
    });
  });

  it('throws not_found when the department does not exist', async () => {
    const service = makeService(makePrisma({ department: null }));
    await expect(service.getDepartmentSummary(orgId, 'missing', actor)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
