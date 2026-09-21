-- OIDC SSO (FR-AUTH-350): external IdP identity → local User link.
-- Additive: new table only. Identity key is (issuer, subject).

CREATE TABLE "auth"."UserOidcIdentity" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserOidcIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserOidcIdentity_issuer_subject_key" ON "auth"."UserOidcIdentity"("issuer", "subject");
CREATE INDEX "UserOidcIdentity_user_id_idx" ON "auth"."UserOidcIdentity"("user_id");

ALTER TABLE "auth"."UserOidcIdentity"
  ADD CONSTRAINT "UserOidcIdentity_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
