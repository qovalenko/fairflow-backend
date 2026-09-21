# Pipe

Ядро продаж: сделки и воронки. В Fairflow лид, заявка и продажа — **не** разные
сущности, а одна сделка на разных стадиях настраиваемой воронки, поэтому pipe
владеет и самой сделкой, и конфигурацией процесса: воронками и стадиями,
источниками сделок, причинами проигрыша, историей стадий и авто-переходами.
Наружу отдаёт только gRPC (`fairflow.pipe.v1`, порт 5005).

Почему домен устроен именно так — [../docs/04-domain-model.md](../docs/04-domain-model.md) §2.

## Что хранит

**MongoDB**:

| Коллекция | Что лежит |
| --- | --- |
| `crm_deals` | сделки проекта (soft-delete через `deletedAt`) |
| `crm_pipelines` | воронки и их стадии, включая настройки авто-переходов |
| `crm_deal_sources` | справочник источников сделки |
| `crm_lost_reasons` | справочник причин проигрыша |
| `crm_deal_stage_history` | архив истории перемещений по стадиям (вытеснение переполненного лога карточки) |
| `crm_drift_inbox` | inbox-дедуп входящих событий дрейфа связанных сущностей (уникальный `messageId` + TTL) |
| `crm_bulk_jobs` | задания массовых операций над сделками |
| `idempotency_keys` | журнал идемпотентности мутаций (TTL) |
| `_outbox` | transactional outbox исходящих событий (TTL на опубликованные) |

Каждый бизнес-документ несёт `projectId`, и все составные индексы ведут им:
`{ projectId, updatedAt }`, `{ projectId, pipelineId, stageId }`,
`{ projectId, productId }`, `{ projectId, assigneeId }`,
`{ projectId, contactId|companyId }`, партиал `{ projectId, deletedAt }`
(`src/mongo/mongo.service.ts`). Требование барьера NFR-550 — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».

`crm_drift_inbox` намеренно **не** входит в purge проекта: строка ключуется
только `messageId` и не несёт `projectId`.

## gRPC-API

Пакет `fairflow.pipe.v1`, контракт — [`proto/fairflow/pipe/v1/pipe.proto`](../proto/fairflow/pipe/v1/pipe.proto),
реализация — `src/pipe/pipe.grpc.controller.ts`. Один сервис `PipeGrpc`, 35 методов.

| Группа | Методы |
| --- | --- |
| Сделки: чтение | `ListDeals`, `GetDeal`, `GetDealsKanban`, `GetDashboard`, `GetDealDrift` |
| Сделки: запись | `CreateDeal`, `UpdateDeal`, `DeleteDeal`, `RestoreDeal`, `BulkUpdateDeals` |
| Движение по воронке | `MoveDealToStage`, `CloseDeal`, `ReopenDeal` |
| Связи и дрейф | `LinkContact`, `LinkCompany`, `AcceptContactDrift`, `BulkAcceptDrift` |
| Воронки | `ListPipelines`, `CreatePipeline`, `UpdatePipeline`, `DeletePipeline` |
| Источники | `ListDealSources`, `CreateDealSource`, `UpdateDealSource`, `DeleteDealSource` |
| Причины проигрыша | `ListLostReasons`, `CreateLostReason`, `UpdateLostReason`, `DeleteLostReason` |
| Межсервисное | `CountDealsByProduct` (гейт удаления продукта), `CountMemberOwnedRecords`, `ReassignMemberOwnedRecords`, `ResolveDocumentVariables` |
| Провижининг | `ProvisionDefaults` (стартовая воронка и справочники), `SeedDemoData` |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).
Входящие вызовы проходят валидацию сервисного API-ключа (`src/auth-validation/`);
пользовательский JWT домен не разбирает.

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP нет — см. [../docs/01-architecture.md](../docs/01-architecture.md) §1.

## События

