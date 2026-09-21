import { RolesBffController } from './roles-bff.controller';
import { grpcBffCall } from './grpc-bff-call';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('RolesBffController.batchCan (API-3)', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const projectionCache = {} as never;

  const controller = new RolesBffController(
    { getService: () => ({ simulateAccessExplain: jest.fn() }) } as never,
    outboundMeta as never,
    projectionCache,
  );
  controller.onModuleInit();

  const req = { user: { userId: 'u-1' } } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns allow/deny per check on the production PDP path', async () => {
    mockedGrpcBffCall
      .mockResolvedValueOnce({ decision: 'allow', reason: 'OK' })
      .mockResolvedValueOnce({ decision: 'deny', reason: 'DENIED_BY_GRANT' });

    const res = await controller.batchCan(req, 'p-1', {
      checks: [
        {
          subject: 'contacts',
          action: 'read',
          recordRef: { resource: 'contacts', recordId: 'c-1' },
        },
        { subject: 'deals', action: 'delete', recordRef: { resource: 'deals', recordId: 'd-1' } },
      ],
    });

    expect(mockedGrpcBffCall).toHaveBeenCalledTimes(2);
    expect(res.results).toEqual([
      expect.objectContaining({ subject: 'contacts', action: 'read', allow: true, reason: 'OK' }),
      expect.objectContaining({
        subject: 'deals',
        action: 'delete',
        allow: false,
        reason: 'DENIED_BY_GRANT',
      }),
    ]);
  });

  it('fail-closes invalid checks and PDP errors', async () => {
    mockedGrpcBffCall.mockRejectedValueOnce(new Error('down'));

    const res = await controller.batchCan(req, 'p-1', {
      checks: [
        { subject: '', action: 'read' },
        { subject: 'orders', action: 'write' },
      ],
    });

    expect(mockedGrpcBffCall).toHaveBeenCalledTimes(1);
    expect(res.results[0]).toMatchObject({ allow: false, reason: 'INVALID_CHECK' });
    expect(res.results[1]).toMatchObject({ allow: false, reason: 'PDP_UNAVAILABLE' });
  });

  it('fail-closes when the actor is missing', async () => {
    const res = await controller.batchCan({ user: {} } as never, 'p-1', {
      checks: [{ subject: 'contacts', action: 'read' }],
    });

    expect(mockedGrpcBffCall).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ allow: false, reason: 'UNAUTHENTICATED' });
  });

  it('caps the batch at 32 and fail-closes the overflow', async () => {
    mockedGrpcBffCall.mockResolvedValue({ decision: 'allow', reason: 'OK' });

    const res = await controller.batchCan(req, 'p-1', {
      checks: Array.from({ length: 33 }, (_, i) => ({
        subject: 'contacts',
        action: 'read',
        recordRef: { resource: 'contacts', recordId: `c-${i}` },
      })),
    });

    expect(mockedGrpcBffCall).toHaveBeenCalledTimes(32);
    expect(res.results).toHaveLength(33);
    expect(res.results[32]).toMatchObject({ allow: false, reason: 'BATCH_LIMIT' });
  });
});
