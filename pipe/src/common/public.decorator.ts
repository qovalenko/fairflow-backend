import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route/resolver as public (no auth). Retained as a harmless marker on
 * health/metrics endpoints; the JWT auth guard that consumed it was removed with
 * the domain's REST surface (domains speak gRPC only).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