**Публикует** через outbox → RabbitMQ (`src/outbox/`):
`crm.deal.created`, `crm.deal.updated`, `crm.deal.deleted`, `crm.deal.restored`,
`crm.deal.stage_changed`, `crm.deal.won`, `crm.deal.lost`, `crm.deal.reopened`,
`crm.deal.reassigned`, `crm.deal.drift_accepted`,
`crm.deal.product_linked`, `crm.deal.product_unlinked`,
`crm.contact.deal_attached`, `crm.company.deal_attached`.

**Потребляет** (`src/messaging/` + `src/pipe/*.consumer.ts`):

| Consumer | Ключи | Что делает |
| --- | --- | --- |
| `drift` | `crm.contact.updated`, `crm.company.updated` | ловит расхождение снимка связанной сущности со сделкой; дедуп по `messageId` в `crm_drift_inbox` |
| `contact-merged` | `crm.contact.merged` | переводит ссылки сделок на мастер-контакт |
| `company-merged` | `crm.company.merged` | то же для компаний |
| `entity-source` | `crm.product.deleted`, `crm.contact.deleted`, `crm.company.deleted` | снимает ссылки на удалённые сущности |
| `stage-auto-transition` | `crm.deal.stage_changed` | применяет настроенные авто-переходы воронки (с ограничением глубины каскада) |
| `member-offboarded` | `control.member.offboarded` | переназначает сделки уходящего участника |
| `project-purge` | `control.project.purged` | удаляет данные проекта из пяти коллекций домена |

Очереди именуются через `busQueueName` (`<BUS_NAMESPACE>.pipe.<consumer>`), у
каждой — ограниченные ретраи и терминальная DLQ (`shared/src/consumer-dlq.ts`).

## Разработка

```bash
# из корня репозитория
npm run build:shared
npm run start:infra        # в т.ч. Mongo и RabbitMQ
npm run start:pipe:dev     # HTTP 3005, gRPC 5005
```

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `HTTP_PORT` / `GRPC_PIPE_PORT` | HTTP 3005 / gRPC 5005 |
| `MONGODB_URI` | MongoDB |
| `AUTH_GRPC_URL` | валидация сервисного ключа |
| `CONTROL_GRPC_URL` | догрузка отложенного scope видимости на стороне домена |
| `RABBITMQ_URL` | шина (outbox-relay и consumer'ы) |
| `PROJECT_PURGE_CONSUMERS_ENABLED` | выключатель consumer'а purge |
| `GRPC_REFLECTION_ENABLED` | server reflection — только для разработки |

Дополнительно поведение consumer'ов настраивается
`PIPE_DRIFT_QUEUE`, `PIPE_ENTITY_SOURCE_QUEUE`,
`PIPE_AUTO_TRANSITION_CONSUMER_ENABLED`, `PIPE_AUTO_TRANSITION_MAX_DEPTH`,
`PIPE_AUTO_TRANSITION_SUBSCRIBE_RETRIES`.

Проверки:

```bash
cd pipe && npm run check         # tsc --noEmit + eslint + jest
cd pipe && npx jest move         # один набор тестов
```

## Тесты

46 spec-файлов (`src/**/*.spec.ts`).

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `pipe/` | 30 | CRUD и жизненный цикл сделки, перемещение по стадиям и авто-переходы, канбан и его тоталы, фильтры списка, производные поля сделки, слияние контактов/компаний, дрейф и его inbox, массовые задания, ABAC-фильтр чтения, соответствие контроллера proto, границы int64, демо-сид, офбординг участника, purge проекта, производительность гидрации видимости |
| `outbox/` + `messaging/` | 4 | store, relay, публикатор, consumer с ретраями и DLQ |
| инфраструктура | 12 | конфиг, health/readiness, метрики и интерцептор, Mongo-сервис и индексы, идемпотентность, валидация сервисного ключа и inbound-guard, request-context |

Барьер NFR-510 (у каждого CRM-домена обязана быть регрессия на изоляцию по
`projectId`) домен закрывает файлами `pipe/project-purge.consumer.spec.ts`,
`pipe/pipe.service.move.spec.ts` и `pipe/pipe.service.integration.spec.ts` — см.
[../shared/README.md](../shared/README.md) § «Архитектурные барьеры».
