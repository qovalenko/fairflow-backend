/**
 * [be-p0-search-pid] `/search/query` + `/search/status` must query the SAME project
 * ProjectAccessGuard authorized (`query.projectId ?? x-project-id`).
 *
 * The handlers used to fall straight back to the literal project id `'default'`
 * when the query param was absent — so the host header search bar (CommonService
 * `apiGetSearchResult`, which sends only the ambient `X-Project-Id` header) was
 * authorized in its real project but searched `'default'` → «Нет результатов»
 * with a fully populated index.
 */
import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import {
  CommonBffController,
  normalizeSearchScope,
  resetSearchSettingsCache,
  resolveSearchProjectId,
} from './common-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

beforeEach(() => resetSearchSettingsCache());

describe('[be-p0-search-pid] search project resolution', () => {
  function build(search: Record<string, unknown>) {
    const ctrl = new CommonBffController(
      stubClient(),
      stubClient(search),
      stubClient(),
      stubClient(),
      { build: () => ({}) } as never,
      { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  it('resolveSearchProjectId: query wins, header is the fallback, absent → 400', () => {
    expect(resolveSearchProjectId({ headers: { 'x-project-id': 'p-hdr' } }, 'p-qry')).toBe('p-qry');
    expect(resolveSearchProjectId({ headers: { 'x-project-id': 'p-hdr' } }, '')).toBe('p-hdr');
    expect(resolveSearchProjectId({ headers: { 'x-project-id': ' p-hdr ' } })).toBe('p-hdr');
  });

  // TODO-281/TODO-296: no silent 'default' — an absent project is a 400, never an
  // unverified project id stamped into trusted outbound metadata.
  it('resolveSearchProjectId: fail-closed when neither query nor header carries a project', () => {
    expect(() => resolveSearchProjectId({ headers: {} })).toThrow(BadRequestException);
    expect(() => resolveSearchProjectId({ headers: { 'x-project-id': '  ' } }, '  ')).toThrow(
      BadRequestException,
    );
    try {
      resolveSearchProjectId({ headers: {} });
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: 'PROJECT_ID_REQUIRED',
      });
    }
  });

  it('search() never calls the domain without a project', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc });
    await expect(
      ctrl.search({ user: { userId: 'u1' }, headers: {} } as never, 'кто'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('search() sends the header project when the query param is absent', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc });

    // Query must clear the default minQueryChars=2: since TODO-492 the gateway
    // short-circuits shorter queries itself and the domain is never called.
    await ctrl.search(
      { user: { userId: 'u1' }, headers: { 'x-project-id': 'p-hdr' } } as never,
      'кто',
    );

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p-hdr' }), {});
  });

  it('search() still prefers an explicit query param (no widening)', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = build({ search: rpc });

    await ctrl.search(
      { user: { userId: 'u1' }, headers: { 'x-project-id': 'p-hdr' } } as never,
      'кто',
      'p-qry',
    );

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p-qry' }), {});
  });

  it('status() uses the same resolution', async () => {
    const rpc = jest.fn(() => of({ indexed_count: 5 }));
    const ctrl = build({ status: rpc });

    await ctrl.searchStatus({
      user: { userId: 'u1' },
      headers: { 'x-project-id': 'p-hdr' },
    } as never);

    expect(rpc).toHaveBeenCalledWith({ project_id: 'p-hdr' }, {});
  });
});

/**
 * TODO-262 / FR-SEARCH-140: the UI scope preset must reach the domain. Before
 * this the `?scope=` value had no reader at all — the FE control only churned its
 * SWR key. The gateway is also the ONLY place allowed to say which departments
 * «Мой отдел» means: the client never states them.
 */
describe('[TODO-262] search scope preset', () => {
  function buildWithControl(
    search: Record<string, unknown>,
    control: Record<string, unknown> = {},
  ) {
    const ctrl = new CommonBffController(
      stubClient(),
      stubClient(search),
      stubClient(),
      stubClient(control),
      { build: () => ({}) } as never,
      { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  const req = () => ({ user: { userId: 'u1' }, headers: { 'x-project-id': 'p1' } }) as never;

  it('normalizeSearchScope: only the contract values, garbage is NOT a filter', () => {
    expect(normalizeSearchScope('my')).toBe('my');
    expect(normalizeSearchScope('Dept')).toBe('dept');
    expect(normalizeSearchScope('all')).toBe('all');
    expect(normalizeSearchScope('own')).toBeUndefined();
    expect(normalizeSearchScope(undefined)).toBeUndefined();
  });

  it('passes scope=my to the domain as owner_scope', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = buildWithControl({ search: rpc });

    await ctrl.search(
      req(),
      'ив',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'my',
    );

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ owner_scope: 'my', scope_department_ids: [] }),
      {},
    );
  });

  it('no scope param → owner_scope stays empty (pre-TODO-262 behaviour)', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = buildWithControl({ search: rpc });

    await ctrl.search(req(), 'ив', 'p1');

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ owner_scope: '' }), {});
  });

  it('an unknown scope value never becomes a filter', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const ctrl = buildWithControl({ search: rpc });

    await ctrl.search(
      req(),
      'ив',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'everything',
    );

    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ owner_scope: '' }), {});
  });

  it('scope=dept expands to the viewer departments resolved by CONTROL, not the client', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const projection = jest.fn(() =>
      of({ visibility_scope: { department_ids: ['dep-1', 'dep-2'] } }),
    );
    const ctrl = buildWithControl({ search: rpc }, { resolvePermissionProjection: projection });

    await ctrl.search(
      req(),
      'ив',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dept',
    );

    expect(projection).toHaveBeenCalledWith({ project_id: 'p1', user_id: 'u1' }, {});
    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_scope: 'dept',
        scope_department_ids: ['dep-1', 'dep-2'],
      }),
      {},
    );
  });

  it('control unavailable → empty departments (fail-closed), never a silent widening', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const projection = jest.fn(() => {
      throw new Error('control down');
    });
    const ctrl = buildWithControl({ search: rpc }, { resolvePermissionProjection: projection });

    await ctrl.search(
      req(),
      'ив',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dept',
    );

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ owner_scope: 'dept', scope_department_ids: [] }),
      {},
    );
  });

  it('departments are resolved once per (user, project) — not per keystroke', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const projection = jest.fn(() => of({ visibility_scope: { department_ids: ['dep-1'] } }));
    const ctrl = buildWithControl({ search: rpc }, { resolvePermissionProjection: projection });

    await ctrl.search(
      req(),
      'ив',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dept',
    );
    await ctrl.search(
      req(),
      'ива',
      'p1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dept',
    );

    expect(projection).toHaveBeenCalledTimes(1);
  });

  it('a scope preset never runs without a project (isolation first)', async () => {
    const rpc = jest.fn(() => of({ groups: [], total: 0 }));
    const projection = jest.fn(() => of({ visibility_scope: { department_ids: ['dep-1'] } }));
    const ctrl = buildWithControl({ search: rpc }, { resolvePermissionProjection: projection });

    await expect(
      ctrl.search(
        { user: { userId: 'u1' }, headers: {} } as never,
        'ив',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'dept',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(projection).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
