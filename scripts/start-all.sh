#!/usr/bin/env bash
# Start infra, apply migrations/seeds, run services (auth, control, contact, company, gateway).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required"
  exit 1
fi
if [ -z "${MONGODB_URI:-}" ]; then
  echo "MONGODB_URI is required"
  exit 1
fi

echo "==> Starting Docker infra..."
(cd docker && test -f .env || cp .env.example .env && docker compose up -d)

echo "==> Waiting for Postgres..."
until (docker compose -f docker/docker-compose.yml exec -T postgres pg_isready -U fairflow -d fairflow 2>/dev/null); do
  sleep 1
done 2>/dev/null || sleep 5

echo "==> Auth: db push + seed..."
(cd auth && npm run db:push 2>/dev/null || true && npm run db:seed)

echo "==> Control: db push + seed..."
(cd control && npm run db:push 2>/dev/null || true && npm run db:seed)

echo "==> Mongo: seed contacts & companies..."
(cd "$ROOT" && MONGODB_URI="$MONGODB_URI" npx ts-node -r tsconfig-paths/register scripts/seed-mongo.ts 2>/dev/null || echo "Mongo seed skipped (run when mongo is up)")

echo "==> Starting services (background)..."
cd auth && PORT=3001 npm run start:prod &
cd "$ROOT/control" && PORT=3002 npm run start:prod &
cd "$ROOT/contact" && PORT=3010 npm run start:prod &
cd "$ROOT/company" && PORT=3011 npm run start:prod &
cd "$ROOT/gateway" && PORT=3000 npm run start:prod &
wait
