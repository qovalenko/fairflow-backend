import { of, throwError, TimeoutError } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { ActivityClaimService } from './activity-claim.service';

function makeService(
  claimReminderFire: jest.Mock,
  releaseReminderFire: jest.Mock = jest.fn().mockReturnValue(of({ released: true })),
): ActivityClaimService {
  const client = {
    getService: () => ({ claimReminderFire, releaseReminderFire }),
  } as unknown as ClientGrpcProxy;
  const svc = new ActivityClaimService(client);
  svc.onModuleInit();
  return svc;
}

describe('ActivityClaimService', () => {
  const OLD_KEY = process.env.NOTIFICATION_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.NOTIFICATION_SERVICE_API_KEY = 'ak_activity';
    process.env.ACTIVITY_CLAIM_TIMEOUT_MS = '3000';
  });

  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.NOTIFICATION_SERVICE_API_KEY;
    else process.env.NOTIFICATION_SERVICE_API_KEY = OLD_KEY;
    delete process.env.ACTIVITY_CLAIM_TIMEOUT_MS;
  });

  it('claimReminderFire returns claimed=false for invalid input without RPC', async () => {
    const claimReminderFire = jest.fn();
    const svc = makeService(claimReminderFire);
    await expect(svc.claimReminderFire('', 'a1', Date.now())).resolves.toEqual({ claimed: false });
    expect(claimReminderFire).not.toHaveBeenCalled();
  });

  it('claimReminderFire maps a successful claim and attaches activity payload', async () => {
    const claimReminderFire = jest.fn().mockReturnValue(
      of({ claimed: true, activity: { id: 'a1', title: 'Call' } }),
    );
    const svc = makeService(claimReminderFire);
    const fireAt = 1_700_000_000_000;
    const res = await svc.claimReminderFire('p1', 'a1', fireAt);
    expect(res).toEqual({ claimed: true, activity: { id: 'a1', title: 'Call' } });
    expect(claimReminderFire).toHaveBeenCalledWith(
      { project_id: 'p1', activity_id: 'a1', fire_at: fireAt },
      expect.objectContaining({
        get: expect.any(Function),
      }),
    );
    const md = claimReminderFire.mock.calls[0][1];
    expect(md.get('x-service-api-key')[0]).toBe('ak_activity');
    expect(md.get('x-project-id')[0]).toBe('p1');
  });

  it('claimReminderFire rethrows transport failures (caller must retry)', async () => {
    const claimReminderFire = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeService(claimReminderFire);
    await expect(svc.claimReminderFire('p1', 'a1', 1)).rejects.toThrow('UNAVAILABLE');
  });

  it('releaseReminderFire is a no-op for invalid input', async () => {
    const releaseReminderFire = jest.fn();
    const svc = makeService(jest.fn(), releaseReminderFire);
    await svc.releaseReminderFire('', 'a1', 1);
    expect(releaseReminderFire).not.toHaveBeenCalled();
  });

  it('releaseReminderFire swallows transport errors (best-effort cleanup)', async () => {
    const releaseReminderFire = jest
      .fn()
      .mockReturnValue(throwError(() => new TimeoutError()));
    const svc = makeService(jest.fn(), releaseReminderFire);
    await expect(svc.releaseReminderFire('p1', 'a1', 123)).resolves.toBeUndefined();
  });
});
