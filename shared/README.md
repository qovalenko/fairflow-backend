# @fairflow/shared

Фундамент монорепо. Здесь лежат контракты, которые обязаны быть **одинаковыми во
всех сервисах**: ключи gRPC-метадаты, маппинг ошибок, ролевая модель и каталог
прав, реестр модулей, ops-контракт HTTP, топология шины событий, идемпотентность.
От пакета зависят все остальные workspace'ы, поэтому он собирается первым:

```bash
npm run build:shared     # из корня; tsc → shared/dist
```

Пакет намеренно нейтрален к хранилищу и транспорту: он описывает *правила*, а
реализацию (Prisma, Mongo, amqplib, Nest) подключают сервисы. Публичная
поверхность — `src/index.ts`.

Как эти контракты складываются в систему — [../docs/01-architecture.md](../docs/01-architecture.md),
[../docs/02-grpc-model.md](../docs/02-grpc-model.md),
[../docs/03-access-model.md](../docs/03-access-model.md).

## Ключевые области

### `grpc/` — межсервисный вызов целиком

| Файл | Что в нём |
| --- | --- |
| `metadata-keys.ts` | `GW_METADATA` — **единственный источник правды** для всех ключей `x-*`, которыми gateway передаёт контекст домену |
| `outbound-metadata.ts` | сборка исходящей метадаты на gateway; `x-gw-call-id` минтится здесь через `randomUUID()` и не может быть задан клиентом |
| `inbound-metadata.ts` | чтение контекста на стороне домена: `readUserId`, `readIdempotencyKey`, резолв `projectId`. Если тело запроса несёт `projectId`, отличный от `x-project-id`, вызов отклоняется — defense-in-depth границы изоляции |
| `grpc-to-http.ts` | таблица «gRPC-статус → HTTP-код», которой gateway разворачивает доменную ошибку |
| `rpc-exception.filter.ts` | `RpcAppExceptionFilter` (доменный `AppError` → корректный gRPC-статус) и `rpcInvalidArgument`: структурированные ошибки валидации едут трейлером `x-error-details-bin`, а не JSON'ом внутри текста статуса |
| `loader-options.ts` | зафиксированные опции proto-loader (`keepCase`, `arrays`, `longs: Number`) — их расхождение молча портит данные |
| `visibility-hydration.ts`, `auth-validation-loader.ts`, `nest-grpc-reflection.ts` | догрузка scope видимости, загрузчик auth-контракта, включаемый reflection |

### Права и роли

- `rbac.ts` — две оси ролей (`PROJECT_ROLES`, `ORG_ROLES`), **закрытый словарь из
  10 действий** и матрица «роль × действие», плюс именной allow-list и denylist
  поверх матрицы.
- `permission-rbac.ts` — движок слоя RBAC: расширение системной роли в набор
  ключей, системные предметы, карта «декоратор → каталожный ключ», компиляция
  эффективного набора прав (allow ∪ / deny-оверлей, deny > allow), инварианты
  запретов и защита от самоэскалации. Fail-closed по умолчанию.
- `permission-catalog.ts` — генератор каталога `subject:action` из манифестов
  модулей. Каталог — производная, а не таблица.
- `org-rbac.ts` — та же механика для орг-структуры (`org:employees`,
  `org:departments`, … с `read`/`manage`).
- `abac/` — движок предикатов ABAC: один IR и три интерпретатора из него
  (`evalGate` для одной записи, `compileMongo` для фильтра выборки,
  `compilePostgres` — отложен и fail-closed), плюс `compose` для сборки
  `{ projectId } AND (видимость OR шаринг) AND предикат`.
- `access/group.ts`, `list-access-meta.ts` — групповой доступ и метаданные
  доступа в списковых ответах.

### Модули

- `module-registry.ts` — реестр модулей: идентификатор, блокировка, жёсткие и
  мягкие зависимости, схемы настроек и `policyCapabilities` (какие права модуль
  приносит).
- `module-manifest.ts` + `module-manifests.ts` — контракт `ModuleManifestV1` и
  реальные манифесты модулей. Из манифеста платформа выводит навигацию,
  gRPC-клиентов gateway, каталог прав, форму настроек, mount-points, события и
  наследование владения.
- `gateway-grpc-clients.ts` — генерация реестра gRPC-клиентов gateway из
  манифестов плюс явный `INFRA_GRPC_CLIENTS` (auth, control, audit). Добавление
  домена = манифест, правки в gateway не нужны; битый дескриптор пропускается с
  предупреждением.
