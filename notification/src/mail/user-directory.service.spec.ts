import { of, throwError } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { UserDirectoryService } from './user-directory.service';

function makeService(resolveUsers: jest.Mock): UserDirectoryService {
  const client = {
    getService: () => ({ resolveUsers }),
  } as unknown as ClientGrpcProxy;
  const svc = new UserDirectoryService(client);
  svc.onModuleInit();
  return svc;
}

describe('UserDirectoryService.resolveEmail (SEC-N-9)', () => {
  const OLD_KEY = process.env.NOTIFICATION_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.NOTIFICATION_SERVICE_API_KEY = 'ak_notif_dir';
  });

  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.NOTIFICATION_SERVICE_API_KEY;
    else process.env.NOTIFICATION_SERVICE_API_KEY = OLD_KEY;
  });

  it('returns empty string for blank userId without calling auth', async () => {
    const resolveUsers = jest.fn();
    const svc = makeService(resolveUsers);
    await expect(svc.resolveEmail('')).resolves.toBe('');
    expect(resolveUsers).not.toHaveBeenCalled();
  });

  it('resolves email from auth and caches the result', async () => {
    const resolveUsers = jest
      .fn()
      .mockReturnValue(of({ users: [{ id: 'u1', email: '  alice@test  ' }] }));
    const svc = makeService(resolveUsers);
    await expect(svc.resolveEmail('u1')).resolves.toBe('alice@test');
    await expect(svc.resolveEmail('u1')).resolves.toBe('alice@test');
    expect(resolveUsers).toHaveBeenCalledTimes(1);
    const [, md] = resolveUsers.mock.calls[0];
    expect(md.get('x-service-api-key')[0]).toBe('ak_notif_dir');
  });

  it('returns empty string on transport failure (fail-soft for fan-out)', async () => {
    const resolveUsers = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const svc = makeService(resolveUsers);
    await expect(svc.resolveEmail('u2')).resolves.toBe('');
  });

  it('returns empty string when user is unknown in the directory response', async () => {
    const resolveUsers = jest.fn().mockReturnValue(of({ users: [{ id: 'other', email: 'x@y' }] }));
    const svc = makeService(resolveUsers);
    await expect(svc.resolveEmail('missing')).resolves.toBe('');
  });
});
