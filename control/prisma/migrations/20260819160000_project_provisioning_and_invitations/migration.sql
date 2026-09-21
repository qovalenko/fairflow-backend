-- FR-PROJ-095: observable provisioning status on projects.
ALTER TABLE "control"."Project"
  ADD COLUMN IF NOT EXISTS "provisioning_status" TEXT NOT NULL DEFAULT 'complete';

-- FR-PROJ-250: project-scoped email invitations.
CREATE TABLE IF NOT EXISTS "control"."ProjectInvitation" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "invited_by_user_id" TEXT NOT NULL,
  "accepted_user_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectInvitation_token_key"
  ON "control"."ProjectInvitation"("token");

CREATE INDEX IF NOT EXISTS "ProjectInvitation_project_id_idx"
  ON "control"."ProjectInvitation"("project_id");

CREATE INDEX IF NOT EXISTS "ProjectInvitation_email_idx"
  ON "control"."ProjectInvitation"("email");

CREATE INDEX IF NOT EXISTS "ProjectInvitation_project_id_email_status_idx"
  ON "control"."ProjectInvitation"("project_id", "email", "status");

ALTER TABLE "control"."ProjectInvitation"
  ADD CONSTRAINT "ProjectInvitation_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "control"."Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
