import { GW_METADATA } from '@fairflow/shared';
import { PlatformGrpcController } from './platform.grpc.controller';
import type { PlatformService } from './platform.service';

const PID = 'proj-platform-1';

function metadata(extra: Record<string, string> = {}) {
  const map: Record<string, string[]> = {
    [GW_METADATA.PROJECT_ID]: [PID],
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, [v]])),
  };
  return {
    get: (key: string) => map[key] ?? [],
  } as never;
}

function stubPlatform() {
  return {
    notificationCount: jest.fn().mockResolvedValue({ count: 3 }),
    listNotifications: jest.fn().mockResolvedValue({ list: [] }),
    search: jest.fn().mockReturnValue({ groups: [] }),
    appendAudit: jest.fn().mockResolvedValue({}),
    listAudit: jest.fn().mockResolvedValue({ list: [] }),
    listDocumentTemplates: jest.fn().mockResolvedValue({ list: [] }),
    checkQuota: jest.fn().mockResolvedValue({ allowed: true, reason: '' }),
    createUploadUrl: jest.fn().mockResolvedValue({ upload_url: 'u', file_url: 'f' }),
    dispatchWebhook: jest.fn().mockResolvedValue({ ok: true, error: '' }),
  };
}

describe('PlatformGrpcController', () => {
  it('NotificationCount delegates to the service', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await expect(ctrl.nCount()).resolves.toEqual({ count: 3 });
    expect(platform.notificationCount).toHaveBeenCalled();
  });

  it('ListNotifications delegates to the service', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.nList();
    expect(platform.listNotifications).toHaveBeenCalled();
  });

  it('Search resolves project id from trusted metadata', () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    ctrl.search({ query: 'crm' }, metadata());

    expect(platform.search).toHaveBeenCalledWith(PID, 'crm');
  });

  it('Search rejects a body project_id that conflicts with metadata', () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    expect(() => ctrl.search({ project_id: 'other', query: 'crm' }, metadata())).toThrow(
      'projectId in request body does not match trusted x-project-id metadata',
    );
    expect(platform.search).not.toHaveBeenCalled();
  });

  it('AppendAudit forwards the payload to the service', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);
    const body = {
      project_id: PID,
      type: 'update',
      user_id: 'u1',
      user_name: 'User',
      entity_type: 'deal',
      entity_id: 'd1',
      changes_json: '{}',
    };

    await ctrl.audit(body);

    expect(platform.appendAudit).toHaveBeenCalledWith(body);
  });

  it('ListAudit uses metadata project id and default page size', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.listAudit({ page_size: 25 }, metadata());

    expect(platform.listAudit).toHaveBeenCalledWith(PID, 25);
  });

  it('ListAudit defaults page size to 50', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.listAudit({}, metadata());

    expect(platform.listAudit).toHaveBeenCalledWith(PID, 50);
  });

  it('ListDocumentTemplates resolves project id from metadata', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.docs({}, metadata());

    expect(platform.listDocumentTemplates).toHaveBeenCalledWith(PID);
  });

  it('CheckQuota forwards user and action', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.quota({ user_id: 'u1', action: 'documents.generate' });

    expect(platform.checkQuota).toHaveBeenCalledWith('u1', 'documents.generate');
  });

  it('CreateUploadUrl maps snake_case object_key', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.upload({ bucket: 'docs', object_key: 'a.pdf' });

    expect(platform.createUploadUrl).toHaveBeenCalledWith('docs', 'a.pdf');
  });

  it('DispatchWebhook forwards url and payload_json', async () => {
    const platform = stubPlatform();
    const ctrl = new PlatformGrpcController(platform as unknown as PlatformService);

    await ctrl.webhook({ url: 'https://hook', payload_json: '{"x":1}' });

    expect(platform.dispatchWebhook).toHaveBeenCalledWith('https://hook', '{"x":1}');
  });
});
