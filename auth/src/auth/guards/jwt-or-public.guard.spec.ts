import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtOrPublicGuard } from './jwt-or-public.guard';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';

describe('JwtOrPublicGuard', () => {
  const makeContext = (): ExecutionContext =>
    ({
      getHandler: () => ({ name: 'handler' }),
      getClass: () => ({ name: 'Controller' }),
    }) as never;

  it('allows @Public routes without invoking JWT validation', () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => (key === IS_PUBLIC_KEY ? true : undefined)),
    } as unknown as Reflector;
    const parent = jest.spyOn(JwtAuthGuard.prototype, 'canActivate');
    const guard = new JwtOrPublicGuard(reflector);
    expect(guard.canActivate(makeContext())).toBe(true);
    expect(parent).not.toHaveBeenCalled();
    parent.mockRestore();
  });

  it('delegates to JwtAuthGuard when the route is not public', () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => (key === IS_PUBLIC_KEY ? false : undefined)),
    } as unknown as Reflector;
    const parent = jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockReturnValue(true);
    const guard = new JwtOrPublicGuard(reflector);
    const ctx = makeContext();
    expect(guard.canActivate(ctx)).toBe(true);
    expect(parent).toHaveBeenCalledWith(ctx);
    parent.mockRestore();
  });
});
