import { Injectable, ExecutionContext, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SessionDenyListService } from '../session-deny-list.service';

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
  constructor(@Optional() private readonly denyList?: SessionDenyListService) {
    super();
  }

  /**
   * After passport validates the JWT, enforce the jti deny-list (token
   * revocation). ON by default; opt out via AUTH_SESSION_DENYLIST=false. See
   * SessionDenyListService.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;
    if (this.denyList?.enabled) {
      const req = this.getRequest(context) as {
        user?: { userId?: string; sessionId?: string };
        headers?: Record<string, unknown>;
      };
      const verdict = await this.denyList.checkAllowed(
        req.user?.userId ?? '',
        req.user?.sessionId ?? '',
        req.headers ?? {},
      );
      if (!verdict.allowed) {
        const reason = verdict.reason ?? 'session_revoked';
        throw new UnauthorizedException({
          message: 'Session revoked',
          reason,
          code: 'SESSION_REVOKED',
        });
      }
    }
    return true;
  }

  getRequest(context: ExecutionContext): unknown {
    const req = context.switchToHttp().getRequest();
    return hasHeaders(req) ? req : { headers: {} };
  }
}
