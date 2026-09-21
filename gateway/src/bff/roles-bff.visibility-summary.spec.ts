import { of } from 'rxjs';

import { RolesBffController } from './roles-bff.controller';
import { grpcBffCall } from './grpc-bff-call';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

/**
 * FR-ACCESS-570: visibility summary must call ProjectGrpc.ResolveRecordVisibility
 * (control.proto:816), NOT RoleGrpc — the RPC exists only on ProjectGrpc.
 */
describe('RolesBffController.myVisibilitySummary (FR-ACCESS-570)', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const projectionCache = {} as never;

  const projectResolveRecordVisibility = jest.fn((_payload: unknown) =>
    of({ mode: 'team', level: 'department' }),
  );
  const roleResolveRecordVisibility = jest.fn((_payload: unknown) =>
    of({ mode: 'wrong', level: 'wrong' }),
  );

  const control = {
    getService: jest.fn((name: string) => {
      if (name === 'ProjectGrpc') {
        return { resolveRecordVisibility: projectResolveRecordVisibility };
      }
      return {
        resolveRecordVisibility: roleResolveRecordVisibility,
        resolveEffectivePermissions: jest.fn(),
        resolvePermissionProjection: jest.fn(),
      };
    }),
  };

  const controller = new RolesBffController(
    control as never,
    outboundMeta as never,
    projectionCache,
  );
  controller.onModuleInit();

  const req = { user: { userId: 'u-1' } } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    controller.onModuleInit();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('calls ProjectGrpc.resolveRecordVisibility per module — never RoleGrpc', async () => {
    const res = await controller.myVisibilitySummary(req, 'p-1');

    expect(control.getService).toHaveBeenCalledWith('ProjectGrpc');
    expect(projectResolveRecordVisibility).toHaveBeenCalledTimes(5);
    expect(roleResolveRecordVisibility).not.toHaveBeenCalled();
    expect(res.modules).toEqual([
      { module: 'contacts', mode: 'team', level: 'department' },
      { module: 'companies', mode: 'team', level: 'department' },
      { module: 'deals', mode: 'team', level: 'department' },
      { module: 'orders', mode: 'team', level: 'department' },
      { module: 'activities', mode: 'team', level: 'department' },
    ]);
  });

  it('fail-soft omits a module when resolveRecordVisibility throws', async () => {
    mockedGrpcBffCall
      .mockResolvedValueOnce({ mode: 'all', level: 'org' })
      .mockRejectedValueOnce(new Error('module disabled'))
      .mockResolvedValue({ mode: 'self', level: 'owner' });

    const res = await controller.myVisibilitySummary(req, 'p-1');

    expect(res.modules).toHaveLength(4);
    expect(res.modules.map((m) => m.module)).toEqual(['contacts', 'deals', 'orders', 'activities']);
  });
});
