import { RolesService, invalidateSystemRoleSync } from './roles.service';
import { buildProjectCatalogWithSystem } from '@fairflow/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from '../projects/projects.service';
import type { OrgPdpService } from '../organizations/org-pdp.service';
import type { RoleAuditService } from '../outbox/role-audit.service';

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    buildProjectCatalogWithSystem: jest.fn(),
  };
});

const buildCatalogMock = buildProjectCatalogWithSystem as jest.Mock;

describe('RolesService catalog surface', () => {
  let projects: { findOne: jest.Mock };
  let service: RolesService;

  beforeEach(() => {
    invalidateSystemRoleSync();
    projects = {
      findOne: jest.fn().mockResolvedValue({
        id: 'proj-1',
        effectiveModules: ['deals', 'contacts'],
        modules: ['deals'],
      }),
    };
    buildCatalogMock.mockReturnValue({ subjects: [], actions: [] });
    service = new RolesService(
      {} as PrismaService,
      projects as unknown as ProjectsService,
      {} as OrgPdpService,
      {} as RoleAuditService,
    );
  });

  it('builds the permission catalog from effective project modules', async () => {
    await service.getCatalog('proj-1');
    expect(projects.findOne).toHaveBeenCalledWith('proj-1');
    expect(buildCatalogMock).toHaveBeenCalledWith(['deals', 'contacts']);
  });

  it('falls back to modules when effectiveModules is absent', async () => {
    projects.findOne.mockResolvedValue({ id: 'proj-1', modules: ['orders'] });
    await service.getCatalog('proj-1');
    expect(buildCatalogMock).toHaveBeenCalledWith(['orders']);
  });
});

describe('invalidateSystemRoleSync', () => {
  it('clears memoized sync state for one project or all projects', () => {
    expect(() => invalidateSystemRoleSync('proj-1')).not.toThrow();
    expect(() => invalidateSystemRoleSync()).not.toThrow();
  });
});
