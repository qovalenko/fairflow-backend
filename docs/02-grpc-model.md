# Модель gRPC-взаимодействия

Всё межсервисное общение в Fairflow — gRPC. HTTP остаётся только на кромке
(клиент → gateway) и для эксплуатационных маршрутов. Этот документ описывает
контракт такого вызова целиком: транспорт, метадату, аутентификацию и ошибки.

## 1. Контракты

Proto-файлы лежат в [`proto/`](../proto) и организованы как
`proto/fairflow/<domain>/v1/<domain>.proto`, package — `fairflow.<domain>.v1`.

| Сервис | Порт | proto | gRPC services |
| --- | --- | --- | --- |
| auth | 5001 | `fairflow/auth/v1/auth.proto` | `AuthGrpc`, `ApiKeyGrpc`, `OidcGrpc`, `UserDirectoryGrpc` |
| control | 5002 | `fairflow/control/v1/control.proto` | `ProjectGrpc`, `OrganizationGrpc`, `RoleGrpc`, `AccessUnitGrpc`, `ModuleLifecycleControlGrpc`, `IntegrationGrpc` |
| contact | 5003 | `fairflow/contact/v1/contact.proto` | `ContactGrpc` |
| company | 5004 | `fairflow/company/v1/company.proto` | `CompanyGrpc` |
| pipe | 5005 | `fairflow/pipe/v1/pipe.proto` | `PipeGrpc` |
| orders | 5006 | `fairflow/orders/v1/orders.proto` | `OrdersGrpc` |
| product | 5007 | `fairflow/product/v1/product.proto` | `ProductGrpc` |
| activity | 5008 | `fairflow/activity/v1/activity.proto` | `ActivityGrpc` |
| documents | 5010 | `fairflow/documents/v1/documents.proto` | `DocumentsGrpc` |
| reports | 5011 | `fairflow/reports/v1/reports.proto` | `ReportsGrpc` |
| automation | 5012 | `fairflow/automation/v1/automation.proto` | `AutomationGrpc` |
| search | 5013 | `fairflow/search/v1/search.proto` | `SearchGrpc` |
| audit | 5014 | `fairflow/audit/v1/audit.proto` | `AuditGrpc` |
| notification | 5015 | `fairflow/notification/v1/notification.proto` | `NotificationGrpc` |
| billing | 5016 | `fairflow/billing/v1/billing.proto` | `BillingGrpc` |
| chat | 5017 | `fairflow/chat/v1/chat.proto` | `ChatService` |

Общие типы — `fairflow/common/v1/common.proto`. Соединение внутри контура
plaintext: TLS терминируется на кромке, между сервисами шифрования нет.

Server reflection закрыт флагом `GRPC_REFLECTION_ENABLED` и включается только
в разработке — в проде метод вызывают по `.proto`.

## 2. Метадата: единственный источник правды

Все ключи `x-*`, которыми gateway передаёт контекст домену, объявлены в одном
месте — `shared/src/grpc/metadata-keys.ts` (`GW_METADATA`). Новый ключ
добавляется только туда и читается через общие inbound/outbound-хелперы;
строковых литералов в коде доменов быть не должно.

| Ключ | Смысл |
| --- | --- |
| `x-request-id` | сквозной id запроса; эхо клиентского заголовка, если он был |
| `x-trace-id`, `traceparent` | трассировка |
| `x-gw-call-id` | id **одного** gateway→домен вызова |
| `x-user-id` | субъект |
| `x-actor-type` | тип актора |
| `x-org-id`, `x-organization-id` | организационная граница |
| `x-workspace-id` | граница личного пространства (режим без организации) |
| `x-project-id` | проект, в котором выполняется операция |
| `x-roles`, `x-permissions` | разрешённые роли и права, вычисленные на gateway |
| `x-session-id` | сессия |
| `x-gateway-issued-at` | момент выпуска метадаты |
| `x-gateway-api-key-id` | id сервисного ключа |
| `x-service-api-key` | сам сервисный ключ |
| `x-enabled-modules`, `x-module-policy-snapshot` | включённые модули проекта |
| `x-visibility-scope`, `x-access-predicate` | ограничение видимости записей |
| `idempotency-key` | клиентский ключ идемпотентности |
| `x-error-details-bin` | структурированные ошибки домен → gateway |

