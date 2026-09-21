import { OrgAuditService } from './org-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { OrgStructureService } from './org-structure.service';

const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;

type Row = {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  chainHash: string | null;
  prevHash: string | null;
};

function makeListPrisma(rows: Row[]) {
  return {
    employee: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          isActive: true,
          role: 'employee',
          departmentId: 'dept-led',
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([{ userId: 'emp-1' }])),
    },
    invitation: {
      findMany: jest.fn(() => Promise.resolve([{ id: 'inv-1' }])),
    },
    orgAuditLog: {
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: Record<string, unknown>;
          orderBy: unknown;
          take: number;
        }) => {
          void orderBy;
          let list = rows.filter(
            (r) => r.organizationId === (where as { organizationId: string }).organizationId,
          );
          const w = where as {
            entityType?: string;
            createdAt?: { gte?: Date; lte?: Date };
            OR?: Array<Record<string, unknown>>;
            AND?: Array<Record<string, unknown>>;
          };
          if (w.entityType) list = list.filter((r) => r.entityType === w.entityType);
          if (w.createdAt?.gte) list = list.filter((r) => r.createdAt >= w.createdAt!.gte!);
          if (w.createdAt?.lte) list = list.filter((r) => r.createdAt <= w.createdAt!.lte!);
          if (w.OR) {
            list = list.filter((r) =>
              w.OR!.some((clause) => {
                const et = clause.entityType as string | undefined;
                const ids = (clause.entityId as { in: string[] } | undefined)?.in;
                return et === r.entityType && ids?.includes(r.entityId ?? '');
              }),
            );
          }
          list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return list.slice(0, take);
        },
      ),
    },
  };
}

/** FR-ORG-590 / FR-ORG-600 — list filters, cursor, subtree scope. */
describe('OrgAuditService.list (FR-ORG-590/600)', () => {
  const orgId = 'org-1';
  const actor = 'leader-1';
  const t1 = new Date('2026-01-10T12:00:00.000Z');
  const t2 = new Date('2026-01-11T12:00:00.000Z');
  const t3 = new Date('2026-01-12T12:00:00.000Z');

  const rows: Row[] = [
    {
      id: 'a3',
      organizationId: orgId,
      actorUserId: actor,
      action: 'employee.updated',
      entityType: 'employee',
      entityId: 'emp-1',
      metadata: {},
      createdAt: t3,
      chainHash: 'h3',
      prevHash: 'h2',
    },
    {
      id: 'a2',
      organizationId: orgId,
      actorUserId: 'other',
      action: 'department.updated',
      entityType: 'department',
      entityId: 'dept-led',
      metadata: {},
      createdAt: t2,
      chainHash: 'h2',
      prevHash: 'h1',
    },
    {
      id: 'a1',
      organizationId: orgId,
      actorUserId: actor,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: 'inv-1',
      metadata: {},
      createdAt: t1,
      chainHash: 'h1',
      prevHash: null,
    },
  ];

  function makeService(canManage: boolean) {
    const prisma = makeListPrisma(rows);
    const pdp = {
      can: jest.fn(async (_org: string, _user: string, resource: string) => {
        if (resource === 'org:audit') return true;
        if (resource === 'org:profile') return canManage;
        return false;
      }),
    };
    const structure = {
      resolveLedDepartmentSubtree: jest.fn().mockResolvedValue(['dept-led']),
    } as unknown as OrgStructureService;
    const service = new OrgAuditService(
      prisma as unknown as PrismaService,
      noopEmitter,
      pdp as never,
      structure,
    );
    return { service, prisma, structure };
  }

  it('filters by entityType and date range (FR-ORG-590)', async () => {
    const { service } = makeService(true);
    const { list } = await service.list(orgId, actor, {
      limit: 50,
      filterEntityType: 'department',
      fromTs: t2,
      toTs: t3,
    });
    expect(list.map((r) => r.id)).toEqual(['a2']);
  });

  it('restricts non-manage viewers to their led subtree (FR-ORG-600)', async () => {
    const { service, structure } = makeService(false);
    const { list } = await service.list(orgId, actor, { limit: 50 });
    expect(structure.resolveLedDepartmentSubtree).toHaveBeenCalled();
    expect(list.map((r) => r.id).sort()).toEqual(['a1', 'a2', 'a3'].sort());
  });

  it('returns nextCursor when more rows exist than limit', async () => {
    const { service } = makeService(true);
    const first = await service.list(orgId, actor, { limit: 1 });
    expect(first.list).toHaveLength(1);
    expect(first.nextCursor).toContain('|');
    expect(first.nextCursor.length).toBeGreaterThan(5);
  });
});
