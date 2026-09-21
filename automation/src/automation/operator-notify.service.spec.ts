import { ClientGrpcProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { OperatorNotifyService } from './operator-notify.service';

describe('OperatorNotifyService', () => {
  const urlFlag = process.env.NOTIFICATION_GRPC_URL;
  const mockSend = jest.fn();

  beforeEach(() => {
    mockSend.mockReset();
    jest.spyOn(ClientGrpcProxy.prototype, 'getService').mockReturnValue({ Send: mockSend } as never);
    jest.spyOn(ClientGrpcProxy.prototype as never, 'createClients' as never).mockImplementation(() => undefined as never);
    process.env.NOTIFICATION_GRPC_URL = 'notification:5010';
    process.env.AUTOMATION_SERVICE_API_KEY = 'ak_test';
    process.env.AUTOMATION_API_KEY_ID = 'key-id';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (urlFlag === undefined) delete process.env.NOTIFICATION_GRPC_URL;
    else process.env.NOTIFICATION_GRPC_URL = urlFlag;
  });

  it('returns false for blank userId without calling notification', async () => {
    const svc = new OperatorNotifyService();
    await expect(
      svc.notify({ projectId: 'p1', userId: '  ', title: 't', body: 'b' }),
    ).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns false when NOTIFICATION_GRPC_URL is unset', async () => {
    delete process.env.NOTIFICATION_GRPC_URL;
    const svc = new OperatorNotifyService();
    await expect(
      svc.notify({ projectId: 'p1', userId: 'u1', title: 't', body: 'b' }),
    ).resolves.toBe(false);
  });

  it('sends in_app notification with truncated title/body and returns true', async () => {
    mockSend.mockReturnValue(of({ ok: true }));
    const svc = new OperatorNotifyService();
    const ok = await svc.notify({
      projectId: 'p1',
      userId: 'u1',
      title: 'x'.repeat(300),
      body: 'y'.repeat(5000),
      data: { rule_id: 'r1' },
      idempotencyKey: 'idem-1',
    });
    expect(ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p1',
        user_id: 'u1',
        channel: 'in_app',
        title: 'x'.repeat(200),
        body: 'y'.repeat(4000),
        idempotency_key: 'idem-1',
      }),
      expect.objectContaining({ get: expect.any(Function) }),
    );
    const payload = JSON.parse(String(mockSend.mock.calls[0][0].data_json));
    expect(payload).toMatchObject({ source: 'automation', rule_id: 'r1' });
  });

  it('returns false when notification grpc fails', async () => {
    mockSend.mockReturnValue(throwError(() => new Error('deadline exceeded')));
    const svc = new OperatorNotifyService();
    await expect(
      svc.notify({ projectId: 'p1', userId: 'u1', title: 't', body: 'b' }),
    ).resolves.toBe(false);
  });
});
