-- I1a (E3-04): billing↔modules — module subscriptions, usage dedup, outbox,
-- account state-change journal. Additive; does not touch existing tables.

CREATE TABLE "billing"."module_subscriptions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "price_model" TEXT NOT NULL DEFAULT 'flat',
  "unit_price_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'RUB',
  "state" TEXT NOT NULL DEFAULT 'active',
  "revenue_share_bps" INTEGER NOT NULL DEFAULT 0,
  "partner_id" TEXT,
  "trial_ends_at" TIMESTAMP(3),
  "grace_period_end" TIMESTAMP(3),
  "current_period_start" TIMESTAMP(3) NOT NULL,
  "current_period_end" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "module_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "module_subscriptions_project_id_module_id_key"
  ON "billing"."module_subscriptions" ("project_id", "module_id");
CREATE INDEX "module_subscriptions_project_id_state_idx"
  ON "billing"."module_subscriptions" ("project_id", "state");

CREATE TABLE "billing"."account_state_changes" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'account',
  "module_id" TEXT,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_state_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_state_changes_project_id_occurred_at_idx"
  ON "billing"."account_state_changes" ("project_id", "occurred_at" DESC);

CREATE TABLE "billing"."processed_messages" (
  "dedup_key" TEXT NOT NULL,
  "routing_key" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("dedup_key")
);

CREATE TABLE "billing"."event_outbox" (
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
  CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("message_id")
);

CREATE INDEX "event_outbox_status_created_at_idx"
  ON "billing"."event_outbox" ("status", "created_at");
