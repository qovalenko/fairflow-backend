-- FR-AUTH-170: persist why a session was revoked (gateway logout-forced reason codes).
ALTER TABLE "auth"."Session" ADD COLUMN IF NOT EXISTS "revoked_reason" TEXT;

-- FR-AUTH-357: trustEmail editable for DB-backed OIDC providers (env-only before).
ALTER TABLE "auth"."OidcProvider" ADD COLUMN IF NOT EXISTS "trust_email" BOOLEAN NOT NULL DEFAULT false;
