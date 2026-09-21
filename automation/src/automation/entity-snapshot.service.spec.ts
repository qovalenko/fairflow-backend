import { ClientGrpcProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { EntitySnapshotService } from './entity-snapshot.service';

describe('EntitySnapshotService', () => {
  const pipeUrl = process.env.PIPE_GRPC_URL;
  const mockGetDeal = jest.fn();

  beforeEach(() => {
    mockGetDeal.mockReset();
    jest.spyOn(ClientGrpcProxy.prototype, 'getService').mockReturnValue({ GetDeal: mockGetDeal } as never);
    jest.spyOn(ClientGrpcProxy.prototype as never, 'createClients' as never).mockImplementation(() => undefined as never);
    process.env.PIPE_GRPC_URL = 'pipe:5003';
    process.env.AUTOMATION_SERVICE_API_KEY = 'ak_test';
    process.env.AUTOMATION_API_KEY_ID = 'key-id';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (pipeUrl === undefined) delete process.env.PIPE_GRPC_URL;
    else process.env.PIPE_GRPC_URL = pipeUrl;
  });

  it('rejects unsupported entity types', async () => {
    const svc = new EntitySnapshotService();
    await expect(svc.fetchRecord('p1', 'invoice', 'x1', 'u1')).rejects.toMatchObject({
      message: expect.stringContaining('unsupported entity_type'),
      code: 3,
    });
  });

  it('rejects when the domain reader URL is unset', async () => {
    delete process.env.PIPE_GRPC_URL;
    const svc = new EntitySnapshotService();
    await expect(svc.fetchRecord('p1', 'deal', 'd1', 'u1')).rejects.toMatchObject({
      message: 'entity_reader_unavailable',
      code: 9,
    });
  });

  it('returns flattened deal fields on success', async () => {
    mockGetDeal.mockReturnValue(
      of({
        id: 'd1',
        amount: 5000,
        stage_id: 's1',
        assignee_id: 'u2',
      }),
    );
    const svc = new EntitySnapshotService();
    const snapshot = await svc.fetchRecord('p1', 'deals', 'd1', 'u1');
    expect(snapshot).toMatchObject({
      entity_type: 'deal',
      entity_id: 'd1',
      deal_id: 'd1',
      amount: 5000,
      stage_id: 's1',
      assignee_id: 'u2',
    });
    expect(mockGetDeal).toHaveBeenCalledWith(
      { project_id: 'p1', id: 'd1' },
      expect.objectContaining({
        get: expect.any(Function),
      }),
    );
  });

  it('maps NOT_FOUND from the reader to a generic Entity not found', async () => {
    mockGetDeal.mockReturnValue(throwError(() => Object.assign(new Error('missing'), { code: 5 })));
    const svc = new EntitySnapshotService();
    await expect(svc.fetchRecord('p1', 'deal', 'd1', 'u1')).rejects.toMatchObject({
      message: 'Entity not found',
      code: 5,
    });
  });

  it('maps PERMISSION_DENIED from the reader to Entity not found (no existence leak)', async () => {
    mockGetDeal.mockReturnValue(throwError(() => Object.assign(new Error('denied'), { code: 7 })));
    const svc = new EntitySnapshotService();
    await expect(svc.fetchRecord('p1', 'deal', 'd1', 'u1')).rejects.toMatchObject({
      message: 'Entity not found',
      code: 5,
    });
  });
});
