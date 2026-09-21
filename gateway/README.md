# Gateway

Единственная публичная точка входа платформы. Принимает HTTP от клиента
(REST под `/api/...`, JWT в `Authorization: Bearer`), проверяет подпись токена,
вычисляет членство в проекте, роли, эффективные права, включённые модули и
границу видимости записей — и транслирует запрос в gRPC-вызовы доменов, подписав
исходящую метадату сервисным API-ключом. Собственной бизнес-логики у gateway нет:
он владеет авторизацией на кромке и склейкой ответов нескольких доменов в один
BFF-ответ.

gRPC-сервер gateway не поднимает — он только клиент.

## Что хранит

Своих доменных данных у gateway нет. Состояние живёт в доменах, а на кромке
используются:

- **PostgreSQL**, схема `gateway` (Prisma 7 + `@prisma/adapter-pg`, миграции —
  `prisma/migrations/`). В рантайме подключение задействовано в `/readyz`
  (`SELECT 1`) и таблицей `User`, которую читает локальный `AuthService`
  (`LocalStrategy`). Боевой вход `POST /api/auth/login` идёт **не** сюда, а в
  домен auth по gRPC; остальные таблицы схемы (`Role`, `Permission`, `Group`,
  `EntityChangeLog`, связки) кодом сервиса не читаются — наследие шаблона.
- **Redis** — pub/sub для SSE/WebSocket-фанаута уведомлений и чата
  (`src/bff/redis-pubsub.service.ts`).
- **S3/MinIO** — загрузки, которые проходят через кромку: аватары
  (`S3_AVATARS_BUCKET`), файлы документов, вложения чата, логотип системы.
- **Кэши в памяти** — решение о доступе (`GATEWAY_ACCESS_CACHE_TTL_MS`),
  оверлей module-policy (`GATEWAY_POLICY_CACHE_TTL_MS`), проекция прав.

## HTTP — публичная поверхность

Глобальный префикс `api`, URI-версионирование с дефолтом `v1`
(`src/application.ts`), то есть большинство маршрутов — `/api/v1/...`.
Из префикса исключены `healthz`, `readyz`, `status`, `metrics`, `docs`.

| Контроллер | Маршрутов | Что отдаёт |
| --- | --- | --- |
| `bff/crm-bff.controller.ts` | 130 | CRM-поверхность: `deals`, `orders`, `order-types`, `pipelines`, `deal-sources`, `lost-reasons`, `products`, `activities`, `documents`, `document-templates`, `document-variables`, `reports`, `automation` |
| `bff/v1-data-bff.controller.ts` | 122 | `projects` (настройки, модули, участники, роли), `system` (орг-структура), `companies`, `contacts`, `access-units`, `departments`, приглашения |
| `bff/roles-bff.controller.ts` | 23 | роли, назначения, гранты, каталог прав, батч-проверки, сводка видимости, аудит |
| `bff/chat-bff.controller.ts` | 22 | беседы, сообщения, вложения, `stream` (SSE), непрочитанное |
| `bff/common-bff.controller.ts` | 20 | общее по проекту: поиск, уведомления, предпочтения, шаблоны проектов, настройки модулей, восстановление пароля |
| `auth/*.controller.ts` | 30 | вход и регистрация, 2FA, сессии, профиль и `auth/me`, OIDC-провайдеры, OAuth Yandex, публичные профили |
| `bff/system-auth-bff.controller.ts` | 5 | системные сервисные ключи и OIDC-провайдеры инстанса |
| `bff/policies-bff.controller.ts` | 3 | чтение, правка и валидация политик проекта |
| `bff/statistics-bff.controller.ts` | 3 | `dashboard`, `statistics`, `statistics/export` |
| `bff/public-api.controller.ts` | 2 | публичное read-only API проекта за ключом `ffk_…` (`ProjectApiKeyGuard`) |
| `boxed/*.controller.ts` | 2 | `public-config` и первичный `bootstrap` инстанса |
| `users/users.controller.ts` | 1 | список пользователей, только для системной роли с `manage` |

Дополнительно: WebSocket-терминатор чата на сыром Fastify
(`bff/chat-ws.gateway.ts`); если `@fastify/websocket` недоступен, клиенты
деградируют на SSE. Swagger UI — `/docs` (отключается `BOX_INTEGRATION=1`).
Эксплуатационный контракт — `GET /healthz`, `/readyz`, `/status`, `/metrics`
(см. [../docs/01-architecture.md](../docs/01-architecture.md)).

### Порядок проверок на маршруте

1. `JwtOrPublicGuard` — глобальный: подпись JWT + deny-list сессий
   (`AUTH_SESSION_DENYLIST`), маршруты с `@Public()` пропускаются.
2. `GatewayModuleGuard` / `@RequireModule` — модуль выключен в проекте →
   `403 MODULE_DISABLED` до всякой проверки ролей.
