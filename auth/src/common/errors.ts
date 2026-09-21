import { HttpStatus } from '@nestjs/common';

export type AppErrorCode =
  | 'invalid'
  | 'notFound'
  | 'internal'
  | 'auth'
  | 'access'
  | 'rateLimit'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type';

export function getHttpStatusFromErrorCode(code: AppErrorCode): number {
  const map: Record<AppErrorCode, number> = {
    invalid: HttpStatus.BAD_REQUEST,
    notFound: HttpStatus.NOT_FOUND,
    internal: HttpStatus.INTERNAL_SERVER_ERROR,
    auth: HttpStatus.UNAUTHORIZED,
    access: HttpStatus.FORBIDDEN,
    rateLimit: HttpStatus.TOO_MANY_REQUESTS,
    invalid_client: HttpStatus.UNAUTHORIZED,
    invalid_grant: HttpStatus.BAD_REQUEST,
    unsupported_grant_type: HttpStatus.BAD_REQUEST,
  };
  return map[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

export class AppError extends Error {
  constructor(
    public readonly errorCode: AppErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      errorCode: this.errorCode,
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
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), errors: this.errors };
  }
}
