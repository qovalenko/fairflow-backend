import { of } from 'rxjs';
import { ProjectAccessGuard } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';

/**
 * Гейт публикует id проекта, НА КОТОРОМ он авторизовал запрос
 * (`request.__projectId`), чтобы контроллеры не выводили его заново.
 *
 * Именно расхождение порядков (гейт `params → query → header`, а
 * StatisticsBffController — `header → query`) давало «авторизовались в A,
 * прочитали B». Здесь закреплён источник истины; потребитель —
 * statistics-bff.project-scope.spec.ts.
 */
describe('ProjectAccessGuard — авторизованный projectId доступен хендлеру', () => {
  const OLD_ENV = { ...process.env };

  const outboundMeta = { build: jest.fn(() => ({})) };
  const checkPermissions = jest.fn((r: { checks: Array<{ subject: string; action: string }> }) =>
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
  const control = {
    getService: () => ({
      resolveRecordVisibility: jest.fn(() => of({ allowed: true, role: 'owner', epoch: 1 })),
      getProjectAccessEpoch: jest.fn(() => of({ epoch: 1 })),
      getProject: jest.fn(() => of({ effective_modules: [], module_policies: [] })),
      checkPermissions,
    }),
  };

  const reflector = {
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return { subject: 'statistics', action: 'read' };
      if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
      return undefined;
    }),
  };

  const context = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('query выигрывает у заголовка — и именно этот id уходит в __projectId', async () => {
    const guard = new ProjectAccessGuard(
      reflector as never,
      control as never,
      outboundMeta as never,
    );
    const request = {
      user: { userId: 'u-1' },
      query: { projectId: 'A' },
      headers: { 'x-project-id': 'B' },
    } as Record<string, unknown>;

    await guard.canActivate(context(request));

    expect(request.__projectId).toBe('A');
  });

  it('только заголовок — он и становится авторизованным id', async () => {
    const guard = new ProjectAccessGuard(
      reflector as never,
      control as never,
      outboundMeta as never,
    );
    const request = {
      user: { userId: 'u-1' },
      headers: { 'x-project-id': 'p1' },
    } as Record<string, unknown>;

    await guard.canActivate(context(request));

    expect(request.__projectId).toBe('p1');
  });
});
