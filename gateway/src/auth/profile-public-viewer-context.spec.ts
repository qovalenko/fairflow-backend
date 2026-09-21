import { of } from 'rxjs';
import { ProfilePublicController } from './profile-public.controller';
import { resolveProfileVisibilityLevel } from './profile-visibility';

/**
 * FR-PROFILE-300: viewer_context must be built from ProjectAccessGuard outputs
 * (req.__projectRole) and resolvePlatformRole — not from JWT roles[].
 */
describe('ProfilePublicController.userProfile viewer_context (FR-PROFILE-300)', () => {
  const buildController = () => {
    const grpcCalls: unknown[] = [];
    const authClient = {
      getService: () => ({
        getUserProfileForViewer: (payload: unknown) => {
          grpcCalls.push(payload);
          return of({
            id: 'target-1',
            name: 'Colleague',
            login: 'colleague',
          });
        },
      }),
    };
    const controlClient = {
      getService: (name: string) => {
        if (name === 'OrganizationGrpc') {
          return {
            getOrgRole: () => of({ role: '', is_active: true }),
            listEmployees: () => of({ list: [] }),
            listDepartments: () => of({ list: [] }),
          };
        }
        if (name === 'ProjectGrpc') {
          return {
            resolveRecordVisibility: () => of({ allowed: true, role: 'member' }),
          };
        }
        return {};
      },
    };
    const outboundMeta = { build: () => ({}) };
    const c = new ProfilePublicController(
      authClient as never,
      controlClient as never,
      outboundMeta as never,
    );
    c.onModuleInit();
    return { c, grpcCalls };
  };

  it('passes project_role from ProjectAccessGuard into viewer_context', async () => {
    const { c, grpcCalls } = buildController();
    const req = {
      user: { userId: 'viewer-1' },
      headers: { 'x-project-id': 'proj-1' },
      __projectId: 'proj-1',
      __projectRole: 'manager',
    };

    await c.userProfile(req as never, 'target-1');

    const payload = grpcCalls[0] as {
      viewer_context?: { project_role?: string; platform_role?: string; project_id?: string };
    };
    expect(payload.viewer_context).toEqual({
      project_role: 'manager',
      platform_role: '',
      project_id: 'proj-1',
    });
    expect(resolveProfileVisibilityLevel('manager', '')).toBe(1);
  });
});
