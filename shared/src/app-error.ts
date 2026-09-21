import { HttpStatus } from '@nestjs/common';
import type { AppErrorBody } from './errors';

/**
 * Canonical application error codes shared across all Fairflow services.
 *
 * `paymentRequired` is included in the base union because the gateway HTTP
 * mapping needs it (FR-MORG-23/24: seat-limit reached on a growth op → 402),
 * and it lets control drop its local extension entirely.
 *
 * Services that need extra, protocol-local codes (e.g. auth's OAuth error
 * codes from RFC 6749) parameterise the class:
 *   `new AppError<'invalid_grant' | AppErrorCode>('invalid_grant', ...)`
 * and pass an `extraMap` to `getHttpStatusFromErrorCode`.
 */
export type AppErrorCode =
  | 'invalid'
  | 'notFound'
  | 'internal'
  | 'locked'
  | 'rateLimit'
  | 'access'
  | 'auth'
  // A uniqueness/state invariant is violated (e.g. box single-tenant: the one
  // organization already exists) → 409 Conflict.
  | 'conflict'
  // FR-MORG-23/24: seat-limit reached on a growth op (accept/addEmployee) → 402.
  | 'paymentRequired';

const BASE_STATUS_MAP: Record<AppErrorCode, number> = {
  invalid: HttpStatus.BAD_REQUEST,
  notFound: HttpStatus.NOT_FOUND,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
  locked: HttpStatus.LOCKED,
  rateLimit: HttpStatus.TOO_MANY_REQUESTS,
  access: HttpStatus.FORBIDDEN,
  auth: HttpStatus.UNAUTHORIZED,
  conflict: HttpStatus.CONFLICT,
  paymentRequired: HttpStatus.PAYMENT_REQUIRED,
};

/**
 * Map an error code to an HTTP status. `extraMap` lets callers layer in
 * service-local codes (e.g. auth OAuth codes) without touching the base union.
 */
export function getHttpStatusFromErrorCode(
  code: string,
  extraMap?: Record<string, number>,
): number {
  if (extraMap && code in extraMap) {
    return extraMap[code];
  }
  return (BASE_STATUS_MAP as Record<string, number>)[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

export class AppError<C extends string = AppErrorCode> extends Error {
  constructor(
    public readonly errorCode: C,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): AppErrorBody {
    return {
      errorCode: this.errorCode as AppErrorBody['errorCode'],
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

export interface ValidationErrorItem {
  field: string;
  message: string;
}

export class InvalidDataError extends AppError {
  constructor(
    message: string,
    public readonly errors: ValidationErrorItem[],
  ) {
    super('invalid', message, { errors });
    this.name = 'InvalidDataError';
    Object.setPrototypeOf(this, InvalidDataError.prototype);
  }

  override toJSON(): AppErrorBody {
    return {
      ...super.toJSON(),
      errors: this.errors,
    };
  }
}