3. `ProjectAccessGuard` — членство, проектная роль, пара «предмет : действие»
   из `@RequirePermission`, компиляция предиката видимости.
4. `SystemOrgContextGuard` + `SystemAccessGuard` — системная (орг) ось ролей.

Модель целиком — [../docs/03-access-model.md](../docs/03-access-model.md).

## gRPC — исходящие вызовы

Клиенты регистрируются **не вручную**: реестр генерируется из манифестов модулей
плюс явный список инфраструктурных дескрипторов
(`listGatewayGrpcClients` в `@fairflow/shared`, `shared/src/gateway-grpc-clients.ts`),
а `src/bff/grpc-bff.module.ts` лишь разворачивает его в `ClientsModule`.
Добавление домена = манифест модуля, правки в gateway не требуются;
некорректный дескриптор пропускается с предупреждением, остальные регистрируются.

Адреса — переменные `*_GRPC_URL` из `.env.example` (auth 5001, control 5002,
contact 5003, company 5004, pipe 5005, orders 5006, product 5007, activity 5008,
documents 5010, reports 5011, automation 5012, search 5013, audit 5014,
notification 5015, billing 5016, chat 5017).

Исходящая метадата собирается **только** через `GatewayOutboundMetadataService`
(`src/bff/gateway-outbound-metadata.service.ts`) — вручную её не формируют.
Ключи и их смысл — [../docs/02-grpc-model.md](../docs/02-grpc-model.md) §2.

## События

Gateway публикует best-effort факты безопасности прямо в topic-exchange
(`src/events/gateway-events.service.ts`): `gateway.auth.login`,
`gateway.auth.logout`, `gateway.auth.login_failed`. Outbox у кромки нет:
эти факты не должны блокировать ответ клиенту. Потребителей шины gateway не держит.

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run seed:all              # миграции + сиды; выдаёт ключ и id ключа для gateway
npm run start:gateway:dev     # HTTP 3000 — запускать ПОСЛЕДНИМ
```

Gateway зависит от gRPC остальных доменов, поэтому поднимается после них.

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `PORT` | HTTP, по умолчанию 3000 |
| `DATABASE_URL` | PostgreSQL (схема `gateway`) |
| `JWT_SECRET`, `JWT_EXPIRE` | проверка токена; секрет обязан совпадать с тем, чем подписывает auth |
| `GATEWAY_SERVICE_API_KEY`, `GATEWAY_API_KEY_ID` | сервисный ключ `ak_…` для вызовов доменов; берутся после сида |
| `AUTH_SESSION_DENYLIST` | PEP отозванных сессий (по умолчанию включён) |
| `*_GRPC_URL` | адреса доменов |
| `GATEWAY_PROJECT_ACCESS_ENFORCE` | принудительный PEP членства/роли; при `false` сервис не стартует |
| `GATEWAY_ACCESS_CACHE_TTL_MS`, `GATEWAY_POLICY_CACHE_TTL_MS` | TTL кэшей решения о доступе и политик модулей |
| `S3_*` | эндпоинт и бакет для аватаров |
| `ORDERS_EXPORT_*` | бюджет и лимиты одновременных выгрузок продаж |
| `TRUST_PROXY` | доверять `X-Forwarded-For`; обязательно `true` за reverse-proxy |
| `CORS_ORIGIN`, `CORS_CREDENTIALS`, `LOG_LEVEL` | прочее |

Проверки:

```bash
cd gateway && npm run check            # tsc --noEmit + eslint + jest
cd gateway && npx jest project-access  # один набор тестов
```

Готовая коллекция запросов к кромке — [../postman/README.md](../postman/README.md).

## Тесты

144 spec-файла (`src/**/*.spec.ts`) — самый покрытый workspace репозитория,
потому что вся авторизация клиента живёт здесь.

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `bff/` | 80 | контракты BFF-маршрутов по доменам (CRM, проекты, компании/контакты, роли, политики, статистика, чат), сборка исходящей метадаты, инвентаризация маршрутов и их прав, лимиты (поиск, чат, публичный auth), бюджет выгрузок, хранилища S3, PII-egress |
| `guards/` | 24 | `ProjectAccessGuard` (членство, кэш, оверлеи, cross-entity, шаринг, экспорт), `GatewayModuleGuard`, системный доступ и орг-контекст, компиляция предиката видимости, паритет прав |
| `auth/` | 21 | вход и 2FA, сброс пароля, сессии и deny-list, профиль и его видимость, OIDC/OAuth, троттлинг публичных маршрутов, аватары |
| остальное | 19 | health/readiness, метрики, Prisma, конфиг, `AppErrorFilter`, публикация `gateway.auth.*`, boxed-маршруты, сквозные box-сценарии |
