import { ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionDenyListService } from '../session-deny-list.service';

@Injectable()
export class JwtOrPublicGuard extends JwtAuthGuard {
  constructor(
    private readonly reflector: Reflector,
    @Optional() denyList?: SessionDenyListService,
  ) {
    super(denyList);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // Optional auth: when a valid Bearer is present on a public route, attach
      // `req.user` (invite accept for an existing account — FR-AUTH-320).
      try {
        await super.canActivate(context);
      } catch {
        /* no/invalid token — public route stays open */
      }
      return true;
    }
    return super.canActivate(context);
  }
}
