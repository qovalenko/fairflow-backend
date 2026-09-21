import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';
import { JwtOrPublicGuard } from './jwt-or-public.guard';

describe('JwtOrPublicGuard', () => {
  let reflector: Reflector;
  let guard: JwtOrPublicGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtOrPublicGuard(reflector);
  });

  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
  } as ExecutionContext;

  it('allows public routes without invoking JWT validation', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const superSpy = jest.spyOn(Object.getPrototypeOf(JwtOrPublicGuard.prototype), 'canActivate');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(superSpy).not.toHaveBeenCalled();
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });

  it('delegates to JwtAuthGuard for protected routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const delegated = jest
      .spyOn(Object.getPrototypeOf(JwtOrPublicGuard.prototype), 'canActivate')
      .mockReturnValue(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(delegated).toHaveBeenCalledWith(ctx);
  });
});
