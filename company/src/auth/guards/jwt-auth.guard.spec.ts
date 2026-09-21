import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtOrPublicGuard } from './jwt-or-public.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequestContext } from '../../common/request-context';

describe('JwtAuthGuard', () => {
  it('extracts HTTP request from switchToHttp', () => {
    const guard = new JwtAuthGuard();
    const req = { headers: { authorization: 'Bearer t' } };
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(guard.getRequest(ctx)).toBe(req);
  });

  it('falls back to empty headers when HTTP request is malformed', () => {
    const guard = new JwtAuthGuard();
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => null }),
    } as unknown as ExecutionContext;
    expect(guard.getRequest(ctx)).toEqual({ headers: {} });
  });

  it('extracts GraphQL request from context.req', () => {
    const guard = new JwtAuthGuard();
    const req = { headers: { authorization: 'Bearer gql' } };
    const ctx = {
      getType: () => 'graphql',
    } as unknown as ExecutionContext;
    jest
      .spyOn(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@nestjs/graphql').GqlExecutionContext,
        'create',
      )
      .mockReturnValue({
        getContext: () => ({ req }),
      });
    expect(guard.getRequest(ctx)).toBe(req);
  });

  it('uses RequestContext fallback for GraphQL when req is missing', () => {
    const guard = new JwtAuthGuard();
    const fallback = { headers: { authorization: 'Bearer ctx' } };
    jest.spyOn(RequestContext, 'getCurrentRequest').mockReturnValue(fallback);
    const ctx = { getType: () => 'graphql' } as unknown as ExecutionContext;
    jest
      .spyOn(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@nestjs/graphql').GqlExecutionContext,
        'create',
      )
      .mockReturnValue({
        getContext: () => ({}),
      });
    expect(guard.getRequest(ctx)).toBe(fallback);
  });
});

describe('JwtOrPublicGuard', () => {
  it('bypasses auth when handler is marked @Public()', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const guard = new JwtOrPublicGuard(reflector);
    const ctx = { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('delegates to JwtAuthGuard when route is not public', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new JwtOrPublicGuard(reflector);
    const parent = jest
      .spyOn(JwtAuthGuard.prototype, 'canActivate')
      .mockReturnValue(false as never);
    const ctx = { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(false);
    expect(parent).toHaveBeenCalledWith(ctx);
    parent.mockRestore();
  });
});
