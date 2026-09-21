import { of, throwError } from 'rxjs';
import { status } from '@grpc/grpc-js';
import { NotificationPointCheckService } from './notification-point-check.service';

describe('NotificationPointCheckService (FR-NOTIF-330)', () => {
  const prevPipeUrl = process.env.PIPE_GRPC_URL;
  const prevApiKey = process.env.NOTIFICATION_SERVICE_API_KEY;

  afterEach(() => {
    if (prevPipeUrl === undefined) delete process.env.PIPE_GRPC_URL;
    else process.env.PIPE_GRPC_URL = prevPipeUrl;
    if (prevApiKey === undefined) delete process.env.NOTIFICATION_SERVICE_API_KEY;
    else process.env.NOTIFICATION_SERVICE_API_KEY = prevApiKey;
  });

  function makeSvc(
    resolveRecordVisibility: jest.Mock,
    entityMethod?: jest.Mock,
  ): NotificationPointCheckService {
    const controlClient = {
      getService: jest.fn().mockReturnValue({ resolveRecordVisibility }),
    };
    const svc = new NotificationPointCheckService(controlClient as never);
    if (entityMethod) {
      (svc as unknown as { getEntityService: () => Record<string, jest.Mock> }).getEntityService =
        jest.fn().mockReturnValue({ GetDeal: entityMethod });
    }
    return svc;
  }

  it('allows user-scoped rows without entity lookup', async () => {
    const svc = new NotificationPointCheckService({ getService: () => ({}) } as never);
    await expect(
      svc.canSendEmail({
        project_id: 'org-1',
        user_id: 'u1',
        scope_kind: 'user',
        entity_type: 'deal',
        entity_id: 'd-1',
      }),
    ).resolves.toBe(true);
  });

  it('allows project rows without linked entity', async () => {
    const svc = new NotificationPointCheckService({ getService: () => ({}) } as never);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: '', entity_id: '' }),
    ).resolves.toBe(true);
  });

  it('fail-closed when project_id or user_id is missing', async () => {
    const svc = new NotificationPointCheckService({ getService: () => ({}) } as never);
    await expect(
      svc.canSendEmail({ project_id: '', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: '', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('allows unknown entity types without downstream lookup', async () => {
    const resolveRecordVisibility = jest.fn();
    const svc = makeSvc(resolveRecordVisibility);
    await expect(
      svc.canSendEmail({
        project_id: 'p1',
        user_id: 'u1',
        entity_type: 'custom_widget',
        entity_id: 'w-1',
      }),
    ).resolves.toBe(true);
    expect(resolveRecordVisibility).not.toHaveBeenCalled();
  });

  it('fail-closed when control resolveRecordVisibility is unavailable', async () => {
    const svc = new NotificationPointCheckService({ getService: () => undefined } as never);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('fail-closed when visibility resolves to allowed=false', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    const resolveRecordVisibility = jest.fn().mockReturnValue(of({ allowed: false }));
    const svc = makeSvc(resolveRecordVisibility, jest.fn().mockReturnValue(of({})));
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('fail-closed when visibility lookup throws', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    const resolveRecordVisibility = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('CONTROL_DOWN')));
    const svc = makeSvc(resolveRecordVisibility);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('fail-closed when entity reader URL env is unset', async () => {
    delete process.env.PIPE_GRPC_URL;
    const resolveRecordVisibility = jest
      .fn()
      .mockReturnValue(of({ allowed: true, mode: 'all', owner_ids: [], shared_record_ids: [] }));
    const svc = makeSvc(resolveRecordVisibility);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('allows email when entity read succeeds after visibility hydration', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    process.env.NOTIFICATION_SERVICE_API_KEY = 'svc-key';
    const resolveRecordVisibility = jest.fn().mockReturnValue(
      of({
        allowed: true,
        mode: 'restricted',
        owner_ids: ['u1'],
        shared_record_ids: ['d-1'],
      }),
    );
    const getDeal = jest.fn().mockReturnValue(of({ id: 'd-1' }));
    const svc = makeSvc(resolveRecordVisibility, getDeal);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deals', entity_id: 'd-1' }),
    ).resolves.toBe(true);
    expect(getDeal).toHaveBeenCalledWith(
      { project_id: 'p1', id: 'd-1' },
      expect.objectContaining({
        get: expect.any(Function),
      }),
    );
  });

  it('denies email when entity read returns NOT_FOUND', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    const resolveRecordVisibility = jest
      .fn()
      .mockReturnValue(of({ allowed: true, mode: 'all', owner_ids: [], shared_record_ids: [] }));
    const getDeal = jest.fn().mockReturnValue(throwError(() => ({ code: status.NOT_FOUND })));
    const svc = makeSvc(resolveRecordVisibility, getDeal);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('denies email when entity read returns PERMISSION_DENIED', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    const resolveRecordVisibility = jest
      .fn()
      .mockReturnValue(of({ allowed: true, mode: 'all', owner_ids: [], shared_record_ids: [] }));
    const getDeal = jest
      .fn()
      .mockReturnValue(throwError(() => ({ code: status.PERMISSION_DENIED })));
    const svc = makeSvc(resolveRecordVisibility, getDeal);
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });

  it('denies email when entity reader stub has no RPC method', async () => {
    process.env.PIPE_GRPC_URL = 'localhost:50051';
    const resolveRecordVisibility = jest
      .fn()
      .mockReturnValue(of({ allowed: true, mode: 'all', owner_ids: [], shared_record_ids: [] }));
    const svc = makeSvc(resolveRecordVisibility);
    (svc as unknown as { getEntityService: () => Record<string, unknown> }).getEntityService = jest
      .fn()
      .mockReturnValue({});
    await expect(
      svc.canSendEmail({ project_id: 'p1', user_id: 'u1', entity_type: 'deal', entity_id: 'd-1' }),
    ).resolves.toBe(false);
  });
});
