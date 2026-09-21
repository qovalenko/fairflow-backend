/** Logout-forced reason codes shared with the host UI (FR-AUTH-170 / FR-MPROF-17a). */
export type SessionRevokeReason =
  | 'session_revoked'
  | 'password_changed'
  | 'signed_out'
  | 'account_removed'
  | 'token_expired';

export function profileRevokeToReason(
  reason: 'manual' | 'password_change' | 'revoke_others' | 'org_deactivated',
): SessionRevokeReason {
  if (reason === 'password_change') return 'password_changed';
  if (reason === 'org_deactivated') return 'account_removed';
  return 'session_revoked';
}
