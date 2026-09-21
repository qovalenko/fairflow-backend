# Orders

Домен продаж (оформления). **Продажа (Order)** — процесс, порождаемый из
выигранной сделки, а её поля, этапы, документы и финальное действие диктует
**тип продажи (Order Type)**. Orders владеет и продажами, и типами продаж с их
ревизиями, и сагой финального действия. Наружу отдаёт только gRPC
(`fairflow.orders.v1`, порт 5006).

Связь «продукт → тип продажи» идёт от продукта, а не наоборот —
[../docs/04-domain-model.md](../docs/04-domain-model.md) §3.

## Что хранит

**MongoDB**:

| Коллекция | Что лежит |
| --- | --- |
| `crm_orders` | продажи проекта |
| `crm_order_types` | типы продаж: поля, этапы, документы, спецификация финального действия |
| `crm_order_type_revisions` | версии типа продажи; продажа держится своей ревизии, расхождение видно как дрейф |
| `crm_order_counters` | счётчики сквозной нумерации продаж внутри проекта |
| `idempotency_keys` | журнал идемпотентности мутаций (TTL) |
| `crm_event_outbox` | transactional outbox исходящих событий (TTL на опубликованные) |

Составные бизнес-индексы ведут `projectId`: `{ projectId, updatedAt }`,
`{ projectId, dealId }`, `{ projectId, contactId }`, `{ projectId, companyId }`,
`{ projectId, typeId, stageId }`, уникальный `{ projectId, number }`,
`{ projectId, orderTypeId, version }` на ревизиях
(`src/mongo/mongo.service.ts`). Требование барьера NFR-550 — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».

## gRPC-API

Пакет `fairflow.orders.v1`, контракт — [`proto/fairflow/orders/v1/orders.proto`](../proto/fairflow/orders/v1/orders.proto),
реализация — `src/orders/orders.grpc.controller.ts`. Один сервис `OrdersGrpc`, 25 методов.

| Группа | Методы |
| --- | --- |
| Продажи: чтение | `ListOrders`, `GetOrder`, `GetOrdersKanban`, `GetOrdersSummaryForDeal` |
| Продажи: запись | `CreateOrder`, `CreateOrdersBatch`, `UpdateOrder`, `CancelOrder` |
| Процесс | `MoveOrderToStage`, `RetryFinalAction` |
| Дрейф ревизии | `CheckDrift`, `AcceptDrift` |
| Типы продаж | `ListOrderTypes`, `GetOrderType`, `CreateOrderType`, `UpdateOrderType`, `DeleteOrderType`, `RestoreOrderType` |
| Документы | `ResolveDocumentVariables`, `RequestOrderDocument` |
| Межсервисное | `CountOrdersByProduct` (гейт удаления продукта), `ReassignOrders`, `CountMemberOwnedRecords`, `ReassignMemberOwnedRecords` |
| Провижининг | `ProvisionDefaults` |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).
Входящие вызовы проходят валидацию сервисного API-ключа (`src/auth-validation/`);
пользовательский JWT домен не разбирает. Исходящие read-only вызовы orders делает
в contact/company (посравнение полей для дрейфа) и в pipe (имя сделки для
переменных документа) — ключ `ORDERS_SERVICE_API_KEY`.

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP нет — см. [../docs/01-architecture.md](../docs/01-architecture.md) §1.

> `src/init-swagger.ts` остался от шаблона и поднимает `/docs`, но документировать
> там нечего: HTTP-контроллеров, кроме health и metrics, у домена нет — это
> запрещено барьером `shared/src/security/nfr-520-domain-http-surface-barrier.spec.ts`.

## События

**Публикует** через outbox → RabbitMQ (`src/outbox/`):
`crm.order.created`, `crm.order.updated`, `crm.order.cancelled`,
`crm.order.status_changed`, `crm.order.stage_changed`, `crm.order.drift_accepted`,
`crm.order.document_requested`, `crm.order.final_action_requested`,
`crm.order_type.created`, `crm.order_type.updated`, `crm.order_type.deleted`,
`crm.order_type.restored`.

**Потребляет** (`src/messaging/` + `src/orders/*.consumer.ts`):

