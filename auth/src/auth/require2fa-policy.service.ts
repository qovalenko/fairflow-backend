import { Injectable } from '@nestjs/common';

/**
 * Org/project `require2FA` policy cache (FR-MPROF-10, FR-PROFILE-110).
 * BOX: bootstrapped from `AUTH_REQUIRE_2FA_POLICY=true` until control publishes
 * the flag via `control.policy.updated` (org-structure stream).
 */
@Injectable()
export class Require2faPolicyService {
  private required = process.env.AUTH_REQUIRE_2FA_POLICY === 'true';

  isRequired(): boolean {
    return this.required;
  }

  /** For tests and a future policy-sync consumer. */
  setRequired(value: boolean): void {
    this.required = value;
  }
}
