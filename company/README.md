# Company

CRM-домен компаний (юрлиц и контрагентов) проекта: карточка компании, владение и
переназначение, корзина с отложенным физическим удалением, поиск дублей,
слияние с возможностью отката и CSV-импорт. Домен также резолвит переменные
компании для генерации документов. Наружу отдаёт только gRPC
(`fairflow.company.v1`, порт 5004).

## Что хранит

**MongoDB**, база одна на платформу, коллекции домена:

| Коллекция | Что лежит |
| --- | --- |
| `companies` | карточки компаний проекта; soft-delete через `deletedAt`, отложенный purge через TTL по `purgeAt` |
| `company_archives` | снимки слияния — из них работает `RestoreMerge` (откат слияния) |
| `idempotency_keys` | журнал идемпотентности мутаций (TTL), см. `@fairflow/shared` → `withIdempotency` |
| `_outbox` | transactional outbox исходящих событий (TTL на опубликованные) |

Каждый документ несёт поле верхнего уровня `projectId`, и **все** составные
бизнес-индексы начинаются с него: `{ projectId, deletedAt, updatedAt, _id }` под
основной список, `{ projectId, deletedAt, ownerId|status|industry }` под фильтры,
партиал-уникальный `{ projectId, identityHash }` под дедуп личности компании
(`src/mongo/mongo.service.ts`). Это не стиль, а требование барьера NFR-550 —
см. [../shared/README.md](../shared/README.md) § «Архитектурные барьеры».

`projectId` берётся из gRPC-метадаты, а не из тела запроса
([../docs/04-domain-model.md](../docs/04-domain-model.md) §1).

## gRPC-API

Пакет `fairflow.company.v1`, контракт — [`proto/fairflow/company/v1/company.proto`](../proto/fairflow/company/v1/company.proto),
реализация — `src/grpc/company.grpc.controller.ts`. Один сервис `CompanyGrpc`,
18 методов.

| Метод | Назначение |
| --- | --- |
| `ListCompanies`, `GetCompany` | список с фильтрами/пагинацией и карточка |
| `CreateCompany`, `UpdateCompany` | создание и правка |
| `UpdateOwner` | смена владельца записи |
| `DeleteCompany`, `RestoreCompany`, `ListTrash` | корзина: soft-delete, восстановление, содержимое |
| `PurgeCompany` | физическое удаление «навсегда» |
| `FindDuplicates` | радар дублей по дедуп-ключам |
| `PreviewMerge`, `MergeCompanies`, `RestoreMerge` | предпросмотр, слияние, откат слияния по архиву |
| `AggregateCompanies` | агрегаты по выборке |
| `ImportCompanies` | массовая загрузка (CSV) |
| `CountMemberOwnedRecords`, `ReassignMemberOwnedRecords` | подсчёт и переназначение записей уходящего участника |
| `ResolveDocumentVariables` | переменные компании для генерации документов |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).
Входящие вызовы проходят валидацию сервисного API-ключа
(`src/auth-validation/`), пользовательский JWT домен не разбирает.

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP нет — см. [../docs/01-architecture.md](../docs/01-architecture.md) §1.

## События

**Публикует** через outbox → RabbitMQ (`src/outbox/`):
`crm.company.created`, `crm.company.updated`, `crm.company.deleted`,
`crm.company.restored`, `crm.company.purged`, `crm.company.merged`,
`crm.company.merge_reverted`.

**Потребляет** (`src/messaging/` + `src/companies/*.consumer.ts`):

| Consumer | Ключи | Что делает |
| --- | --- | --- |
| `contact-card-cache` | `crm.contact.updated`, `crm.contact.deleted`, `crm.contact.merged`, `crm.company.contact_linked`, `crm.company.contact_unlinked` | поддерживает кэш карточек связанных контактов в актуальном состоянии |
| `member-offboarded` | `control.member.offboarded` | переназначает записи уходящего участника |
| `project-purge` | `control.project.purged` | физически удаляет данные проекта из `companies` и `company_archives` |

Очереди именуются через `busQueueName` (`<BUS_NAMESPACE>.company.<consumer>`), у
каждой — ограниченные ретраи и терминальная DLQ (`shared/src/consumer-dlq.ts`).

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run start:infra           # в т.ч. Mongo и RabbitMQ
npm run start:company:dev     # HTTP 3004, gRPC 5004
```

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `PORT` / `GRPC_PORT` | HTTP 3004 / gRPC 5004 |
| `MONGODB_URI` | MongoDB |
| `AUTH_GRPC_URL` | валидация сервисного ключа |
| `CONTROL_GRPC_URL` | догрузка отложенного scope видимости на стороне домена |
| `RABBITMQ_URL` | шина (outbox-relay и consumer'ы) |
| `PROJECT_PURGE_CONSUMERS_ENABLED` | выключатель consumer'а purge |
| `GRPC_REFLECTION_ENABLED` | server reflection — только для разработки |

Проверки:

```bash
cd company && npm run check        # tsc --noEmit + eslint + jest
cd company && npx jest merge       # один набор тестов
```

## Тесты

27 spec-файлов (`src/**/*.spec.ts`).

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `companies/` | 12 | слияние и его агрегаты, сверка слияний, коллизия создания с записью в корзине, TTL корзины, ABAC-фильтр чтения, кэш карточек контактов, CSV-импорт, пагинация списка, офбординг участника, purge проекта, валидатор цели переназначения, интеграционный сценарий «контакты × компании» |
| `grpc/` | 3 | контроллер `CompanyGrpc`, атрибуция владельца, переменные документов |
| инфраструктура | 12 | конфиг, health/readiness, метрики, идемпотентность, валидация сервисного ключа и inbound-guard, request-context, сборка `AppModule` |

Барьер NFR-510 (у каждого CRM-домена обязана быть регрессия на изоляцию по
`projectId`) домен закрывает файлами `companies/project-purge.consumer.spec.ts` и
`grpc/company.grpc.controller.spec.ts` — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».
