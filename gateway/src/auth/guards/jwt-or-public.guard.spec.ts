import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';
import { JwtOrPublicGuard } from './jwt-or-public.guard';

describe('JwtOrPublicGuard', () => {
  function ctx(): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as ExecutionContext;
  }

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('allows public routes without requiring JWT', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => true) } as unknown as Reflector;
    const guard = new JwtOrPublicGuard(reflector);
    const parent = jest
      .spyOn(Object.getPrototypeOf(JwtOrPublicGuard.prototype), 'canActivate')
      .mockRejectedValue(new Error('no token'));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(parent).toHaveBeenCalled();
  });

  it('delegates to JwtAuthGuard for protected routes', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => false) } as unknown as Reflector;
    const guard = new JwtOrPublicGuard(reflector);
    jest
      .spyOn(Object.getPrototypeOf(JwtOrPublicGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
  });
});
