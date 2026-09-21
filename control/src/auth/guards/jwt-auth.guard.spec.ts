import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequestContext } from '../../common/request-context';

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard();

  afterEach(() => {
    RequestContext.setCurrentRequest(undefined);
  });

  it('returns the HTTP request when headers are present', () => {
    const req = { headers: { authorization: 'Bearer tok' } };
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext;
    expect(guard.getRequest(ctx)).toBe(req);
  });

  it('returns empty headers when the HTTP request is malformed', () => {
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => null }),
    } as ExecutionContext;
    expect(guard.getRequest(ctx)).toEqual({ headers: {} });
  });

  it('prefers graphql context req for GraphQL calls', () => {
    const gqlReq = { headers: { authorization: 'Bearer gql' } };
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: gqlReq }),
    } as ReturnType<typeof GqlExecutionContext.create>);
    const ctx = { getType: () => 'graphql' } as ExecutionContext;
    expect(guard.getRequest(ctx)).toBe(gqlReq);
  });

  it('falls back to RequestContext when graphql context has no req', () => {
    const stored = { headers: { authorization: 'Bearer ctx' } };
    RequestContext.setCurrentRequest(stored);
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({}),
    } as ReturnType<typeof GqlExecutionContext.create>);
    const ctx = { getType: () => 'graphql' } as ExecutionContext;
    expect(guard.getRequest(ctx)).toBe(stored);
  });
});