- `module-gating.ts`, `module-readonly.ts`, `module-lifecycle.ts`,
  `module-runtime-state.ts` — эффективный набор включённых модулей,
  read-only-режим, жизненный цикл, рантайм-состояние.
- `slot-catalog.ts`, `settings-schema.ts`, `partner-manifest.ts` — каталог
  mount-points, схемы настроек, манифест партнёрского модуля.

### Эксплуатация и события

- `ops-http-contract.ts` — четыре маршрута, которые обязан отдавать **каждый**
  процесс: `GET /healthz`, `/readyz`, `/status`, `/metrics`, плюс `buildOpsStatus()`
  для единого тела `/status`.
- `bus-topology.ts` — каноническая топология RabbitMQ: `topic`-exchange
  `<BUS_NAMESPACE>.events`, `fanout`-DLX, правила объявления очередей. Все сервисы
  объявляют объекты **только** через эти хелперы: расхождение типа/аргументов даёт
  `406 PRECONDITION_FAILED` и падение на старте. `BUS_NAMESPACE` изолирует стенды
  на общем брокере.
- `consumer-dlq.ts` — контракт «ограниченные ретраи + терминальная DLQ».
  `nack(requeue=false)` без DLQ запрещён. Retry-очередь дедлеттерит в **default
  exchange** прямо в рабочую очередь: дедлеттер обратно в topic давал
  немаршрутизируемый ключ и молчаливую потерю сообщения.
- `events.ts`, `routing-keys.ts`, `outbox.ts` — конверт `EventEnvelope`,
  реестр легальных routing-key `<domain>.<entity>.<action>` и transactional
  outbox: бизнес-запись и строка outbox пишутся одной транзакцией, relay
  публикует at-least-once, потребители дедуплицируют по
  `idempotencyKey ?? messageId`.

### Прочее

- `idempotency.ts` — `withIdempotency`: дедуп самой мутации (create/merge/import)
  по клиентскому `Idempotency-Key`, поверх коллекции `idempotency_keys` домена.
  Ключ скоупится операцией, успешный результат сохраняется целиком и воспроизводится
  байт-в-байт; упавшая мутация не дедуплицируется.
- `errors.ts` + `app-error.ts` — канонический union кодов (`invalid`, `notFound`,
  `access`, `auth`, `conflict`, `locked`, `rateLimit`, `paymentRequired`,
  `internal`), класс `AppError`, отображение в HTTP-статус и форма тела ошибки;
  `app-error.filter.ts` — HTTP-фильтр.
- `guards/` — доменные PEP для gRPC: `ModuleGuard` (`@RequireModule`, читает
  `x-enabled-modules`) и `GrpcRolesGuard` (`@RequireRoles`, читает `x-roles`).
  Оба fail-closed: пустой/отсутствующий контекст = отказ.
- `session-deny.ts`, `auth-client.ts` — deny-list сессий и клиент auth.
- `document-*`, `docx-sanitize.ts`, `record-upload-validation.ts` — контекст и
  каталог переменных документов, санитайзер DOCX, валидация загрузок.
- `notification-*` — реестр событий уведомлений и их локализация.
- `tracing.ts`, `ids.ts`, `process-handlers.ts`, `platform-constants.ts`,
  `retention.ts`, `module-metrics.ts` — трассировка, генерация идентификаторов,
  обработчики процесса, константы платформы, политики хранения, метрики модулей.

## Архитектурные барьеры

`src/security/` — **не** юнит-тесты. Это fitness-функции: они не поднимают Nest и
ничего не мокают, а сканируют файловую систему репозитория (`__dirname/../../..`)
регулярками и падают, если код разъехался с архитектурным инвариантом. Из
`index.ts` этот каталог не экспортируется — он существует только как гейт CI.

Запускаются обычным `npm test -w @fairflow/shared` (или `npm run test` из корня).

### `nfr-510-crm-isolation-barrier.spec.ts` — изоляция по `projectId`

Требует, чтобы **каждый** CRM-домен из списка `contact`, `company`, `pipe`,
`orders`, `product`, `activity`, `documents`, `chat`, `automation`, `search`,
`reports` имел хотя бы один `*.spec.ts` внутри `<домен>/src`, в **тексте** которого
встречается один из маркеров:

`NFR-510`, `projectId isolation`, `project isolation`, `cross-project`,
`Different-project`, `foreign project`, `project-purge.consumer.spec`,
`filtered by { projectId }`, `scoped by { …projectId…}`.

