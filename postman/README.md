# Fairflow — Postman

Готовые артефакты для работы с API gateway из Postman.

| Файл | Что это |
| --- | --- |
| `fairflow-gateway.postman_collection.json` | Коллекция: весь публичный gateway — REST (`/api`), 18 папок / 96 запросов |
| `fairflow.postman_environment.json` | Environment: `baseUrl`, `token`, `projectId`, метадата + хосты gRPC-доменов |
| `generate.mjs` | Генератор обоих файлов (источник правды — `gateway/src/**/*.controller.ts`). Перегенерация: `node postman/generate.mjs` |

> **Почему gRPC-домены не лежат в коллекции.** Postman хранит gRPC service definition (`.proto`) **отдельно** от коллекции (workspace-level protobuf API / reflection) и надёжно импортировать gRPC-запросы из JSON-коллекции не умеет ([postman#11775](https://github.com/postmanlabs/postman-app-support/issues/11775)). Поэтому gateway идёт готовой коллекцией, а gRPC подключается за 2 минуты из `.proto` (файлы уже есть в `proto/`) — см. раздел ниже. Хосты/порты/метадата для них уже в Environment.

---

## 1. Импорт

1. Postman → **Import** → перетащи оба `*.json` файла.
2. Справа вверху выбери импортированный Environment.
3. Выставь `baseUrl` под свой контур. По умолчанию это локальный gateway
   (`http://localhost:3000`) — см. [DEV-LOCAL.md](../DEV-LOCAL.md).

## 2. REST — как пользоваться

1. Папка **Auth → Login**: подставь `email`/`login` + `password`, отправь. Тест-скрипт сам кладёт JWT в `{{token}}` и `userId` в `{{userId}}`. Дальше Bearer подставляется во все запросы автоматически (auth коллекции = `Bearer {{token}}`).
2. Создай/возьми проект: **Organizations & Projects → List/Create project**, скопируй его id в переменную `{{projectId}}` (большинство CRM-запросов требуют `projectId`). NB: после сида `/projects` пуст — проект создаётся в UI или через `Create project`.
3. Дальше любые папки: Contacts, Companies, Deals, Orders, Activities, Products, Documents, Reports, Automation, Notifications, Search, Audit, Billing.

Заметки:

- `projectId` передаётся как `?projectId=` (GET/PUT/DELETE) или в теле (POST). В каждом project-scoped запросе есть выключенный заголовок `x-project-id` — альтернатива query, включи при желании.
- Многие CRM-роуты требуют **включённого модуля** в проекте (`deals`/`orders`/`contacts`/…), иначе `403 MODULE_DISABLED`. Модули включаются в `Create/Update project` (`modules: [...]`).
- **Ops / Health** (`/healthz`, `/readyz`, `/status`, `/metrics`) обслуживаются самим gateway и в проде могут не роутиться через ingress приложения. Поэтому эта папка бьёт на gateway напрямую через `{{opsBase}}`.
- Версионирование: auth/users/CRM/data — под `/api/v1/...`; notification/search/audit/billing/forgot/reset — `VERSION_NEUTRAL` (`/api/...`). В коллекции уже учтено.

---

## 3. gRPC-домены

Все домены слушают **plaintext gRPC**. Реальные методы — в `.proto`:

| Сервис | Порт | proto-файл | package | gRPC services |
| --- | --- | --- | --- | --- |
| auth | 5001 | `proto/fairflow/auth/v1/auth.proto` | `fairflow.auth.v1` | `AuthGrpc`, `ApiKeyGrpc`, `OidcGrpc`, `UserDirectoryGrpc` |
| control | 5002 | `proto/fairflow/control/v1/control.proto` | `fairflow.control.v1` | `ProjectGrpc`, `OrganizationGrpc`, `RoleGrpc`, `AccessUnitGrpc`, `ModuleLifecycleControlGrpc`, `IntegrationGrpc` |
| contact | 5003 | `proto/fairflow/contact/v1/contact.proto` | `fairflow.contact.v1` | `ContactGrpc` |
| company | 5004 | `proto/fairflow/company/v1/company.proto` | `fairflow.company.v1` | `CompanyGrpc` |
| pipe | 5005 | `proto/fairflow/pipe/v1/pipe.proto` | `fairflow.pipe.v1` | `PipeGrpc` |
| orders | 5006 | `proto/fairflow/orders/v1/orders.proto` | `fairflow.orders.v1` | `OrdersGrpc` |
| product | 5007 | `proto/fairflow/product/v1/product.proto` | `fairflow.product.v1` | `ProductGrpc` |
| activity | 5008 | `proto/fairflow/activity/v1/activity.proto` | `fairflow.activity.v1` | `ActivityGrpc` |
| documents | 5010 | `proto/fairflow/documents/v1/documents.proto` | `fairflow.documents.v1` | `DocumentsGrpc` |
| reports | 5011 | `proto/fairflow/reports/v1/reports.proto` | `fairflow.reports.v1` | `ReportsGrpc` |
| automation | 5012 | `proto/fairflow/automation/v1/automation.proto` | `fairflow.automation.v1` | `AutomationGrpc` |
| search | 5013 | `proto/fairflow/search/v1/search.proto` | `fairflow.search.v1` | `SearchGrpc` |
| audit | 5014 | `proto/fairflow/audit/v1/audit.proto` | `fairflow.audit.v1` | `AuditGrpc` |
| notification | 5015 | `proto/fairflow/notification/v1/notification.proto` | `fairflow.notification.v1` | `NotificationGrpc` |
| billing | 5016 | `proto/fairflow/billing/v1/billing.proto` | `fairflow.billing.v1` | `BillingGrpc` |
| chat | 5017 | `proto/fairflow/chat/v1/chat.proto` | `fairflow.chat.v1` | `ChatService` |

### 3.1. Подключить proto в Postman (один раз)

1. Новый запрос → тип **gRPC**.
2. **Service definition → Import a .proto file** → выбери нужный из таблицы.
   **Import path** укажи `…/proto` (там лежит `fairflow/…` и резолвятся well-known типы вроде `google/protobuf/struct.proto`).
3. Удобно сохранить proto в Postman working directory, чтобы переиспользовать.

> Если на сервисе включить **server reflection** (`GRPC_REFLECTION_ENABLED=true`) — Postman подтянет методы сам, без `.proto`. Флаг помечен dev-only и в проде выключен, так что по умолчанию используем `.proto`.

### 3.2. Куда подключаться (host:port)

Переменные `{{grpc_auth}}`…`{{grpc_billing}}` уже в Environment и по умолчанию
указывают на `127.0.0.1:50xx`. В gRPC-запросе **TLS выкл** (plaintext).

- **Локально:** сервис, поднятый через `npm run start:<svc>:dev`, слушает свой порт из таблицы — менять ничего не нужно.
- **В кластере:** пробрось порт до нужного сервиса (`kubectl port-forward -n <ns> svc/auth 5001:5001`) либо впиши в `grpc_<svc>` адрес, доступный с твоей машины.

### 3.3. Метадата (обязательно для вызова доменов)

Домены валидируют **service-API-key** (end-user JWT они не парсят). В gRPC-запросе → вкладка **Metadata** добавь:

| Ключ | Значение | Когда |
| --- | --- | --- |
| `x-service-api-key` | `{{svc_api_key}}` | всегда |
| `x-gateway-api-key-id` | `{{gw_api_key_id}}` | всегда |
| `x-request-id` | `{{request_id}}` | всегда |
| `traceparent` **или** `x-trace-id` | любой валидный идентификатор | всегда |
| `x-gateway-issued-at` | текущий момент | всегда |
| `x-user-id` | `{{userId}}` | обязателен при `x-actor-type: user` |
| `x-actor-type` | `user` / `service` | когда вызов от имени пользователя |
| `x-project-id` | `{{projectId}}` | для project-scoped вызовов |

> Первые пять — не формальность. `validatePropagatedGatewayMetadata`
> (`shared/src/grpc/inbound-metadata.ts`) отвергает вызов с `UNAUTHENTICATED`,
> если нет `x-request-id`, трассировки (`traceparent` либо `x-trace-id`) или
> `x-gateway-issued-at` — даже с корректным сервисным ключом.

Значения `svc_api_key` / `gw_api_key_id` — это секреты твоего контура, в репозиторий они не коммитятся:

- `svc_api_key` = `GATEWAY_SERVICE_API_KEY` из окружения gateway (формат `ak_…`; при локальном сиде берётся из `SEED_GATEWAY_SERVICE_API_KEY`).
- `gw_api_key_id` = `GATEWAY_API_KEY_ID`, выдаётся при сиде.

---

## Перегенерация

```bash
node postman/generate.mjs
```

Источник правды — контроллеры gateway (`gateway/src/**/*.controller.ts`).
После изменения публичного API прогони генератор и закоммить оба `*.json`.
