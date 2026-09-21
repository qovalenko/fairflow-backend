import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';

describe('ProjectsService provisioning status (FR-PROJ-095)', () => {
  it('marks provisioning complete after successful template provisioning', async () => {
    const prisma = {
      project: { update: jest.fn().mockResolvedValue({}) },
    };
    const provisioning = {
      provisionFromTemplate: jest.fn().mockResolvedValue(true),
    } as unknown as ProjectProvisioningService;
    const service = new ProjectsService(
      prisma as unknown as PrismaService,
      provisioning,
      {
        syncModuleTransitions: jest.fn(),
        syncArchiveTransition: jest.fn(),
      } as unknown as AutomationLifecycleService,
      { emit: jest.fn() } as unknown as ControlEventEmitter,
      { append: jest.fn() } as unknown as RoleAuditService,
      {
        countOwned: jest.fn(),
        reassignOwned: jest.fn(),
      } as unknown as MemberOwnedRecordsService,
    );
    await (
      service as unknown as { runTemplateProvisioning: (...a: unknown[]) => Promise<void> }
    ).runTemplateProvisioning('p1', 'tpl-1', ['contacts']);
    expect(provisioning.provisionFromTemplate).toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { provisioningStatus: 'complete' },
    });
  });

  it('marks provisioning failed when provisionFromTemplate returns false', async () => {
    const prisma = {
      project: { update: jest.fn().mockResolvedValue({}) },
    };
    const provisioning = {
      provisionFromTemplate: jest.fn().mockResolvedValue(false),
    } as unknown as ProjectProvisioningService;
    const service = new ProjectsService(
      prisma as unknown as PrismaService,
      provisioning,
      {
        syncModuleTransitions: jest.fn(),
        syncArchiveTransition: jest.fn(),
      } as unknown as AutomationLifecycleService,
      { emit: jest.fn() } as unknown as ControlEventEmitter,
      { append: jest.fn() } as unknown as RoleAuditService,
      {
        countOwned: jest.fn(),
        reassignOwned: jest.fn(),
      } as unknown as MemberOwnedRecordsService,
    );
    await (
      service as unknown as { runTemplateProvisioning: (...a: unknown[]) => Promise<void> }
    ).runTemplateProvisioning('p1', 'tpl-1', ['contacts']);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { provisioningStatus: 'failed' },
    });
  });
});
