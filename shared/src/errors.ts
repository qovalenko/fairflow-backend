/**
 * Error contract aligned with AppError (see ./app-error).
 * Use for inter-service error responses and client handling.
 *
 * `AppErrorCode` (the canonical code union, incl. `paymentRequired`) and the
 * `AppError` class live in ./app-error; this module owns the wire body shape
 * (`AppErrorBody`) that `AppError.toJSON()` produces.
 */
import type { AppErrorCode } from './app-error';

export interface AppErrorBody {
  errorCode: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
  errors?: Array<{ field: string; message: string }>;
}

export function isAppErrorBody(body: unknown): body is AppErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    'errorCode' in body &&
    'message' in body
  );
}
