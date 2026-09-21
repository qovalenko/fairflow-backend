ALTER TABLE "auth"."User"
  ADD COLUMN "avatar_url" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "position" TEXT,
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'ru',
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD COLUMN "date_format" TEXT NOT NULL DEFAULT 'DD.MM.YYYY',
  ADD COLUMN "time_format" TEXT NOT NULL DEFAULT '24h',
  ADD COLUMN "thousands_separator" TEXT NOT NULL DEFAULT 'space',
  ADD COLUMN "default_deals_view" TEXT NOT NULL DEFAULT 'kanban',
  ADD COLUMN "default_activities_view" TEXT NOT NULL DEFAULT 'list';
