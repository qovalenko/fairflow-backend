import type { GrpcInvokeResult } from './grpc-action-executor';

/**
 * Error-code prefix every CRM executor uses for a TRANSIENT failure — one that
 * another delivery can plausibly fix (target unreachable, deadline, overload).
 * Anything NOT carrying this prefix is terminal by construction: retrying a
 * misconfigured rule forever only burns the ladder and hides the real cause.
 *
 * Read by {@link isTransientExecutorError}, by
 * `FinalActionConsumerService.isTransient` (order saga ladder) and by the DLQ
 * auto-retry scheduler, so the three never drift apart.
 *
 * (`send_email` predates this module and keeps its own `email_send_unavailable`
 * prefix — see `EMAIL_TRANSIENT_ERROR`; both are recognised by the callers.)
 */
export const EXECUTOR_TRANSIENT_ERROR = 'executor_transient';

/**
 * gRPC statuses that mean "asking again will not help" → terminal, with a stable
 * operator-facing suffix. `grpc_7` in a sales manager's error banner is a support
 * ticket; `permission_denied` is something an admin can act on.
 */
const TERMINAL_GRPC_CODES = new Map<number, string>([
  [3, 'invalid_argument'], // INVALID_ARGUMENT — the rule config is wrong
  [5, 'not_found'], //        NOT_FOUND — entity gone / wrong project
  [6, 'already_exists'], //   ALREADY_EXISTS
  [7, 'permission_denied'], //PERMISSION_DENIED — service actor refused
  [9, 'failed_precondition'],//FAILED_PRECONDITION — e.g. closed deal
  [11, 'out_of_range'],
  [12, 'unimplemented'], //   target build has no such RPC
  [16, 'unauthenticated'], // AUTOMATION_SERVICE_API_KEY unset/inactive
]);

/** Trim a transport message down to something safe to store on an execution row. */
function short(detail: string, max = 160): string {
  const one = detail.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return one ? `:${one}` : '';
}

/**
 * Turn a failed {@link GrpcInvokeResult} into an executor error code.
 *
 * `prefix` names the action (`assign_user`, `change_stage`, …) so the operator
 * sees WHICH step failed. The transient/terminal split is the whole point: only
 * a live transport fault gets {@link EXECUTOR_TRANSIENT_ERROR}, everything the
 * target rejected on its merits stays terminal.
 */
export function classifyGrpcFailure(res: GrpcInvokeResult, prefix: string): string {
  if (res.notConfigured) {
    // `<DOMAIN>_GRPC_URL` is unset: a deployment config error, not a blip. Kept
    // terminal so a half-deployed cluster does not silently spin the ladder.
    return `${prefix}_target_not_configured`;
  }
  const terminal = res.grpcCode != null ? TERMINAL_GRPC_CODES.get(res.grpcCode) : undefined;
  if (terminal) return `${prefix}_rejected:${terminal}`;
  return `${EXECUTOR_TRANSIENT_ERROR}:${prefix}${short(String(res.error ?? ''))}`;
}

/** True when the error code was produced as transient (worth another attempt). */
export function isTransientExecutorError(error: string): boolean {
  return String(error ?? '').startsWith(EXECUTOR_TRANSIENT_ERROR);
}
