-- DEORG-FIX-1: idempotent repair migration for control.ControlOutbox.
--
-- The DEORG-W1 squash (20260721000000_deorg_w1_squashed_init) folds the whole
-- control schema — incl. ControlOutbox — into a single init migration. All four
-- backend services share ONE physical Postgres DB and ONE `_prisma_migrations`
-- history (folder names are globally unique for that reason). On a box whose DB
-- carried migration history across the DEORG-W1 image bump, the squash folder is
-- recorded as applied while the physical `control.ControlOutbox` table is absent
-- (squash drift). `prisma migrate deploy` then never recreates it, so
-- ControlOutboxRelayService crashes every tick with
-- «The table `control.ControlOutbox` does not exist».
--
-- This additive migration heals that state. It is a strict no-op on a clean DB
-- (the squash already created the table/index) via IF NOT EXISTS, and does not
-- alter the target schema — the Prisma model is unchanged. Never edit an
-- already-applied migration; repair forward instead.

-- CreateTable (idempotent) — must match the squash definition exactly.
CREATE TABLE IF NOT EXISTS "control"."ControlOutbox" (
    "message_id" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "project_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "envelope" JSONB NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "ControlOutbox_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "ControlOutbox_status_created_at_idx" ON "control"."ControlOutbox"("status", "created_at");
