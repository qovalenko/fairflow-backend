import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prisma: {
    project: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    projectMember: { findMany: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock };
    employee: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let provisioning: { provisionFromTemplate: jest.Mock };
  let events: { emit: jest.Mock };
  let roleAudit: { append: jest.Mock };

  beforeEach(async () => {
    prisma = {
      project: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      projectMember: {
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        // TODO-085: `update` is PEP-gated now — the actor must hold project
        // `manage`. Default the membership to owner; the fail-closed cases
        // override it explicitly.
        findUnique: jest.fn().mockResolvedValue({ role: 'owner' }),
      },
      // DEORG-W1: create() runs the single fail-closed IDOR path — the creator must
      // be an active org owner/admin of the System. Default the membership to that.
      employee: {
        findUnique: jest.fn().mockResolvedValue({ role: 'platform_owner', isActive: true }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // create() wraps its writes in a transaction; run the callback against the
      // same mock so project.create / projectMember.upsert stubs are exercised.
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    provisioning = { provisionFromTemplate: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn().mockResolvedValue(undefined) };
    roleAudit = { append: jest.fn().mockResolvedValue('audit-1') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProjectProvisioningService, useValue: provisioning },
        {
          provide: AutomationLifecycleService,
          useValue: {
            syncModuleTransitions: jest.fn().mockResolvedValue(undefined),
            syncArchiveTransition: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ControlEventEmitter, useValue: events },
        { provide: RoleAuditService, useValue: roleAudit },
        {
          provide: MemberOwnedRecordsService,
          useValue: {
            countOwned: jest.fn().mockResolvedValue({ total: 0, breakdown: [] }),
            reassignOwned: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(ProjectsService);
  });

  it('create sets System ownership (ownerId) for an org owner/admin', async () => {
    prisma.project.create.mockResolvedValue({
      id: 'proj-1',
      ownerId: 'org-1',
      name: 'Test',
      modules: ['deals', 'contacts'],
      moduleConfigs: [
        {
          moduleId: 'contacts',
          enabled: true,
          personalSettings: {},
          integrationSettings: {},
          integrationMethodsEnabled: [],
        },
      ],
      modulePolicies: [],
    });
    const result = await service.create({
      // DEORG-W1: ownerId is the System anchor (supplied by the gateway); the
      // creator must be an active org owner/admin (mocked above).
      ownerId: 'org-1',
      name: 'Test',
      // Д-7 invariant: a project must have an owner; gateway always supplies it.
      createdByUserId: 'user-1',
    });
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 'org-1',
        name: 'Test',
        provisioningStatus: 'pending',
      }),
    });
    expect(result.ownerId).toBe('org-1');
    expect(result.modules).toContain('deals');
  });

  it('create rejects a non-manager (IDOR fail-closed)', async () => {
    prisma.employee.findUnique.mockResolvedValue({ role: 'employee', isActive: true });
    await expect(
      service.create({ ownerId: 'org-1', name: 'Test', createdByUserId: 'rank-and-file' }),
    ).rejects.toMatchObject({ errorCode: 'access' });
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('getMyAccess aggregates role and visibility per membership (FR-PROFILE-280)', async () => {
    prisma.projectMember.findMany.mockResolvedValue([
      {
        projectId: 'p1',
        role: 'member',
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
        project: {
          name: 'Alpha',
          visibilityConfig: { member: 'only_own' },
        },
      },
    ]);
    const rows = await service.getMyAccess('user-1');
    expect(rows).toEqual([
      {
        projectId: 'p1',
        projectName: 'Alpha',
        role: 'member',
        visibilityLevel: 'only_own',
        joinedAt: '2026-01-15T10:00:00.000Z',
      },
    ]);
  });

  it('findByOwner returns projects for owner', async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'p1',
        name: 'P1',
        ownerId: 'org-1',
        modules: ['deals'],
        moduleConfigs: [],
        modulePolicies: [],
      },
    ]);
    const list = await service.findByOwner('org-1');
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: 'org-1' },
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].ownerId).toBe('org-1');
  });

  it('update rejects mutations on archived projects (FR-PROJ-120)', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'owner' });
    prisma.project.findUnique.mockResolvedValueOnce({ status: 'archived' }).mockResolvedValueOnce({
      id: 'p1',
      ownerId: 'u1',
      name: 'P1',
      templateId: null,
      modules: ['deals'],
      moduleConfigs: [],
      modulePolicies: [],
      isArchived: true,
      status: 'archived',
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
    });
    await expect(service.update('p1', { name: 'New' }, 'actor-1')).rejects.toMatchObject({
      errorCode: 'locked',
    });
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('requestDeletion rejects a confirmName that does not match the project name (FR-PROJ-170)', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'owner' });
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      ownerId: 'org-1',
      name: 'Правильное имя',
      templateId: null,
      modules: ['deals'],
      moduleConfigs: [],
      modulePolicies: [],
      isArchived: false,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
    });
    await expect(
      service.requestDeletion('p1', 'actor-1', 'Неправильное имя'),
    ).rejects.toMatchObject({ errorCode: 'invalid' });
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('update validates policies and keeps only allowed module capabilities', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'owner' });
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      ownerType: 'PERSONAL',
      ownerId: 'u1',
      name: 'P1',
      templateId: null,
      modules: ['deals', 'contacts'],
      moduleConfigs: [
        {
          moduleId: 'contacts',
          enabled: true,
          personalSettings: {},
          integrationSettings: {},
          integrationMethodsEnabled: [],
        },
      ],
      modulePolicies: [],
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
    });
    prisma.project.update.mockResolvedValue({
      id: 'p1',
      ownerType: 'PERSONAL',
      ownerId: 'u1',
      name: 'P1',
      templateId: null,
      modules: ['deals', 'contacts'],
      moduleConfigs: [],
      modulePolicies: [
        {
          id: 'rule-allow',
          moduleId: 'contacts',
          effect: 'allow',
          subject: 'contacts',
          action: 'read',
          resource: '*',
          condition: {},
        },
      ],
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.update(
      'p1',
      {
        modulePolicies: [
          {
            id: 'rule-allow',
            moduleId: 'contacts',
            effect: 'allow',
            subject: 'contacts',
            action: 'read',
            resource: '*',
            condition: {},
          },
          {
            id: 'rule-rejected',
            moduleId: 'contacts',
            effect: 'allow',
            subject: 'contacts',
            action: 'run-admin-script',
            resource: '*',
            condition: {},
          },
        ],
      },
      'owner-1',
    );

    const updateArg = prisma.project.update.mock.calls[0][0] as {
      data: { modulePolicies: unknown[] };
    };
    const savedPolicies = updateArg.data.modulePolicies;
    expect(Array.isArray(savedPolicies)).toBe(true);
    expect(savedPolicies).toHaveLength(1);
  });
});
