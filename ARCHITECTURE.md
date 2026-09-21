# Fairflow Services Architecture

## Ingress (канон)

| Роль | Сервис | Описание |
|------|--------|----------|
| Единственный публичный API | **gateway** :3000 | REST (`/api/...`) — публичный контракт только REST (GraphQL выпилен, P8 T0.1) |
| Внутренние домены | auth, control, contact, company, crm-grpc | Только gRPC для бизнеса; HTTP — **только** `/healthz`, `/readyz`, `/status`, `/metrics` |

## Порты (локальная разработка)

| Сервис   | HTTP | gRPC |
|----------|------|------|
| gateway  | 3000 | —    |
| auth     | 3001 | 5001 |
| control  | 3002 | 5002 |
| contact  | 3003 | 5003 |
| company  | 3004 | 5004 |
| crm-grpc | 3005 | 5005–5009 |

## Межсервисная безопасность

- **Клиент → gateway:** JWT (`Authorization: Bearer`). Подпись проверяется на gateway (`JWT_SECRET` = как у auth при выдаче токенов).
- **Gateway → домены (gRPC):** каждый вызов с metadata из `@fairflow/shared` (`x-service-api-key`, `x-gateway-api-key-id`, `x-request-id`, `x-gateway-issued-at`, при необходимости `x-user-id`, `x-project-id`, trace headers). Ключ выдаётся seed’ом auth, scope **`gateway:invoke`**.
- **Доменный сервис:** перед RPC проверяет ключ через auth `ApiKeyGrpc.ValidateServiceApiKey` (кэш). Нет парсинга end-user JWT в сервисах.

## Данные

- **Postgres:** auth, control; gateway (Prisma для своих нужд при необходимости).
- **Mongo:** contact, company, crm-grpc (pipe, orders, product, activity).

## Новый сервис

1. Скопировать шаблон из `contact` / `control`.
2. Подключить `AuthValidationModule` (или аналог): проверка `x-service-api-key` через auth gRPC.
3. HTTP только health/metrics; бизнес — gRPC.
4. Зарегистрировать клиент в `gateway` `grpc-bff.module.ts` и BFF-контроллерах с `GatewayOutboundMetadataService`.
