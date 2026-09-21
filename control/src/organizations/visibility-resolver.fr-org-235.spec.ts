/**
 * FR-ORG-235: источник графа групп переключается на AccessUnit ТОЛЬКО по явному
 * подтверждённому бэкфиллу (`system_settings.access_units_backfilled`), а не по
 * самому факту существования строк AccessUnit.
 *
 * Почему это важно: половина сотрудников может ещё сидеть на Department, пока
 * первые AccessUnit уже созданы (руками, импортом, частичной миграцией). Раньше
 * первая же строка AccessUnit переключала резолвер, и у всех «неперенесённых»
 * пользователей группы схлопывались в пустоту — видимость молча сжималась до
 * own. Флаг ставит бэкфилл-скрипт, когда перенос завершён и проверен.
 */
import { VisibilityResolverService } from './visibility-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

type GroupGraph = {
  units: Array<{ id: string }>;
  membersByUnit: Map<string, { users: string[]; childGroups: string[] }>;
  unitsOfUser: (u: string) => string[];
};

const ORG = 'org-1';
const PROJECT = 'proj-1';

/**
 * Оба источника НЕПУСТЫ и заведомо различимы: AccessUnit-граф знает `unit-a`
 * (участник `u-new`), Department-граф — `dept-a` (сотрудник `u-legacy`).
 * По тому, какой из них вернулся, и виден выбор резолвера.
 */
function makePrisma(backfilled: boolean) {
  const queryRaw = jest.fn(async (..._args: unknown[]) => [
    { access_units_backfilled: backfilled },
  ]);
  const prisma = {
    $queryRaw: queryRaw,
    accessUnit: {
      findMany: jest.fn(async () => [
        {
          id: 'unit-a',
          scopeType: 'ORGANIZATION',
          scopeId: ORG,
          parentId: null,
          leaderUserId: null,
        },
      ]),
    },
    accessUnitMember: {
      findMany: jest.fn(async () => [{ unitId: 'unit-a', memberType: 'user', memberId: 'u-new' }]),
    },
    department: {
      findMany: jest.fn(async () => [{ id: 'dept-a', parentId: null, leaderUserId: null }]),
    },
    employee: {
      findMany: jest.fn(async () => [{ userId: 'u-legacy', departmentId: 'dept-a' }]),
    },
  } as unknown as PrismaService;
  return { prisma, queryRaw };
}

function loadGraph(svc: VisibilityResolverService): Promise<GroupGraph> {
  return (
    svc as unknown as {
      loadGroupGraph: (o: string, p: string, u: string) => Promise<GroupGraph>;
    }
  ).loadGroupGraph(ORG, PROJECT, 'u-new');
}

describe('VisibilityResolverService: переключение источника графа (FR-ORG-235)', () => {
  it('флаг снят → граф департаментов, даже когда строки AccessUnit уже есть', async () => {
    const { prisma } = makePrisma(false);
    const svc = new VisibilityResolverService(prisma);

    const graph = await loadGraph(svc);

    expect(graph.units.map((u) => u.id)).toEqual(['dept-a']);
    expect(graph.unitsOfUser('u-legacy')).toEqual(['dept-a']);
    // Не переехавший пользователь не теряет группу — ровно то, что ломалось.
    expect(graph.membersByUnit.get('dept-a')?.users).toEqual(['u-legacy']);
    expect(prisma.accessUnitMember.findMany).not.toHaveBeenCalled();
  });

  it('флаг поднят → граф access-units, департаменты больше не читаются', async () => {
    const { prisma } = makePrisma(true);
    const svc = new VisibilityResolverService(prisma);

    const graph = await loadGraph(svc);

    expect(graph.units.map((u) => u.id)).toEqual(['unit-a']);
    expect(graph.unitsOfUser('u-new')).toEqual(['unit-a']);
    expect(graph.membersByUnit.get('unit-a')?.users).toEqual(['u-new']);
    // Никакого объединения с legacy-графом: после бэкфилла источник ровно один.
    expect(prisma.department.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it('флаг поднят, но AccessUnit ещё нет → фолбэк на департаменты (не пустой граф)', async () => {
    const { prisma } = makePrisma(true);
    (prisma.accessUnit.findMany as jest.Mock).mockResolvedValueOnce([]);
    const svc = new VisibilityResolverService(prisma);

    const graph = await loadGraph(svc);

    expect(graph.units.map((u) => u.id)).toEqual(['dept-a']);
  });

  it('флаг читается из системного синглтона control.system_settings', async () => {
    const { prisma, queryRaw } = makePrisma(true);
    const svc = new VisibilityResolverService(prisma);

    await loadGraph(svc);

    const sql = String(queryRaw.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('access_units_backfilled');
    expect(sql).toContain('control.system_settings');
  });
});