| Consumer | Ключи | Что делает |
| --- | --- | --- |
| `deal-won` | `crm.deal.won` | порождает продажу из выигранной сделки |
| `final-action-result` | `crm.order.final_action_succeeded`, `crm.order.final_action_failed` | закрывает сагу финального действия: `SENDING` → `DONE` либо `SEND_ERROR` |
| `source-drift` | `crm.contact.updated`, `crm.contact.deleted`, `crm.company.updated`, `crm.company.deleted` | помечает расхождение снимка источника |
| `contact-merged` | `crm.contact.merged` | переводит ссылки продаж на мастер-контакт |
| `company-merged` | `crm.company.merged` | то же для компаний |
| `member-offboarded` | `control.member.offboarded` | переназначает продажи уходящего участника |
| `project-purge` | `control.project.purged` | удаляет данные проекта из четырёх коллекций домена |

**Сага финального действия.** Orders публикует `crm.order.final_action_requested`,
домен automation исполняет спецификацию и отвечает `…succeeded`/`…failed`.
Потерянная нога саги закрывается сторожем `SendingWatchdogService`: продажа,
застрявшая в `SENDING` дольше бюджета, переводится в `SEND_ERROR` с читаемой
причиной, откуда её пересылает `RetryFinalAction`. Инвариант «`SENDING` всегда
разрешается» держится именно им.

Очереди именуются через `busQueueName` (`<BUS_NAMESPACE>.orders.<consumer>`), у
каждой — ограниченные ретраи и терминальная DLQ (`shared/src/consumer-dlq.ts`).

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run start:infra          # в т.ч. Mongo и RabbitMQ
npm run start:orders:dev     # HTTP 3010, gRPC 5006
```

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `PORT` / `GRPC_ORDERS_PORT` | HTTP 3010 / gRPC 5006 |
| `MONGODB_URI` | MongoDB |
| `AUTH_GRPC_URL` | валидация сервисного ключа |
| `CONTROL_GRPC_URL` | догрузка отложенного scope видимости на стороне домена |
| `CONTACT_GRPC_URL`, `COMPANY_GRPC_URL`, `PIPE_GRPC_URL` | read-only источники для дрейфа и переменных документа |
| `ORDERS_SERVICE_API_KEY` | s2s-ключ orders → contact/company (fallback — `GATEWAY_SERVICE_API_KEY`) |
| `ORDERS_SOURCE_READ_TIMEOUT_MS` | таймаут чтения источников |
| `GATEWAY_KEY_CACHE_TTL_MS` | TTL кэша валидации сервисного ключа |
| `RABBITMQ_URL` | шина (outbox-relay и consumer'ы) |
| `PROJECT_PURGE_CONSUMERS_ENABLED` | выключатель consumer'а purge |

Сторож `SENDING` настраивается `ORDERS_SENDING_WATCHDOG_ENABLED`,
`ORDERS_SENDING_STALE_MS`, `ORDERS_SENDING_SWEEP_INTERVAL_MS`.

Проверки:

```bash
npm run check:orders             # из корня
cd orders && npx jest drift      # один набор тестов
```

## Тесты

45 spec-файлов (`src/**/*.spec.ts`).

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `orders/` | 29 | CRUD продажи и списки, канбан и тип по умолчанию, батч-создание, типы продаж и валидатор их спецификации, дрейф (флаг, видимость, чтение источника), запрос документа и переменные, сага финального действия и сторож `SENDING`, слияние контактов/компаний, офбординг участника, purge проекта, доменные метрики, ABAC-доступ, интеграционный сценарий |
| `outbox/` + `messaging/` | 4 | store, relay, публикатор, consumer с ретраями и DLQ |
| инфраструктура | 12 | конфиг и `configuration`, health/readiness, метрики, Mongo-сервис и индексы, идемпотентность, валидация сервисного ключа и inbound-guard, feature-toggle, request-context |

Барьер NFR-510 (у каждого CRM-домена обязана быть регрессия на изоляцию по
`projectId`) домен закрывает файлами `orders/project-purge.consumer.spec.ts` и
`orders/orders.service.integration.spec.ts` — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».
