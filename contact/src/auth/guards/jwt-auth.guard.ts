import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';
import { RequestContext } from '../../common/request-context';

function hasHeaders(x: unknown): x is { headers: Record<string, unknown> } {
  return (
    x != null &&
    typeof x === 'object' &&
    'headers' in x &&
    typeof (x as { headers: unknown }).headers === 'object'
  );
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): unknown {
    const type = context.getType<string>();
    if (type === 'graphql') {
      const gql = GqlExecutionContext.create(context);
      const ctx = gql.getContext() as {
        req?: unknown;
        reply?: { request?: unknown };
        _requestForGuard?: unknown;
      };
      const req =
        ctx?.req ??
        ctx?._requestForGuard ??
        (ctx?.reply as { request?: unknown } | undefined)?.request ??
        RequestContext.getCurrentRequest();
      if (hasHeaders(req)) return req;
      return { headers: {} };
    }
    const req = context.switchToHttp().getRequest();
    return hasHeaders(req) ? req : { headers: {} };
  }
}
