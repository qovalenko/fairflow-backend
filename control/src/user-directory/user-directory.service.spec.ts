import { of, throwError } from 'rxjs';
import { UserDirectoryService } from './user-directory.service';
import type { AppConfigService } from '../config/app-config.service';

describe('UserDirectoryService.resolve / revokeSessions', () => {
  type Grpc = {
    resolveUsers: jest.Mock;
    revokeUserSessions: jest.Mock;
  };

  function make(grpc: Grpc, apiKey = 'ak_test'): UserDirectoryService {
    const client = { getService: () => grpc } as never;
    const config = { directoryServiceApiKey: apiKey } as AppConfigService;
    const svc = new UserDirectoryService(client, config);
    svc.onModuleInit();
    return svc;
  }

  it('returns an empty map for empty input', async () => {
    const svc = make({ resolveUsers: jest.fn(), revokeUserSessions: jest.fn() });
    await expect(svc.resolve([])).resolves.toEqual(new Map());
    await expect(svc.resolve(undefined as never)).resolves.toEqual(new Map());
  });

  it('deduplicates ids and resolves profiles from auth', async () => {
    const resolveUsers = jest.fn().mockReturnValue(
      of({
        users: [{ id: 'u1', name: 'Ann', email: 'a@x', login: 'ann' }],
      }),
    );
    const svc = make({ resolveUsers, revokeUserSessions: jest.fn() });
    const map = await svc.resolve(['u1', 'u1', 'u2']);
    expect(resolveUsers).toHaveBeenCalledWith({ ids: ['u1', 'u2'] }, expect.anything());
    expect(map.get('u1')).toEqual({ id: 'u1', name: 'Ann', email: 'a@x', login: 'ann' });
    expect(map.has('u2')).toBe(false);
  });

  it('serves cached entries without calling auth again', async () => {
    const resolveUsers = jest
      .fn()
      .mockReturnValue(of({ users: [{ id: 'u1', name: 'Ann', email: 'a@x', login: 'ann' }] }));
    const svc = make({ resolveUsers, revokeUserSessions: jest.fn() });
    await svc.resolve(['u1']);
    resolveUsers.mockClear();
    const map = await svc.resolve(['u1']);
    expect(resolveUsers).not.toHaveBeenCalled();
    expect(map.get('u1')?.name).toBe('Ann');
  });

  it('returns cached hits when auth is unavailable', async () => {
    const resolveUsers = jest
      .fn()
      .mockReturnValueOnce(of({ users: [{ id: 'u1', name: 'Ann', email: 'a@x', login: 'ann' }] }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const svc = make({ resolveUsers, revokeUserSessions: jest.fn() });
    await svc.resolve(['u1']);
    const map = await svc.resolve(['u1', 'u2']);
    expect(map.get('u1')?.name).toBe('Ann');
    expect(map.has('u2')).toBe(false);
  });

  it('revokeSessions returns 0 for empty input', async () => {
    const svc = make({ resolveUsers: jest.fn(), revokeUserSessions: jest.fn() });
    await expect(svc.revokeSessions([])).resolves.toBe(0);
  });

  it('revokeSessions returns null after retries when auth stays down', async () => {
    jest.useFakeTimers();
    const revokeUserSessions = jest.fn().mockReturnValue(throwError(() => new Error('down')));
    const svc = make({ resolveUsers: jest.fn(), revokeUserSessions });
    const p = svc.revokeSessions(['u1']);
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
    expect(revokeUserSessions.mock.calls.length).toBeGreaterThan(1);
    jest.useRealTimers();
  });
});
