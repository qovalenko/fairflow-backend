import { of } from 'rxjs';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

/**
 * TODO-089 — gateway-PEP согласован с каталогом прав по элевированным парам.
 *
 * Каталог (`expandSystemRolePermissions`, PDP) не выдаёт member/viewer ключ
 * `statistics:export` — аналитический экспорт элевирован. Гейт же (PEP) до этой
 * правки спрашивал плоскую матрицу `projectRoleCanKey`, где member держит
 * `export` на любом subject'е, поэтому GET /api/v1/statistics/export отдавал
 * файл роли, у которой кнопка «Экспорт» на фронте выключена по `allowed[]`.
 *
 * Каталожная сторона (какие ключи роль получает в `allowed[]`) закреплена в
 * shared/src/permission-statistics-export.spec.ts; здесь закрепляется вторая
 * половина пары — решение гейта на тех же (role, subject, action).
 */
describe('ProjectAccessGuard — элевированный экспорт (statistics/reports)', () => {
  const OLD_ENV = { ...process.env };

  let resolveRecordVisibility: jest.Mock;
  let getProjectAccessEpoch: jest.Mock;
  let getProject: jest.Mock;
  let checkPermissions: jest.Mock;

  const control = {
    getService: () => ({
      resolveRecordVisibility,
      getProjectAccessEpoch,
      getProject,
      checkPermissions,
    }),
  };
  const outboundMeta = { build: jest.fn(() => ({})) };

  const makeReflector = (required?: unknown) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
      return undefined;
    }),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (required?: unknown) =>
    new ProjectAccessGuard(
      makeReflector(required) as never,
      control as never,
      outboundMeta as never,
    );

  /** Прогон маршрута `@RequirePermission(subject, action)` под данной ролью. */
  const run = (role: string, subject: string, action: string) => {
    resolveRecordVisibility.mockReturnValue(of({ allowed: true, role, epoch: 1 }));
    const guard = makeGuard({ subject, action });
    return guard.canActivate(
      makeContext({ user: { userId: 'u-1' }, headers: { 'x-project-id': 'p-own' } }),
    );
  };

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';

    resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'owner', epoch: 1 }));
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() => of({ effective_modules: [], module_policies: [] }));
    checkPermissions = jest.fn((r: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: r.checks.map((c) => ({
          ...c,
          decision: 'allow',
          reason: '',
          not_applicable: true,
        })),
        epoch: 1,
      }),
    );
    outboundMeta.build.mockClear();
    invalidateProjectAccessCache('p-own');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('member: каталог не даёт statistics:export → гейт тоже 403 PERMISSION_DENIED', async () => {
    await expect(run('member', 'statistics', 'export')).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED', subject: 'statistics', action: 'export' },
    });
  });

  it('viewer: тот же отказ на statistics:export', async () => {
    await expect(run('viewer', 'statistics', 'export')).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED' },
    });
  });

  it('member: reports:export (второй элевированный subject) тоже закрыт', async () => {
    await expect(run('member', 'reports', 'export')).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED' },
    });
  });

  it.each(['manager', 'admin', 'owner'] as const)(
    '%s: каталог даёт statistics:export → гейт пропускает',
    async (role) => {
      await expect(run(role, 'statistics', 'export')).resolves.toBe(true);
    },
  );

  it('member сохраняет чтение статистики (гейт сузился ровно на export)', async () => {
    await expect(run('member', 'statistics', 'read')).resolves.toBe(true);
  });

  it('рабочий экспорт member НЕ задет: deals:export по-прежнему проходит', async () => {
    // Элевирован только аналитический экспорт — выгрузка рабочих данных
    // (сделки/контакты) остаётся у member, как и в каталоге.
    await expect(run('member', 'deals', 'export')).resolves.toBe(true);
  });
});
