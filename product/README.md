# Product

Каталог продуктов проекта: карточка продукта, категории, цены, архив и корзина,
а также счётчики использования — сколько сделок и продаж ссылается на продукт.
Здесь же живёт ключевая связь доменной модели: продукт знает, **по какому типу
продажи** он продаётся (ссылка идёт от продукта к типу, а не наоборот —
[../docs/04-domain-model.md](../docs/04-domain-model.md) §3). Наружу отдаёт
только gRPC (`fairflow.product.v1`, порт 5007).

## Что хранит

**MongoDB**:

| Коллекция | Что лежит |
| --- | --- |
| `crm_products` | карточки продуктов: категория, цена и валюта, статус, владелец и подразделение, ссылка на тип продажи и флаг «тип оборван» |
| `crm_product_usage_processed` | журнал обработанных событий счётчиков — дедуп по ключу конверта, чтобы at-least-once-шина не насчитала лишнего |
| `idempotency_keys` | журнал идемпотентности мутаций (TTL) |
| `crm_event_outbox` | transactional outbox исходящих событий (TTL на опубликованные) |

Индексы ведут `projectId`: `{ projectId, updatedAt }` под список,
`{ projectId, status }` под фильтр статуса и счётчики
(`src/mongo/mongo.service.ts`). Требование барьера NFR-550 — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».

Отдельно: `crm_deals` и `crm_orders` домен открывает **только на чтение** —
для разбивки использования по подразделениям и владельцам в `GetProductUsage`.
Владельцы этих коллекций — pipe и orders; записи туда product не делает.

## gRPC-API

Пакет `fairflow.product.v1`, контракт — [`proto/fairflow/product/v1/product.proto`](../proto/fairflow/product/v1/product.proto),
реализация — `src/product/product.grpc.controller.ts`. Один сервис `ProductGrpc`,
10 методов.

| Метод | Назначение |
| --- | --- |
| `ListProducts`, `GetProduct` | список с фильтрами и карточка |
| `CreateProduct`, `UpdateProduct` | создание и правка |
| `ArchiveProduct`, `RestoreProduct`, `DeleteProduct` | архив, восстановление, удаление (с гейтом по использованию) |
| `ListCategories` | категории проекта; считаются `distinct` по тому же scoped-фильтру, что и список, — категория с невидимых записей не всплывает |
| `GetProductUsage` | использование продукта: счётчики и разбивка по подразделениям и владельцам |
| `RecountProductUsage` | сверка счётчиков с источником истины через `pipe.CountDealsByProduct` и `orders.CountOrdersByProduct` |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).
Входящие вызовы проходят валидацию сервисного API-ключа (`src/auth-validation/`);
пользовательский JWT домен не разбирает. Исходящие вызовы: в pipe и orders
(пересчёт использования) и в control (`src/control/` — валидация подразделения
и настройки модуля проекта).

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP нет — см. [../docs/01-architecture.md](../docs/01-architecture.md) §1.

## События

**Публикует** через outbox → RabbitMQ (`src/outbox/`):
`crm.product.created`, `crm.product.updated`, `crm.product.deleted`,
`crm.product.archived`, `crm.product.restored`, `crm.product.price_changed`,
`crm.product.order_type_changed`, `crm.product.order_type_dangling`.

**Потребляет**:

| Consumer | Ключи | Что делает |
| --- | --- | --- |
| `usage.listener` (`src/usage/`) | `crm.deal.product_linked`, `crm.deal.product_unlinked`, `crm.deal.won`, `crm.deal.lost`, `crm.deal.reopened`, `crm.order.created`, `crm.order.cancelled`, `crm.order_type.deleted`, `crm.order_type.restored` | инкрементально ведёт `dealsCount` / `activeDealsCount` / `ordersCount` и флаг «тип продажи оборван»; идемпотентен по ключу конверта через `crm_product_usage_processed` |
| `project-purge` | `control.project.purged` | удаляет данные проекта из `crm_products` и `crm_product_usage_processed` |

Две детали, важные при правках:

- декремент по продажам — это **отмена** (`crm.order.cancelled`), а не удаление:
  жёсткого удаления продажи в orders нет, а авторитетный `countOrdersByProduct`
  считает `status != CANCELLED`, поэтому именно отмена сводит инкрементальный
  счётчик с пересчётом;
- `crm.order_type.archived` объявлен в реестре ключей, но никем не публикуется,
  и поэтому намеренно **не** подписан — подписка на фантомный ключ здесь считается
  дефектом.

Очередь — `<BUS_NAMESPACE>.product.usage` с терминальной DLQ
(`shared/src/consumer-dlq.ts`). Выключатель — `PRODUCT_USAGE_LISTENER_ENABLED=false`.

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run start:infra           # в т.ч. Mongo и RabbitMQ
npm run start:product:dev     # HTTP 3007, gRPC 5007
```

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `HTTP_PORT` / `GRPC_PRODUCT_PORT` | HTTP 3007 / gRPC 5007 |
| `MONGODB_URI` | MongoDB |
| `AUTH_GRPC_URL` | валидация сервисного ключа |
| `CONTROL_GRPC_URL` | догрузка отложенного scope видимости, валидация подразделения, настройки модуля |
| `RABBITMQ_URL` | шина (outbox-relay и usage-listener) |
| `PROJECT_PURGE_CONSUMERS_ENABLED` | выключатель consumer'а purge |

Проверки:

```bash
npm run check:product            # из корня
cd product && npx jest usage     # один набор тестов
```

Разовые скрипты: `npm run db:backfill:legacy` и `…:check` (`scripts/backfill-legacy-fields.ts`).

## Тесты

32 spec-файла (`src/**/*.spec.ts`).

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `product/` | 11 | контроллер `ProductGrpc` и роли на нём, список и фильтры, валюта по умолчанию, гейт удаления, флаг оборванного типа продажи, счётчик активных сделок, владелец и подразделение, разбивка использования, ABAC-фильтр чтения, prefill-структуры |
| `usage/` | 5 | listener счётчиков и его идемпотентность, сервис использования, кросс-доменный подсчёт, consumer шины, purge проекта |
| `control/` | 2 | валидатор подразделения, настройки модуля проекта |
| `outbox/` | 3 | store, relay, публикатор |
| инфраструктура | 11 | конфиг, health/readiness, метрики и интерцептор, Mongo-сервис и индексы, идемпотентность, валидация сервисного ключа и inbound-guard, request-context |

Барьер NFR-510 (у каждого CRM-домена обязана быть регрессия на изоляцию по
`projectId`) домен закрывает файлами `usage/project-purge.consumer.spec.ts` и
`product/product.abac.spec.ts` — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».
