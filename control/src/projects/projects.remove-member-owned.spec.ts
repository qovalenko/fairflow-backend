import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';
import { AppError } from '@fairflow/shared';

describe('ProjectsService.removeMember owned guard (FR-PROJ-215)', () => {
  const PROJECT = 'proj-1';

  function build(ownedTotal: number) {
    const prisma = {
      projectMember: {
        findUnique: jest.fn(async () => ({
          id: 'm-1',
          projectId: PROJECT,
          userId: 'target-1',
          role: 'member',
        })),
        count: jest.fn(async () => 1),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      project: {
        findUnique: jest.fn(async () => ({
          id: PROJECT,
          modules: ['contacts', 'deals'],
          moduleConfigs: [],
          modulePolicies: [],
          isArchived: false,
          status: 'active',
        })),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
    const ownedRecords = {
      countOwned: jest.fn().mockResolvedValue({ total: ownedTotal, breakdown: [] }),
      reassignOwned: jest.fn().mockResolvedValue(2),
    } as unknown as MemberOwnedRecordsService;
    const service = new ProjectsService(
      prisma as unknown as PrismaService,
      {} as ProjectProvisioningService,
      {
        syncModuleTransitions: jest.fn(),
        syncArchiveTransition: jest.fn(),
      } as unknown as AutomationLifecycleService,
      { emit: jest.fn() } as unknown as ControlEventEmitter,
      { append: jest.fn() } as unknown as RoleAuditService,
      ownedRecords,
    );
    jest.spyOn(service, 'assertCanManage').mockResolvedValue(undefined);
    jest.spyOn(service, 'assertProjectWritable').mockResolvedValue(undefined);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: PROJECT,
      effectiveModules: ['contacts', 'deals'],
      modules: ['contacts', 'deals'],
    } as never);
    return { service, prisma, ownedRecords };
  }

  it('blocks removal when member has owned records and no reassign target', async () => {
    const { service } = build(3);
    await expect(service.removeMember(PROJECT, 'target-1', 'actor-1')).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(service.removeMember(PROJECT, 'target-1', 'actor-1')).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { reason: 'OWNED_RECORDS' },
    });
  });

  it('reassigns owned records then removes membership when target provided', async () => {
    const { service, prisma, ownedRecords } = build(2);
    prisma.projectMember.findUnique
      .mockResolvedValueOnce({
        id: 'm-1',
        projectId: PROJECT,
        userId: 'target-1',
        role: 'member',
      })
      .mockResolvedValueOnce({
        id: 'm-2',
        projectId: PROJECT,
        userId: 'mgr-1',
        role: 'manager',
      });
    await service.removeMember(PROJECT, 'target-1', 'actor-1', 'mgr-1');
    expect(ownedRecords.reassignOwned).toHaveBeenCalledWith(PROJECT, 'target-1', 'mgr-1', [
      'contacts',
      'deals',
    ]);
    expect(prisma.projectMember.deleteMany).toHaveBeenCalled();
  });
});
