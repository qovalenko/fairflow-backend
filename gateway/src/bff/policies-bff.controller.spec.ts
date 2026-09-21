import { PoliciesBffController } from './policies-bff.controller';
import { grpcBffCall } from './grpc-bff-call';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('PoliciesBffController.savePolicies OWNER_LOCKOUT (FR-ACCESS-485)', () => {
  const projectId = 'proj-1';
  const req = { user: { userId: 'admin-1' } } as never;

  function makeController() {
    const project = {
      updateProject: jest.fn(),
    };
    const roles = {
      resolveEffectivePermissions: jest.fn(),
    };
    const control = {
      getService: (name: string) => (name === 'ProjectGrpc' ? project : roles),
    };
    const outboundMeta = {
      build: jest.fn().mockReturnValue({}),
    };
    const policyImpact = {
      estimate: jest.fn().mockResolvedValue({
        affectedRecords: 0,
        affectedUsers: { count: 0, sample: [] },
        ownerLockout: false,
      }),
    };
    const controller = new PoliciesBffController(
      control as never,
      outboundMeta as never,
      policyImpact as never,
    );
    controller.onModuleInit();
    return { controller, project };
  }

  beforeEach(() => {
    mockedGrpcBffCall.mockReset();
  });

  it('rejects save with OWNER_LOCKOUT when a blanket deny targets access-control subjects', async () => {
    const { controller, project } = makeController();
    await expect(
      controller.savePolicies(req, projectId, {
        rules: [{ subject: 'roles', action: 'read', effect: 'deny', conditions: [] }],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OWNER_LOCKOUT' }),
    });
    expect(project.updateProject).not.toHaveBeenCalled();
    expect(mockedGrpcBffCall).not.toHaveBeenCalled();
  });

  it('persists CRM blanket deny and returns selfLockoutWarning when author holds the key', async () => {
    const { controller, project } = makeController();
    mockedGrpcBffCall.mockResolvedValueOnce({ allow: ['contacts:read'] }).mockResolvedValueOnce({});
    const res = await controller.savePolicies(req, projectId, {
      rules: [{ subject: 'contacts', action: 'read', effect: 'deny', conditions: [] }],
    });
    expect(project.updateProject).toHaveBeenCalled();
    expect(res.selfLockoutWarning).toBe(true);
  });
});
