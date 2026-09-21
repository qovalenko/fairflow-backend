-- Audit #9: enforce at most one `active` subscription per project.
-- Prisma cannot express a filtered unique index, so it is created with raw SQL.
CREATE UNIQUE INDEX "subscriptions_one_active_per_project_key"
  ON "billing"."subscriptions" ("project_id")
  WHERE "status" = 'active';
