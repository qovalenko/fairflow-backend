import { of, throwError } from 'rxjs';
import { UserDirectoryService } from './user-directory.service';
import type { AppConfigService } from '../config/app-config.service';

/**
 * Loader-canon guard for the auth `UserDirectoryGrpc` client.
 *
 * This client used to be registered with NO `loader` at all, so proto-loader's
 * camelCase defaults applied and the call sites hand-wrote `userIds`/`avatarUrl`
 * to match. It now uses the canonical options (`keepCase:true`), which means the
 * decoded/encoded keys are the proto's snake_case ones — `user_ids` (auth
 * `RevokeUserSessionsRequest`) and `avatar_url` (`UserDirectoryEntry`).
 *
 * Both directions are pinned here because either half getting out of step with
 * the loader is silent: a camelCase `userIds` is simply dropped on the wire and
 * RevokeUserSessions then revokes NOTHING while still reporting success — an
 * org-deactivation cascade (FR-MORG-43) that leaves every JWT alive.
 */
describe('UserDirectoryService — wire keys match the keepCase:true loader', () => {
  type Grpc = {
    resolveUsers: jest.Mock;
    revokeUserSessions: jest.Mock;
  };

  function make(grpc: Grpc): UserDirectoryService {
    const client = { getService: () => grpc } as never;
    const config = { directoryServiceApiKey: 'ak_test' } as AppConfigService;
    const svc = new UserDirectoryService(client, config);
    svc.onModuleInit();
    return svc;
  }

  it('sends snake_case `user_ids` to RevokeUserSessions', async () => {
    const revokeUserSessions = jest.fn().mockReturnValue(of({ revoked_count: 3 }));
    const svc = make({ resolveUsers: jest.fn(), revokeUserSessions });

    await expect(svc.revokeSessions(['u1', 'u2'])).resolves.toBe(3);

    const [request] = revokeUserSessions.mock.calls[0] as [Record<string, unknown>];
    expect(request).toEqual({ user_ids: ['u1', 'u2'] });
    // the camelCase spelling is what the missing loader used to require; if it
    // ever comes back the field silently vanishes on a keepCase:true server
    expect(request).not.toHaveProperty('userIds');
  });

  it('reads snake_case `revoked_count` from the response', async () => {
    const svc = make({
      resolveUsers: jest.fn(),
      revokeUserSessions: jest.fn().mockReturnValue(of({ revoked_count: 7 })),
    });
    await expect(svc.revokeSessions(['u1'])).resolves.toBe(7);
  });

  it('maps snake_case `avatar_url` onto the domain entry', async () => {
    const resolveUsers = jest.fn().mockReturnValue(
      of({
        users: [
          { id: 'u1', name: 'Ann', email: 'a@x', login: 'ann', avatar_url: 'https://x/a.png' },
          { id: 'u2', name: 'Bob', email: 'b@x', login: 'bob' },
        ],
      }),
    );
    const svc = make({ resolveUsers, revokeUserSessions: jest.fn() });

    const map = await svc.resolve(['u1', 'u2']);

    expect(resolveUsers.mock.calls[0][0]).toEqual({ ids: ['u1', 'u2'] });
    expect(map.get('u1')).toEqual({
      id: 'u1',
      name: 'Ann',
      email: 'a@x',
      login: 'ann',
      avatarUrl: 'https://x/a.png',
    });
    expect(map.get('u2')).toEqual({ id: 'u2', name: 'Bob', email: 'b@x', login: 'bob' });
  });

  it('retries RevokeUserSessions before fail-soft null (FR-AUTH-150)', async () => {
    jest.useFakeTimers();
    const revokeUserSessions = jest.fn().mockReturnValue(throwError(() => new Error('auth down')));
    const svc = make({ resolveUsers: jest.fn(), revokeUserSessions });
    const pending = svc.revokeSessions(['u1']);
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(revokeUserSessions).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});
