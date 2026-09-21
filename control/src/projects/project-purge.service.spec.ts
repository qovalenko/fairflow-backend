import { ProjectPurgeService } from './project-purge.service';

type ProjectRow = {
  id: string;
  ownerType: string;
  ownerId: string;
  name: string;
  status: string;
  deletionScheduledAt: Date | null;
  moduleConfigs?: unknown;
  modules?: string[];
};

/** Minimal fake Prisma: a project store + no-op child-table deleteMany stubs. */
function makeFakePrisma(projects: ProjectRow[]) {
  const deleted: Record<string, number> = {};
  const del = (table: string) => async () => {
    deleted[table] = (deleted[table] ?? 0) + 1;
    return { count: 0 };
  };
  const projectApi = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: async ({ where }: any) => {
      return projects.filter((p) => {
        if (where.status && p.status !== where.status) return false;
        const sched = where.deletionScheduledAt;
        if (sched) {
          if (sched.not === null && p.deletionScheduledAt === null) return false;
          if (sched.lte && (p.deletionScheduledAt ?? new Date(0)) > sched.lte) return false;
        }
        return true;
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: async ({ where }: any) => projects.find((p) => p.id === where.id) ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: async ({ where, data }: any) => {
      const p = projects.find((x) => x.id === where.id);
      if (!p) throw new Error('not found');
      Object.assign(p, data);
      return p;
    },
  };
  const tx = {
    project: projectApi,
    projectMember: { deleteMany: del('projectMember') },
    recordShare: { deleteMany: del('recordShare') },
    roleAssignment: { deleteMany: del('roleAssignment') },
    permissionGrant: { deleteMany: del('permissionGrant') },
    rolePermission: { deleteMany: del('rolePermission') },
    role: { deleteMany: del('role') },
    accessUnitMember: { deleteMany: del('accessUnitMember') },
    accessUnit: { deleteMany: del('accessUnit') },
    projectIntegration: { deleteMany: del('projectIntegration') },
    projectApiKey: { deleteMany: del('projectApiKey') },
    $executeRaw: async () => 1, // advisory lock (void)
  };
  const prisma = {
    project: projectApi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: (t: any) => Promise<any>) => fn(tx),
    __deleted: deleted,
  };
  return prisma;
}

const day = 24 * 60 * 60 * 1000;

describe('ProjectPurgeService', () => {
  const now = new Date('2026-07-04T00:00:00.000Z');
  const past = new Date(now.getTime() - day); // schedule already elapsed
  const future = new Date(now.getTime() + day); // still within grace

  function makeService(projects: ProjectRow[]) {
    const prisma = makeFakePrisma(projects);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emit = jest.fn(async (_tx: unknown, _input: any): Promise<void> => undefined);
    const bump = jest.fn(async (_projectId: string): Promise<void> => undefined);
    const svc = new ProjectPurgeService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { emit } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { bump } as any,
    );
    return { svc, prisma, emit, bump };
  }

  describe('findDueProjects', () => {
    it('selects only pending_deletion projects whose schedule has elapsed', async () => {
      const projects: ProjectRow[] = [
        {
          id: 'due',
          ownerType: 'PERSONAL',
          ownerId: 'u1',
          name: 'due',
          status: 'pending_deletion',
          deletionScheduledAt: past,
        },
        {
          id: 'future',
          ownerType: 'PERSONAL',
          ownerId: 'u2',
          name: 'f',
          status: 'pending_deletion',
          deletionScheduledAt: future,
        },
        {
          id: 'active',
          ownerType: 'PERSONAL',
          ownerId: 'u3',
          name: 'a',
          status: 'active',
          deletionScheduledAt: null,
        },
        {
          id: 'noSchedule',
          ownerType: 'PERSONAL',
          ownerId: 'u4',
          name: 'n',
          status: 'pending_deletion',
          deletionScheduledAt: null,
        },
      ];
      const { svc } = makeService(projects);
      const due = await svc.findDueProjects(now);
      expect(due.map((p) => p.id)).toEqual(['due']);
    });
  });

  describe('purgeProject', () => {
    it('hard-deletes children, tombstones the project, emits, and bumps the epoch', async () => {
      const projects: ProjectRow[] = [
        {
          id: 'p1',
          ownerType: 'ORGANIZATION',
          ownerId: 'org1',
          name: 'proj',
          status: 'pending_deletion',
          deletionScheduledAt: past,
          modules: ['contacts'],
          moduleConfigs: { a: 1 },
        },
      ];
      const { svc, prisma, emit, bump } = makeService(projects);

      const did = await svc.purgeProject('p1', now);

      expect(did).toBe(true);
      expect(projects[0].status).toBe('purged');
      expect(projects[0].deletionScheduledAt).toBeNull();
      expect(projects[0].modules).toEqual([]);
      // every project-scoped child table got a deleteMany
      const del = (prisma as unknown as { __deleted: Record<string, number> }).__deleted;
      for (const t of [
        'projectMember',
        'recordShare',
        'roleAssignment',
        'permissionGrant',
        'rolePermission',
        'role',
        'accessUnitMember',
        'accessUnit',
        'projectIntegration',
        'projectApiKey',
      ]) {
        expect(del[t]).toBeGreaterThan(0);
      }
      // event emitted with the canonical key + org linkage for org-owned projects
      expect(emit).toHaveBeenCalledTimes(1);
      const input = emit.mock.calls[0][1] as {
        routingKey: string;
        projectId: string;
        organizationId?: string;
      };
      expect(input.routingKey).toBe('control.project.purged');
      expect(input.projectId).toBe('p1');
      expect(input.organizationId).toBe('org1');
      expect(bump).toHaveBeenCalledWith('p1');
    });

    it('is idempotent — a second run is a no-op (no re-emit, no re-bump)', async () => {
      const projects: ProjectRow[] = [
        {
          id: 'p1',
          ownerType: 'PERSONAL',
          ownerId: 'u1',
          name: 'proj',
          status: 'pending_deletion',
          deletionScheduledAt: past,
        },
      ];
      const { svc, emit, bump } = makeService(projects);

      const first = await svc.purgeProject('p1', now);
      const second = await svc.purgeProject('p1', now);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(bump).toHaveBeenCalledTimes(1);
    });

    it('skips a project restored out of pending_deletion before the lock', async () => {
      const projects: ProjectRow[] = [
        {
          id: 'p1',
          ownerType: 'PERSONAL',
          ownerId: 'u1',
          name: 'proj',
          status: 'active',
          deletionScheduledAt: null,
        },
      ];
      const { svc, emit, bump } = makeService(projects);

      const did = await svc.purgeProject('p1', now);

      expect(did).toBe(false);
      expect(emit).not.toHaveBeenCalled();
      expect(bump).not.toHaveBeenCalled();
    });
  });

  describe('purgeDue', () => {
    it('purges due projects and reports skipped ones; re-run is stable', async () => {
      const projects: ProjectRow[] = [
        {
          id: 'due1',
          ownerType: 'PERSONAL',
          ownerId: 'u1',
          name: 'd1',
          status: 'pending_deletion',
          deletionScheduledAt: past,
        },
        {
          id: 'due2',
          ownerType: 'PERSONAL',
          ownerId: 'u2',
          name: 'd2',
          status: 'pending_deletion',
          deletionScheduledAt: past,
        },
      ];
      const { svc } = makeService(projects);

      const first = await svc.purgeDue(now);
      expect(first.purged.sort()).toEqual(['due1', 'due2']);

      const second = await svc.purgeDue(now);
      expect(second.purged).toEqual([]); // nothing left in pending_deletion
    });
  });
});
