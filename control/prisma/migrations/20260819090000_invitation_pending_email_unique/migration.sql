-- FR-ORG-410: at most one pending invitation per (organization, email).
-- Application code already supersedes duplicates procedurally; this index closes
-- the race window at the database layer.

-- Existing rows may still carry duplicates from the pre-index race window.
-- Keep the newest pending invitation per (organization, email) and revoke the
-- rest, otherwise CREATE UNIQUE INDEX fails on legacy data.
UPDATE "control"."Invitation" AS i
SET "status" = 'revoked'
WHERE i."status" = 'pending'
  AND EXISTS (
    SELECT 1
    FROM "control"."Invitation" AS j
    WHERE j."organization_id" = i."organization_id"
      AND j."email" = i."email"
      AND j."status" = 'pending'
      AND (
        j."created_at" > i."created_at"
        OR (j."created_at" = i."created_at" AND j."id" > i."id")
      )
  );

CREATE UNIQUE INDEX "Invitation_organization_id_email_pending_key"
ON "control"."Invitation"("organization_id", "email")
WHERE "status" = 'pending';
