import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FR-ORG-150: colleague directory returns structural fields only (no role/email).
 */
describe('OrgStructureService.listColleagueDirectory (FR-ORG-150)', () => {
  function makeService(seed: {
    employees?: Array<{
      organizationId: string;
      userId: string;
      departmentId?: string | null;
      isActive?: boolean;
    }>;
    departments?: Array<{
      id: string;
      name: string;
      leaderUserId?: string | null;
    }>;
  }) {
    const prisma = {
      employee: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          (seed.employees ?? []).filter(
            (e) =>
              e.organizationId === where.organizationId &&
              (where.isActive === undefined || e.isActive !== false),
          ),
        ),
      },
      department: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          (seed.departments ?? []).filter((d) => where.id.in.includes(d.id)),
        ),
      },
    } as unknown as PrismaService;
    const pdp = { ensureSystemOrgRoles: jest.fn() } as unknown as OrgPdpService;
    const bindings = {
      bindingMembershipAddEmployee: jest.fn().mockResolvedValue([]),
      bindingMembershipRemoveEmployee: jest.fn().mockResolvedValue([]),
    } as never;
    const epoch = { bump: jest.fn(), bumpOrgProjects: jest.fn() } as never;
    const directory = { revokeSessions: jest.fn() } as never;
    const events = { emit: jest.fn() } as never;
    const svc = new OrgStructureService(
      prisma,
      {} as OrgAuditService,
      {} as SeatsService,
      pdp,
      bindings,
      epoch,
      directory,
      events,
    );
    jest
      .spyOn(svc as never as { assertMember: () => Promise<void> }, 'assertMember')
      .mockResolvedValue();
    return { svc, prisma };
  }

  it('returns active colleagues with department and manager ids', async () => {
    const { svc } = makeService({
      employees: [
        { organizationId: 'org-1', userId: 'u-1', departmentId: 'd-1', isActive: true },
        { organizationId: 'org-1', userId: 'u-2', departmentId: null, isActive: true },
        { organizationId: 'org-1', userId: 'u-off', departmentId: 'd-1', isActive: false },
      ],
      departments: [{ id: 'd-1', name: 'Sales', leaderUserId: 'u-boss' }],
    });
    const list = await svc.listColleagueDirectory('org-1', 'u-1');
    expect(list).toEqual([
      {
        userId: 'u-1',
        departmentId: 'd-1',
        departmentName: 'Sales',
        managerUserId: 'u-boss',
      },
      {
        userId: 'u-2',
        departmentId: '',
        departmentName: '',
        managerUserId: '',
      },
    ]);
  });
});
