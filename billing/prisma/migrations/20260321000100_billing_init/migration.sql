CREATE SCHEMA IF NOT EXISTS "billing";

CREATE TABLE "billing"."plans" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "price_minor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "billing_period" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing"."plan_quotas" (
  "id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "limit" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_quotas_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing"."subscriptions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "current_period_start" TIMESTAMP(3) NOT NULL,
  "current_period_end" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing"."payments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_payment_id" TEXT,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing"."invoices" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing"."quota_usage" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "period_key" TEXT NOT NULL,
  "used" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quota_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_code_key" ON "billing"."plans"("code");
CREATE UNIQUE INDEX "plan_quotas_plan_id_action_key" ON "billing"."plan_quotas"("plan_id", "action");
CREATE UNIQUE INDEX "invoices_project_id_number_key" ON "billing"."invoices"("project_id", "number");
CREATE UNIQUE INDEX "quota_usage_project_id_action_period_key_key" ON "billing"."quota_usage"("project_id", "action", "period_key");

CREATE INDEX "subscriptions_project_id_status_idx" ON "billing"."subscriptions"("project_id", "status");
CREATE INDEX "payments_project_id_created_at_idx" ON "billing"."payments"("project_id", "created_at" DESC);
CREATE INDEX "invoices_project_id_issued_at_idx" ON "billing"."invoices"("project_id", "issued_at" DESC);
CREATE INDEX "quota_usage_project_id_action_idx" ON "billing"."quota_usage"("project_id", "action");

ALTER TABLE "billing"."plan_quotas"
ADD CONSTRAINT "plan_quotas_plan_id_fkey"
FOREIGN KEY ("plan_id") REFERENCES "billing"."plans"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing"."subscriptions"
ADD CONSTRAINT "subscriptions_plan_id_fkey"
FOREIGN KEY ("plan_id") REFERENCES "billing"."plans"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing"."payments"
ADD CONSTRAINT "payments_subscription_id_fkey"
FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing"."invoices"
ADD CONSTRAINT "invoices_subscription_id_fkey"
FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
