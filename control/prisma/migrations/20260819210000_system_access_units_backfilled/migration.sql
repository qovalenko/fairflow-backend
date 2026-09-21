-- FR-ORG-235: per-system flag gating Department→AccessUnit graph switch in visibility resolver.
ALTER TABLE "control"."system_settings"
  ADD COLUMN IF NOT EXISTS "access_units_backfilled" BOOLEAN NOT NULL DEFAULT false;
