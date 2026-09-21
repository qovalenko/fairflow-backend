import { of, throwError } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { ControlMembersService } from './control-members.service';

const MEMBERS = [
  { id: 'u-owner', role: 'owner' },
  { id: 'u-admin', role: 'admin' },
  { id: 'u-manager', role: 'manager' },
  { id: 'u-member', role: 'member' },
  { id: 'u-viewer', role: 'viewer' },
];

function makeService(
  listMembers: jest.Mock,
  getProject: jest.Mock = jest.fn(),
  listDepartments: jest.Mock = jest.fn(),
): ControlMembersService {
  const client = {
    getService: (name: string) =>
      name === 'OrganizationGrpc'
        ? { listEmployees: jest.fn(), listDepartments }
        : { listMembers, getProject },
  } as unknown as ClientGrpcProxy;
  const svc = new ControlMembersService(client);
  svc.onModuleInit();
  return svc;
}

function makeOrgService(listEmployees: jest.Mock): ControlMembersService {
  // onModuleInit resolves both ProjectGrpc + OrganizationGrpc off the one client.
  const client = {
    getService: (name: string) =>
      name === 'OrganizationGrpc' ? { listEmployees } : { listMembers: jest.fn() },
  } as unknown as ClientGrpcProxy;
  const svc = new ControlMembersService(client);
  svc.onModuleInit();
  return svc;
}

