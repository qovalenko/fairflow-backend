import { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  function ctx(req: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext;
  }

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns false when passport rejects the token', async () => {
    const guard = new JwtAuthGuard();
    jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(false);
    await expect(guard.canActivate(ctx({ headers: {} }))).resolves.toBe(false);
  });

  it('passes through when deny-list PEP is disabled', async () => {
    const denyList = { enabled: false, checkAllowed: jest.fn() };
    const guard = new JwtAuthGuard(denyList as never);
    jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    await expect(
      guard.canActivate(ctx({ user: { userId: 'u1', sessionId: 's1' }, headers: {} })),
    ).resolves.toBe(true);
    expect(denyList.checkAllowed).not.toHaveBeenCalled();
  });

  it('throws SESSION_REVOKED when deny-list rejects the session', async () => {
    const denyList = {
      enabled: true,
      checkAllowed: jest.fn().mockResolvedValue({ allowed: false, reason: 'logout' }),
    };
    const guard = new JwtAuthGuard(denyList as never);
    jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    await expect(
      guard.canActivate(ctx({ user: { userId: 'u1', sessionId: 's1' }, headers: {} })),
    ).rejects.toMatchObject({
      response: { code: 'SESSION_REVOKED', reason: 'logout' },
    });
    expect(denyList.checkAllowed).toHaveBeenCalledWith('u1', 's1', {});
  });

  it('getRequest wraps non-http contexts with empty headers', () => {
    const guard = new JwtAuthGuard();
    const bare = guard.getRequest({ switchToHttp: () => ({ getRequest: () => ({}) }) } as never);
    expect(bare).toEqual({ headers: {} });
  });

  it('skips deny-list when optional dependency is absent', async () => {
    const guard = new JwtAuthGuard(undefined);
    jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    await expect(guard.canActivate(ctx({ user: { userId: 'u1' }, headers: {} }))).resolves.toBe(
      true,
    );
  });
});
