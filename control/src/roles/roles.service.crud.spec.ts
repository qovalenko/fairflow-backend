import {
  ALL_MODULE_IDS,
  AppError,
  buildProjectCatalogWithSystem,
  expandSystemRolePermissions,
  SYSTEM_PROJECT_ROLE_KEYS,
} from '@fairflow/shared';
import { RolesService, invalidateSystemRoleSync } from './roles.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from '../projects/projects.service';
import type { OrgPdpService } from '../organizations/org-pdp.service';
import type { RoleAuditService } from '../outbox/role-audit.service';

const PROJECT = 'proj-1';
const CATALOG = buildProjectCatalogWithSystem(ALL_MODULE_IDS);

describe('RolesService CRUD and system-role sync', () => {
  beforeEach(() => {
    invalidateSystemRoleSync();
    delete process.env.CONTROL_SYSTEM_ROLE_SYNC_TTL_MS;
  });

  function makeService(opts?: {
    roles?: Array<Record<string, unknown>>;
    duplicateName?: boolean;
    resolveEffective?: Record<string, unknown>;
  }) {
    const roleRows = opts?.roles ?? [];
    const roleState = new Map<string, Record<string, unknown>>();
    const permissionRows: Array<Record<string, unknown>> = [];

    const tx = {
      role: {
        findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if ('scopeType_scopeId_key' in where) {
            const w = where.scopeType_scopeId_key as Record<string, string>;
            return (
              roleRows.find(
                (r) => r.scopeType === w.scopeType && r.scopeId === w.scopeId && r.key === w.key,
              ) ?? null
            );
          }
          const byId = roleState.get((where as { id: string }).id);
          if (byId) {
            return {
              ...byId,
              permissions: permissionRows.filter((p) => p.roleId === byId.id),
            };
          }
          return null;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const now = new Date('2026-01-01T00:00:00.000Z');
          const row = {
            ...data,
            createdAt: now,
            updatedAt: now,
            permissions: [] as unknown[],
          };
          roleState.set(String(data.id), row);
          roleRows.push(row);
          return row;
        }),
        findMany: jest.fn(async () =>
          roleRows
            .filter((r) => r.scopeId === PROJECT && !r.isArchived)
            .map((r) => ({
              ...r,
              permissions: permissionRows.filter((p) => p.roleId === r.id),
            })),
        ),
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (opts?.duplicateName) {
            return { id: 'dup', name: where.name };
          }
          return null;
        }),
      },
      rolePermission: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn(async ({ data }: { data: unknown[] }) => {
          for (const row of data as Array<Record<string, unknown>>) {
            permissionRows.push(row);
          }
          return { count: data.length };
        }),
      },
    };

    const prisma = {
      role: tx.role,
      rolePermission: tx.rolePermission,
      permissionGrant: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    const projects = {
      findOne: jest.fn().mockResolvedValue({
        id: PROJECT,
        effectiveModules: ALL_MODULE_IDS,
      }),
    } as unknown as ProjectsService;

    const roleAudit = {
      append: jest.fn().mockResolvedValue(undefined),
    } as unknown as RoleAuditService;
    const service = new RolesService(prisma, projects, {} as OrgPdpService, roleAudit);

    jest.spyOn(service, 'resolveEffective').mockResolvedValue(
      (opts?.resolveEffective ?? {
        role: 'owner',
        effective: { allow: CATALOG.keys, deny: [] },
        allow: CATALOG.keys,
        deny: [],
        catalog: CATALOG,
      }) as never,
    );

    return { service, prisma, tx, roleAudit, projects };
  }

  it('ensureSystemRoles creates and syncs all system roles for a project', async () => {
    const { service, tx } = makeService();
    const ids = await service.ensureSystemRoles(PROJECT, CATALOG);
    expect(ids.size).toBe(SYSTEM_PROJECT_ROLE_KEYS.length);
    expect(tx.role.create).toHaveBeenCalledTimes(SYSTEM_PROJECT_ROLE_KEYS.length);
    for (const key of SYSTEM_PROJECT_ROLE_KEYS) {
      expect(ids.get(key)).toBeTruthy();
      expect(expandSystemRolePermissions(key, CATALOG).length).toBeGreaterThan(0);
    }
  });

  it('ensureSystemRoles memoizes unchanged catalog within TTL', async () => {
    process.env.CONTROL_SYSTEM_ROLE_SYNC_TTL_MS = '60000';
    const { service, prisma } = makeService();
    await service.ensureSystemRoles(PROJECT, CATALOG);
    await service.ensureSystemRoles(PROJECT, CATALOG);
    expect(prisma.$transaction).toHaveBeenCalledTimes(SYSTEM_PROJECT_ROLE_KEYS.length);
  });

  it('listRoles returns non-archived project roles with permission keys', async () => {
    const { service } = makeService({
      roles: [
        {
          id: 'role-1',
          scopeType: 'project',
          scopeId: PROJECT,
          key: 'member',
          name: 'Member',
          kind: 'system',
          isArchived: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    jest.spyOn(service, 'ensureSystemRoles').mockResolvedValue(new Map());
    const roles = await service.listRoles(PROJECT);
    expect(roles).toHaveLength(1);
    expect(roles[0].key).toBe('member');
  });

  it('createRole rejects empty names', async () => {
    const { service } = makeService();
    await expect(
      service.createRole({ projectId: PROJECT, actorUserId: 'owner', name: '  ', permissions: [] }),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { code: 'INVALID_ARGUMENT' } });
  });

  it('createRole rejects duplicate role names within a project', async () => {
    const { service } = makeService({ duplicateName: true });
    await expect(
      service.createRole({
        projectId: PROJECT,
        actorUserId: 'owner',
        name: 'Sales',
        permissions: ['deals:read'],
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { code: 'ROLE_NAME_TAKEN' } });
  });

  it('createRole rejects permissions outside the actor effective allow-set', async () => {
    const { service } = makeService({
      resolveEffective: {
        role: 'member',
        effective: { allow: ['deals:read'], deny: [] },
        allow: ['deals:read'],
        deny: [],
        catalog: CATALOG,
      },
    });
    await expect(
      service.createRole({
        projectId: PROJECT,
        actorUserId: 'member-1',
        name: 'Escalator',
        permissions: ['deals:delete'],
      }),
    ).rejects.toMatchObject({
      errorCode: 'access',
      details: { code: 'SELF_ESCALATION_DENIED' },
    } satisfies Partial<AppError>);
  });

  it('createRole persists a custom role and returns lint warnings', async () => {
    const { service, tx } = makeService();
    const result = await service.createRole({
      projectId: PROJECT,
      actorUserId: 'owner-1',
      name: 'Reader',
      permissions: ['deals:delete'],
    });
    expect(result.role.name).toBe('Reader');
    expect(result.warnings).toContain('deals: delete/manage without read');
    expect(tx.role.create).toHaveBeenCalled();
  });

  it('listGrants maps permission grant rows for a project', async () => {
    const prisma = {
      permissionGrant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'g1',
            projectId: PROJECT,
            moduleId: 'project',
            effect: 'allow',
            subject: 'deals',
            action: 'read',
            resource: '*',
            granteeType: 'member',
            granteeId: 'u1',
            createdBy: 'admin',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      },
    } as unknown as PrismaService;
    const service = new RolesService(
      prisma,
      {} as ProjectsService,
      {} as OrgPdpService,
      {} as RoleAuditService,
    );
    const grants = await service.listGrants(PROJECT);
    expect(grants).toEqual([
      expect.objectContaining({
        id: 'g1',
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        granteeId: 'u1',
      }),
    ]);
  });
});