describe('ControlMembersService.resolveFanout', () => {
  it('pa → owner+admin, leader → manager (roles filtered, ids de-duped)', async () => {
    const listMembers = jest.fn().mockReturnValue(of({ list: MEMBERS }));
    const svc = makeService(listMembers);

    const pa = await svc.resolveFanout('p1', ['pa']);
    expect(pa.sort()).toEqual(['u-admin', 'u-owner']);

    const leader = await svc.resolveFanout('p1', ['leader']);
    expect(leader).toEqual(['u-manager']);

    const both = await svc.resolveFanout('p1', ['pa', 'leader']);
    expect(both.sort()).toEqual(['u-admin', 'u-manager', 'u-owner']);

    const all = await svc.resolveFanout('p1', ['all']);
    expect(all.sort()).toEqual(MEMBERS.map((m) => m.id).sort());
  });

  it('leader → manager role plus org-structure leaderUserId when both are members', async () => {
    const listMembers = jest.fn().mockReturnValue(of({ list: MEMBERS }));
    const getProject = jest
      .fn()
      .mockReturnValue(of({ owner_type: 'ORGANIZATION', owner_id: 'org-1' }));
    const listDepartments = jest.fn().mockReturnValue(
      of({
        list: [{ leader_user_id: 'u-dept-lead' }, { leader_user_id: 'u-outsider' }],
      }),
    );
    const svc = makeService(listMembers, getProject, listDepartments);
    const membersWithDeptLead = [...MEMBERS, { id: 'u-dept-lead', role: 'member' }];
    listMembers.mockReturnValue(of({ list: membersWithDeptLead }));

    const leader = await svc.resolveFanout('p1', ['leader']);
    expect(leader.sort()).toEqual(['u-dept-lead', 'u-manager']);
    expect(listDepartments).toHaveBeenCalledWith(
      { organization_id: 'org-1', actor_user_id: 'u-owner' },
      expect.anything(),
    );
  });

  it('caches ~30 s per project (control queried once for repeated calls)', async () => {
    const listMembers = jest.fn().mockReturnValue(of({ list: MEMBERS }));
    const svc = makeService(listMembers);
    await svc.resolveFanout('p1', ['pa']);
    await svc.resolveFanout('p1', ['leader']);
    await svc.getMembers('p1');
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: control error → [] (caller keeps payload addressees)', async () => {
    const listMembers = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeService(listMembers);
    await expect(svc.resolveFanout('p1', ['pa', 'all'])).resolves.toEqual([]);
  });

  it('empty projectId or no groups → [] without a control call', async () => {
    const listMembers = jest.fn().mockReturnValue(of({ list: MEMBERS }));
    const svc = makeService(listMembers);
    expect(await svc.resolveFanout('', ['pa'])).toEqual([]);
    expect(await svc.resolveFanout('p1', [])).toEqual([]);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('sends the service-API-key + fail-closed x-visibility-scope in metadata', async () => {
    const listMembers = jest.fn().mockReturnValue(of({ list: MEMBERS }));
    const svc = makeService(listMembers);
    process.env.NOTIFICATION_SERVICE_API_KEY = 'ak_test';
    await svc.getMembers('p1');
    const [, md] = listMembers.mock.calls[0];
    expect(md.get('x-service-api-key')[0]).toBe('ak_test');
    expect(md.get('x-visibility-scope')[0]).toBeTruthy();
    delete process.env.NOTIFICATION_SERVICE_API_KEY;
  });
});

describe('ControlMembersService.getOrgActiveMembers', () => {
  const EMPLOYEES = [
    { user_id: 'u-owner', role: 'platform_owner', is_active: true },
    { user_id: 'u-admin', role: 'platform_admin', is_active: true },
    { user_id: 'u-gone', role: 'employee', is_active: false },
    { user_id: '', role: 'employee', is_active: true },
  ];

  it('returns only active employees with a user_id, de-duped', async () => {
    const listEmployees = jest.fn().mockReturnValue(of({ list: EMPLOYEES }));
    const svc = makeOrgService(listEmployees);

    const ids = await svc.getOrgActiveMembers('org-1', 'u-owner');
    expect(ids.sort()).toEqual(['u-admin', 'u-owner']);
    expect(listEmployees.mock.calls[0][0]).toEqual({
      organization_id: 'org-1',
      actor_user_id: 'u-owner',
    });
  });

  it('empty organizationId → [] without a control call', async () => {
    const listEmployees = jest.fn().mockReturnValue(of({ list: EMPLOYEES }));
    const svc = makeOrgService(listEmployees);
    expect(await svc.getOrgActiveMembers('', 'u-owner')).toEqual([]);
    expect(listEmployees).not.toHaveBeenCalled();
  });

  it('successful empty employee list → []', async () => {
    const listEmployees = jest.fn().mockReturnValue(of({ list: [] }));
    const svc = makeOrgService(listEmployees);
    expect(await svc.getOrgActiveMembers('org-1', 'u-owner')).toEqual([]);
  });

  it('NOT fail-soft: control error throws (caller nacks into the retry ladder)', async () => {
    const listEmployees = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeOrgService(listEmployees);
    await expect(svc.getOrgActiveMembers('org-1', 'u-owner')).rejects.toThrow('UNAVAILABLE');
  });
});

describe('ControlMembersService effective modules', () => {
  it('returns effective modules from control and caches the result', async () => {
    const getProject = jest
      .fn()
      .mockReturnValue(of({ effective_modules: ['activities', 'deals'] }));
    const svc = makeService(jest.fn(), getProject);
    const first = await svc.getEffectiveModulesWithStatus('p1');
    const second = await svc.getEffectiveModulesWithStatus('p1');
    expect(first).toEqual({ modules: ['activities', 'deals'], ok: true });
    expect(second.ok).toBe(true);
    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it('fail-closed when GetProject is unavailable', async () => {
    const getProject = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeService(jest.fn(), getProject);
    await expect(svc.getEffectiveModulesWithStatus('p1')).resolves.toEqual({
      modules: [],
      ok: false,
    });
  });

  it('isModuleEnabled treats notifications/statistics as always on', () => {
    const svc = makeService(jest.fn());
    expect(svc.isModuleEnabled([], 'notifications')).toBe(true);
    expect(svc.isModuleEnabled([], 'statistics')).toBe(true);
    expect(svc.isModuleEnabled(['deals'], 'activities')).toBe(false);
    expect(svc.isModuleEnabled(['deals'], 'deals')).toBe(true);
  });

  it('getMembersWithStatus returns ok=false when ListMembers fails', async () => {
    const listMembers = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeService(listMembers);
    await expect(svc.getMembersWithStatus('p1')).resolves.toEqual({ members: [], ok: false });
  });
});
