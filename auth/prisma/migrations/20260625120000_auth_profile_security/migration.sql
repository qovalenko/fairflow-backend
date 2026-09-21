-- profile-module / identity-auth TO-BE (WM4-profile-be)
-- Additive: 2FA, email-change, password-change tracking on User; Session enrichment; backup codes.

ALTER TABLE "auth"."User"
  ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "two_factor_secret" TEXT,
  ADD COLUMN "two_factor_pending_secret" TEXT,
  ADD COLUMN "two_factor_enabled_at" TIMESTAMP(3),
  ADD COLUMN "pending_email" TEXT,
  ADD COLUMN "password_changed_at" TIMESTAMP(3);

ALTER TABLE "auth"."Session"
  ADD COLUMN "refresh_token_id" TEXT,
  ADD COLUMN "device_label" TEXT,
  ADD COLUMN "last_seen_at" TIMESTAMP(3),
  ADD COLUMN "revoked_at" TIMESTAMP(3);

CREATE INDEX "Session_user_id_revoked_at_idx" ON "auth"."Session"("user_id", "revoked_at");
CREATE INDEX "Session_last_seen_at_idx" ON "auth"."Session"("last_seen_at");

CREATE TABLE "auth"."UserBackupCode" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserBackupCode_user_id_idx" ON "auth"."UserBackupCode"("user_id");

ALTER TABLE "auth"."UserBackupCode"
  ADD CONSTRAINT "UserBackupCode_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