Смысл: граница изоляции в Fairflow — это поле + фильтр, а не база-на-тенанта
([../docs/04-domain-model.md](../docs/04-domain-model.md) §1), поэтому у каждого
домена обязана быть живая регрессия на «чужой проект не читается, не пишется и не
вычищается вместе со своим».

**Как не сломать:** заводите новый CRM-домен — добавьте его в `CRM_DOMAINS` и
сразу напишите спек с таким сценарием. Переименовываете тест — сохраните
формулировку-маркер (проверка текстовая). Массовое переписывание описаний тестов
может «погасить» маркер, и барьер покраснеет там, где код не менялся.

### `nfr-550-mongo-index-barrier.spec.ts` — `projectId` первым ключом индекса

Для тех же 11 доменов барьер обходит `<домен>/src`, берёт файлы с именем,
содержащим `index`, файл `mongo.service.ts` и любые `*.store.ts`, и вытаскивает из
них литералы индексных ключей, в которых упоминается `projectId`/`project_id`
(шаблоны `key: { … }` и `createIndex({ … })`). Дальше проверяются два условия:

1. каждый найденный ключ **начинается** с `projectId: 1` (или `project_id: 1`);
2. у домена найден хотя бы один такой ключ — «ни одного индекса с `projectId`»
   тоже считается нарушением.

Смысл: если составной индекс начинается не с границы тенанта, запрос
`{ projectId, … }` перестаёт бить в префикс индекса — планировщик сканирует чужие
проекты, а не только свой. Это одновременно и производительность, и безопасность.

**Как не сломать:** пишите `{ projectId: 1, … }` буквально и первым ключом; не
собирайте индексные спецификации вычисляемыми объектами или спредом в этих файлах
— разбор текстовый и вычисленный ключ он просто не увидит; индекс без `projectId`
(например чистый TTL по `purgeAt` или уникальный `messageId`) барьер не трогает,
потому что в нём нет проектного ключа.

### `nfr-520-domain-http-surface-barrier.spec.ts` — HTTP-поверхность домена

Третий барьер того же класса: парсит контроллеры каждого сервисного workspace
(кроме gateway), оставляет только классы, реально зарегистрированные в каком-либо
`@Module({ controllers: [...] })`, и требует, чтобы домен отдавал по HTTP
**ровно** `GET /healthz`, `/readyz`, `/status`, `/metrics` — не меньше и не больше.
Любой другой HTTP-маршрут в домене обходит единственное место, где проверяется
пользовательский JWT. Вычисляемый путь (`@Get(someConst)`) считается нарушением:
барьер не может доказать, что он остался внутри ops-контракта.

## Правила расширения

- **Новый ключ `x-*` добавляется только в `grpc/metadata-keys.ts`** и читается
  через общие inbound/outbound-хелперы. Строковых литералов вида `'x-…'` в коде
  доменов быть не должно.
- **Словарь действий RBAC закрыт** — 10 глаголов, и модуль не вправе ввести
  собственный даже в своём пространстве имён. Нужна более тонкая гранулярность —
  дробится *предмет*, а не расширяется словарь: `documents.generate:execute`,
  `companies.owner:write`. Подробнее — [../docs/03-access-model.md](../docs/03-access-model.md) §1.
- Новый routing-key сначала регистрируется в `routing-keys.ts`, иначе
  `buildOutboxRow` не даст его опубликовать.
- Объекты брокера объявляются только через `bus-topology.ts` / `consumer-dlq.ts`.
- Пакет должен оставаться нейтральным: никаких импортов Prisma/Mongo/amqplib в
  логике (amqplib и Nest — опциональные peer-зависимости, используются точечно).

## Тесты

52 spec-файла (`src/**/*.spec.ts`): 40 в корне пакета, 6 в `grpc/`, 3 в
`security/`, по одному в `guards/`, `access/`, `abac/`.

Покрывают ровно то, что дороже всего сломать молча: матрицу прав и её оверлеи
(`rbac.*.spec.ts`, `permission-*.spec.ts`, `org-rbac.spec.ts`), каталог и
провенанс прав, реестр и манифесты модулей (включая mount-points и системные
виды), гейтинг и read-only модулей, сборку и разбор метадаты, маппинг ошибок,
ops-контракт, идемпотентность, реестр routing-key и парность emit/listen,
уведомления и их локализацию, переменные документов и санитайзер DOCX — и три
архитектурных барьера выше.
