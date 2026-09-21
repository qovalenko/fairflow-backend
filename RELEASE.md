# Release readiness checklist (v1)

## Pre-release

- [ ] Все workspace собираются: `cd services && npm run build`
- [ ] Infra: `cd docker && docker compose up -d`
- [ ] `export SEED_GATEWAY_SERVICE_API_KEY=ak_...` затем `npm run db:seed:auth` — в **gateway** `.env`: те же значения как `GATEWAY_SERVICE_API_KEY`, плюс `GATEWAY_API_KEY_ID` из вывода seed
- [ ] Control: миграции + seed
- [ ] Contact / Company / Mongo: индексы, seed при необходимости
- [ ] Env: `JWT_SECRET` (auth + gateway), `DATABASE_URL`, `MONGODB_URI`, `AUTH_GRPC_URL` на сервисах с gRPC-приёмом

## E2E (только через gateway)

- [ ] Логин: `POST /api/v1/auth/login` на **gateway:3000** → JWT
- [ ] `GET /api/v1/auth/me` на gateway с Bearer
- [ ] Проекты / контакты / компании / CRM — маршруты gateway (`/api/v1/...`, `/api/crm/...`)
- [ ] Негатив: бизнес-HTTP на портах auth/control/contact/company — **404** (см. `services/scripts/verify-gateway-only.sh`)

## Контракт

- [ ] Внешний вход только gateway
- [ ] gRPC без валидного `x-service-api-key` (scope `gateway:invoke`) → `UNAUTHENTICATED` на доменах

## Observability

- [ ] Prometheus: `/metrics` на gateway, auth, control, contact, company, crm-grpc
- [ ] Логи: request id / trace

## Rollback

- [ ] Миграции обратимы или совместимы
- [ ] При ротации gateway API key — обновить запись в auth и `GATEWAY_SERVICE_API_KEY` на gateway до удаления старого ключа

## Runbooks

- [ ] [docs/architecture/services-runbook.md](../docs/architecture/services-runbook.md)
