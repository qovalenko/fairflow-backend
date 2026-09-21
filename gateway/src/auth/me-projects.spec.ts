import { of, throwError } from 'rxjs';
import { GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';

import { AuthController } from './auth.controller';

/**
 * Unit coverage for GET /v1/auth/me hydrating `user.projects` (P2.b,
 * be-auth-me-projects). /me is session-critical, so control being unreachable
 * must degrade to `projects: []` — never fail the whole response — while the
 * existing 2FA fields stay intact.
 */
describe('AuthController.me (hydrates user.projects via control.ProjectGrpc)', () => {
  const USER = {
    id: 'u1',
    email: 'u1@example.test',
    name: 'User One',
    two_factor_enabled: true,
    require2fa: false,
    backup_codes_remaining: 3,
  };

  function makeController(
    listMyProjectsImpl: (payload: unknown) => unknown,
    meImpl: () => unknown = () => of(USER),
  ) {
    const me = jest.fn(() => meImpl());
    const listMyProjects = jest.fn((payload: unknown) => listMyProjectsImpl(payload));
    // Bare instance — bypass DI; wire only the collaborators `me` reads.
    const ctrl = Object.create(AuthController.prototype) as AuthController;
    const wire = ctrl as unknown as Record<string, unknown>;
    wire.authGrpc = { me };
    wire.projectGrpc = { listMyProjects };
    wire.outboundMeta = { build: jest.fn(() => ({})) };
    wire.logger = { warn: jest.fn(), error: jest.fn() };
    return { ctrl, me, listMyProjects, logger: wire.logger as { warn: jest.Mock } };
  }

  const invoke = (ctrl: unknown) =>
    (ctrl as { me: (req: unknown) => Promise<{ user: Record<string, unknown> | null }> }).me({
      user: { userId: 'u1' },
      headers: {},
    });

  it('(a) puts the ListMyProjects list into user.projects (same raw shape as GET /v1/projects)', async () => {
    const projects = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ];
    const { ctrl, listMyProjects } = makeController(() => of({ list: projects }));
    const res = await invoke(ctrl);

    expect(listMyProjects).toHaveBeenCalledTimes(1);
    expect(listMyProjects.mock.calls[0][0]).toEqual({ user_id: 'u1' });
    expect(res.user).not.toBeNull();
    expect(res.user?.projects).toEqual(projects);
  });

  it('(b) degrades to projects=[] and warns when control errors, user still present', async () => {
    const { ctrl, logger } = makeController(() => throwError(() => new Error('unavailable')));
    const res = await invoke(ctrl);

    expect(res.user).not.toBeNull();
    expect(res.user?.projects).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('(c) preserves the 2FA fields alongside projects', async () => {
    const { ctrl } = makeController(() => of({ list: [] }));
    const res = await invoke(ctrl);

    expect(res.user).toMatchObject({
      twoFactorEnabled: true,
      require2fa: false,
      backupCodesRemaining: 3,
      projects: [],
    });
  });

  it('handles an empty/absent list from control as []', async () => {
    const { ctrl } = makeController(() => of({}));
    const res = await invoke(ctrl);
    expect(res.user?.projects).toEqual([]);
  });

  it('(d) surfaces auth domain outage as 503 — never 200 with user:null', async () => {
    const { ctrl } = makeController(
      () => of({ list: [] }),
      () => throwError(() => ({ code: 14, message: 'UNAVAILABLE' })),
    );
    await expect(invoke(ctrl)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('(d2) keeps grpcBffCall 504 as 504 — never 401 that would sign the user out', async () => {
    const { ctrl } = makeController(
      () => of({ list: [] }),
      () => throwError(() => new GatewayTimeoutException('Upstream gRPC timed out after 8000ms')),
    );
    await expect(invoke(ctrl)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('(e) decodes Struct-typed project fields — same shape as GET /v1/projects (GAP-STRUCT-PROJECT-READ)', async () => {
    // The FE seeds ModulesTab state from /me projects and PATCHes it back; a raw
    // Struct wire shape here would be double-encoded on save and corrupt settings.
    const { jsonToStruct } = await import('../bff/grpc-struct');
    const settings = { minQueryChars: 4 };
    const condition = { op: 'eq', left: { ref: 'record.ownerId' } };
    const { ctrl } = makeController(() =>
      of({
        list: [
          {
            id: 'p1',
            name: 'Alpha',
            module_configs: [
              { module_id: 'search', enabled: true, personal_settings: jsonToStruct(settings) },
            ],
            module_policies: [{ id: 'r1', module_id: 'deals', condition: jsonToStruct(condition) }],
          },
        ],
      }),
    );
    const res = await invoke(ctrl);
    const projects = res.user?.projects as Array<{
      module_configs: Array<{ personal_settings?: unknown }>;
      module_policies: Array<{ condition?: unknown }>;
    }>;
    expect(projects[0].module_configs[0].personal_settings).toEqual(settings);
    expect(projects[0].module_policies[0].condition).toEqual(condition);
  });
});