### Почему `x-gw-call-id` — отдельный ключ

Он выглядит избыточным рядом с `x-request-id` и `idempotency-key`, но решает
задачу, которую те решить не могут.

- `x-request-id` **эхается** из клиентского заголовка. Клиент вправе прислать
  один и тот же `X-Request-Id` на два осмысленно разных действия.
- `idempotency-key` по определению задаёт клиент.
- `x-gw-call-id` генерируется `randomUUID()` при сборке исходящей метадаты и
  закрепить его извне нельзя.

Поэтому именно он служит дедуп-ключом фактов аудита и outbox: транспортный
retry переиспользует ту же метадату (один call-id → один факт), а два
намеренных пользовательских действия дают два факта даже при фиксированном
`X-Request-Id` от клиента. Читать клиентский заголовок в этот ключ нельзя.

## 3. Два слоя авторизации

Ключевой инвариант: **доменные сервисы не разбирают пользовательский JWT**.

### Слой 1: клиент → gateway

`Authorization: Bearer <JWT>`. Подпись проверяется на gateway; `JWT_SECRET`
обязан совпадать с тем, которым auth подписывает токены. Здесь же gateway
вычисляет роли, права, включённые модули и границы видимости — и кладёт
результат в метадату исходящего вызова.

### Слой 2: gateway → домен

Сервисный API-ключ в gRPC-метадате: `x-service-api-key` (формат `ak_…`) плюс
`x-gateway-api-key-id`. Домен валидирует ключ вызовом
`ApiKeyGrpc.ValidateServiceApiKey` в auth.

Валидация закэширована (`GatewayApiKeyValidationService`), и правила кэша
подобраны так, чтобы недоступность auth не превращалась ни в дыру, ни в
полную остановку:

- **успешный ответ** auth — это решение, он кэшируется (и положительный, и
  отрицательный) на `GATEWAY_KEY_CACHE_TTL_MS` (по умолчанию 60 000 мс);
- **транспортный сбой** (auth недоступен, таймаут, `UNAVAILABLE`) решением не
  является и как отрицательный вердикт не кэшируется;
- при недоступности auth вызов проходит, только если есть свежее
  положительное решение в кэше; иначе — `UNAUTHENTICATED`;
- кэш ограничен по размеру (LRU) и вычищает протухшие записи.

Отсутствие ключа — сразу `UNAUTHENTICATED`, до всякой бизнес-логики.

## 4. Ошибки

Домен бросает `RpcException` с кодом gRPC; gateway разворачивает его в HTTP
(`shared/src/grpc/grpc-to-http.ts`):

| gRPC | HTTP |
| --- | --- |
| `OK` | 200 |
| `INVALID_ARGUMENT`, `OUT_OF_RANGE` | 400 |
| `UNAUTHENTICATED` | 401 |
| `PERMISSION_DENIED` | 403 |
| `NOT_FOUND` | 404 |
| `ALREADY_EXISTS`, `ABORTED` | 409 |
| `FAILED_PRECONDITION` | 422 |
| `RESOURCE_EXHAUSTED` | 429 |
| `CANCELLED` | 499 |
| `UNIMPLEMENTED` | 501 |
| `UNAVAILABLE` | 503 |
| `DEADLINE_EXCEEDED` | 504 |
| остальное | 500 |

Структурированные ошибки валидации не кодируются в текст статуса: они едут
trailing-метадатой `x-error-details-bin` как JSON `{ code, violations|errors }`
и доезжают до клиента первоклассными `details`.

## 5. Как подключить новый домен к gateway

1. Описать контракт в `proto/fairflow/<domain>/v1/`.
2. Описать домен в манифесте модуля: реестр gRPC-клиентов gateway строится из
   манифестов через `listGatewayGrpcClients`, а не прописывается вручную.
3. Написать BFF-контроллер, который собирает исходящую метадату через
   `GatewayOutboundMetadataService` — вручную метадату не формируют.
4. На стороне домена повесить валидацию сервисного ключа на входящие вызовы и
   читать контекст через inbound-хелперы, а не из тела запроса.

Значения вроде `x-organization-id` и `x-workspace-id` домен обязан брать
**только из метадаты**: их выставляет gateway после разрешения членства, и
доверять этим полям в теле запроса нельзя.
