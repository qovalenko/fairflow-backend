# Activity

Домен активностей: задачи, встречи, звонки и прочие дела проекта — с исполнителем,
сроком, напоминанием и связями на другие CRM-сущности (контакт, компанию, сделку,
продажу). Здесь же живут календарное представление, корзина, сканер просрочек и
поддержание снимков имён в связях. Наружу отдаёт только gRPC
(`fairflow.activity.v1`, порт 5008).

## Что хранит

**MongoDB**:

| Коллекция | Что лежит |
| --- | --- |
| `crm_activities` | активности проекта: тип, статус, срок, исполнитель и подразделение, напоминание, массив `links` со снимком имени связанной сущности |
| `idempotency_keys` | журнал идемпотентности мутаций (TTL) |
| `_outbox` | transactional outbox исходящих событий (TTL на опубликованные) |

Индексы ведут `projectId`: `{ projectId, status, dueDate }`,
`{ projectId, links.entityId }`, `{ projectId, assigneeId, dueDate }`
(`src/mongo/mongo.service.ts`). Требование барьера NFR-550 — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».

## gRPC-API

Пакет `fairflow.activity.v1`, контракт — [`proto/fairflow/activity/v1/activity.proto`](../proto/fairflow/activity/v1/activity.proto),
реализация — `src/activity/activity.grpc.controller.ts`. Один сервис
`ActivityGrpc`, 14 методов.

| Метод | Назначение |
| --- | --- |
| `ListActivities`, `GetActivity` | список с фильтрами и карточка |
| `ListActivitiesCalendar` | выборка под календарь |
| `CountOverdue` | счётчик просроченных |
| `CreateActivity`, `UpdateActivity` | создание и правка |
| `CompleteActivity` | завершение |
| `DeleteActivity`, `RestoreActivity`, `ListTrash` | корзина |
| `CountMemberOwnedRecords`, `ReassignMemberOwnedRecords` | подсчёт и переназначение записей уходящего участника |
| `ClaimReminderFire`, `ReleaseReminderFire` | внутренние s2s-методы: планировщик уведомлений забирает право доставить напоминание ровно один раз |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).
Входящие вызовы проходят валидацию сервисного API-ключа (`src/auth-validation/`);
пользовательский JWT домен не разбирает.

Исходящие вызовы:

- **control** — проверка, что назначаемый исполнитель входит в участников проекта
  (`ProjectGrpc.ListMembers`, с кэшем). Проверка **fail-closed**: при недоступном
  control мутация отклоняется с `UNAVAILABLE`, а не проходит.
- **contact / company / pipe / orders** — read-only резолв отображаемых имён для
  снимков в `links` (`src/activity/name-resolver.service.ts`). При таймауте
  снимок остаётся пустым, а связь не помечается осиротевшей.

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP нет — см. [../docs/01-architecture.md](../docs/01-architecture.md) §1.

## События

**Публикует** через outbox → RabbitMQ (`src/outbox/`):
`crm.activity.created`, `crm.activity.updated`, `crm.activity.completed`,
`crm.activity.deleted`, `crm.activity.restored`, `crm.activity.reassigned`,
`crm.activity.overdue`, `crm.activity.reminder_scheduled`,
`crm.activity.reminder_cancelled`.

`crm.activity.overdue` публикует периодический `OverdueScannerService` — по
одному разу на запись, через `claimOverdueNotification`.

**Потребляет** (`src/messaging/` + `src/activity/*.consumer.ts`):

| Consumer | Ключи | Что делает |
| --- | --- | --- |
| `link-drift` | `crm.contact.updated/deleted`, `crm.company.updated/deleted`, `crm.deal.updated/deleted`, `crm.order.updated/deleted` | обновляет снимок имени в связи (`refresh`) либо помечает связь осиротевшей (`orphan`) |
| `contact-merged` | `crm.contact.merged` | переводит связи на мастер-контакт |
| `company-merged` | `crm.company.merged` | то же для компаний |
| `member-offboarded` | `control.member.offboarded` | переназначает активности уходящего участника |
| `project-purge` | `control.project.purged` | удаляет `crm_activities` проекта |

Очереди именуются через `busQueueName` (`<BUS_NAMESPACE>.activity.<consumer>`), у
каждой — ограниченные ретраи и терминальная DLQ (`shared/src/consumer-dlq.ts`).

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run start:infra            # в т.ч. Mongo и RabbitMQ
npm run start:activity:dev     # HTTP 3008, gRPC 5008
```

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `HTTP_PORT` / `GRPC_ACTIVITY_PORT` | HTTP 3008 / gRPC 5008 |
| `MONGODB_URI` | MongoDB |
| `AUTH_GRPC_URL` | валидация сервисного ключа |
| `CONTROL_GRPC_URL` | scope видимости и проверка исполнителя (fail-closed) |
| `CONTROL_MEMBERS_CACHE_TTL_MS`, `CONTROL_MEMBERS_TIMEOUT_MS` | кэш и таймаут проверки исполнителя |
| `CONTACT_GRPC_URL`, `COMPANY_GRPC_URL`, `PIPE_GRPC_URL`, `ORDERS_GRPC_URL` | доноры для резолва имён в связях |
| `ACTIVITY_SERVICE_API_KEY` | s2s-ключ к донорам (fallback — `GATEWAY_SERVICE_API_KEY`) |
| `ACTIVITY_NAME_RESOLVE_TIMEOUT_MS` | таймаут резолва имени |
| `RABBITMQ_URL` | шина (outbox-relay и consumer'ы) |
| `PROJECT_PURGE_CONSUMERS_ENABLED` | выключатель consumer'а purge |
| `GRPC_REFLECTION_ENABLED` | server reflection — только для разработки |

Сканер просрочек настраивается `ACTIVITY_OVERDUE_SCANNER_ENABLED`,
`ACTIVITY_OVERDUE_SCAN_INTERVAL_MS`, `ACTIVITY_OVERDUE_SCAN_BATCH`.

Проверки:

```bash
cd activity && npm run check        # tsc --noEmit + eslint + jest
cd activity && npx jest overdue     # один набор тестов
```

## Тесты

31 spec-файл (`src/**/*.spec.ts`).

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `activity/` | 20 | контроллер `ActivityGrpc`, фильтры списка и корзина, профиль типа активности, `departmentId` и имя исполнителя, идемпотентность мутаций, напоминания (`ClaimReminderFire`, восстановление), просрочки (публикация, отметка «уведомлено», сканер), дрейф связей и его consumer, резолв имён, слияние контактов/компаний, офбординг участника, purge проекта, участники проекта |
| `outbox/` + `messaging/` | 4 | store и его requeue, relay, публикатор, consumer с ретраями и DLQ |
| инфраструктура | 7 | конфиг, health/readiness, метрики, Mongo-сервис и индексы, валидация сервисного ключа и inbound-guard |

Барьер NFR-510 (у каждого CRM-домена обязана быть регрессия на изоляцию по
`projectId`) домен закрывает файлами `activity/project-purge.consumer.spec.ts`,
`activity/activity.list-trash.spec.ts`, `activity/project-members.service.spec.ts`
и `activity/name-resolver.service.spec.ts` — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».
