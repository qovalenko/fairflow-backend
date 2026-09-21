import { Test, type TestingModule } from '@nestjs/testing';
import { buildGatewayMetadata } from '@fairflow/testing';
import { ControlGrpcController } from './control.grpc.controller';
import { ProjectsService } from '../projects/projects.service';
import { ModuleDisableImpactService } from '../projects/module-disable-impact.service';
import { ModuleLifecycleService } from '../projects/module-lifecycle.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { OrgStructureService } from '../organizations/org-structure.service';
import { DepartmentBindingsService } from '../organizations/department-bindings.service';
import { InvitationService } from '../organizations/invitations.service';
import { OrgAuditService } from '../organizations/org-audit.service';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { RecordSharesService } from '../organizations/record-shares.service';
import { AccessUnitService } from '../organizations/access-unit.service';
import { SeatsService } from '../organizations/seats.service';
import { UserDirectoryService } from '../user-directory/user-directory.service';
import { RolesService } from '../roles/roles.service';
import { PdpService } from '../roles/pdp.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { ProjectInvitationsService } from '../projects/project-invitations.service';
import { GatewayApiKeyValidationService } from '../auth-validation/gateway-api-key-validation.service';

/**
 * REFERENCE — COMPONENT level (QA-CI T-026).
 *
 * Component = the real Nest wiring (controller resolved through a TestingModule)
 * with the boundaries (services, DB, other domains) replaced by mocks. This is the
 * level that catches transport/metadata/permission-plumbing bugs a pure unit test
 * cannot see.
 *
 * Here we pin the W0 IDOR fix on `ListMyProjects`: the subject MUST come from the
 * gateway-verified `x-user-id` metadata, NEVER the request body. We build metadata
 * with `buildGatewayMetadata` (the shared factory that mirrors exactly what the
 * gateway attaches) and prove a spoofed body `user_id` is ignored — a test that
 * fails the moment someone "trusts the body" again.
 */
describe('ControlGrpcController.listMyProjects (component)', () => {
  let controller: ControlGrpcController;
  let projects: { findMyProjects: jest.Mock };

  beforeEach(async () => {
    projects = { findMyProjects: jest.fn().mockResolvedValue([]) };

    // Every collaborator is an inert mock except ProjectsService — the boundary
    // this handler actually exercises.
    const stub = {};
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ControlGrpcController],
      providers: [
        { provide: ProjectsService, useValue: projects },
        { provide: ModuleDisableImpactService, useValue: stub },
        { provide: ModuleLifecycleService, useValue: stub },
        { provide: ProjectAccessEpochService, useValue: stub },
        { provide: OrganizationsService, useValue: stub },
        { provide: OrgStructureService, useValue: stub },
        { provide: DepartmentBindingsService, useValue: stub },
        { provide: InvitationService, useValue: stub },
        { provide: OrgAuditService, useValue: stub },
        { provide: OrgPdpService, useValue: stub },
        { provide: VisibilityResolverService, useValue: stub },
        { provide: RecordSharesService, useValue: stub },
        { provide: AccessUnitService, useValue: stub },
        { provide: SeatsService, useValue: stub },
        { provide: UserDirectoryService, useValue: stub },
        { provide: RolesService, useValue: stub },
        { provide: PdpService, useValue: stub },
        { provide: IntegrationsService, useValue: stub },
        { provide: ProjectInvitationsService, useValue: stub },
        {
          provide: GatewayApiKeyValidationService,
          useValue: { assertValidGatewayCall: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ControlGrpcController);
  });

  it('uses the trusted x-user-id metadata, ignoring a spoofed body user_id (IDOR)', async () => {
    projects.findMyProjects.mockResolvedValue([
      { id: 'p1', name: 'Mine', ownerId: 'alice', modules: [] },
    ]);
    const metadata = buildGatewayMetadata({ userId: 'alice' });

    const res = await controller.listMyProjects({ user_id: 'victim' }, metadata);

    // subject resolved from metadata, NOT the body
    expect(projects.findMyProjects).toHaveBeenCalledWith('alice');
    expect(projects.findMyProjects).not.toHaveBeenCalledWith('victim');
    expect(res.list).toHaveLength(1);
    // response is mapped to the snake_case wire shape
    expect(res.list[0]).toMatchObject({ id: 'p1', owner_id: 'alice', owner_type: 'ORGANIZATION' });
  });

  it('falls back to the body subject for internal callers with no user metadata (s2s)', async () => {
    const metadata = buildGatewayMetadata({ actorType: 'service', userId: '' });

    await controller.listMyProjects({ user_id: 'svc-subject' }, metadata);

    expect(projects.findMyProjects).toHaveBeenCalledWith('svc-subject');
  });

  it('returns an empty list (no DB hit) when no subject can be resolved', async () => {
    const metadata = buildGatewayMetadata({ actorType: 'service', userId: '' });

    const res = await controller.listMyProjects({}, metadata);

    expect(res.list).toEqual([]);
    expect(projects.findMyProjects).not.toHaveBeenCalled();
  });

  it('maps template_id from the stored project row (FR-PSET-330)', async () => {
    projects.findMyProjects.mockResolvedValue([
      {
        id: 'p1',
        name: 'Alpha',
        ownerId: 'alice',
        templateId: 'b2b-sales',
        modules: ['deals'],
        moduleConfigs: [],
        modulePolicies: [],
        visibilityConfig: {},
        effectiveModules: ['deals'],
        status: 'active',
        deletionScheduledAt: null,
      },
      {
        id: 'p2',
        name: 'Beta',
        ownerId: 'alice',
        templateId: null,
        modules: ['deals'],
        moduleConfigs: [],
        modulePolicies: [],
        visibilityConfig: {},
        effectiveModules: ['deals'],
        status: 'active',
        deletionScheduledAt: null,
      },
    ]);
    const metadata = buildGatewayMetadata({ userId: 'alice' });

    const res = await controller.listMyProjects({}, metadata);

    expect(res.list[0]).toMatchObject({ id: 'p1', template_id: 'b2b-sales' });
    expect(res.list[1]).toMatchObject({ id: 'p2', template_id: '' });
  });
});
