# Control

Плоскость управления платформы: проекты, участники, орг-структура, роли и права,
жизненный цикл модулей, интеграции проекта. Это единственный домен, который знает,
**кто** и **где** имеет доступ: gateway на каждом запросе спрашивает у control
членство, проектную роль, эффективные права и границу видимости записей.
Бизнес-логику control отдаёт только по gRPC (`fairflow.control.v1`, порт 5002).

## Что хранит

**PostgreSQL**, схема `control` (Prisma 7 + `@prisma/adapter-pg`, миграции —
`prisma/migrations/`). Доменных таблиц в `public` нет.

| Группа | Модели |
| --- | --- |
| Проект | `Project`, `ProjectMember`, `ProjectInvitation`, `ProjectAccessEpoch` |
| Орг-структура | `SystemSettings`, `Employee`, `Invitation`, `Department`, `DepartmentProjectBinding` |
| Единицы доступа | `AccessUnit`, `AccessUnitMember` |
| Права | `Role`, `RolePermission`, `RoleAssignment`, `PermissionGrant` |
| Видимость | `RecordShare` |
| Журналы | `RoleAuditLog`, `OrgAuditLog` (append-only) |
| Интеграции | `ProjectIntegration`, `ProjectApiKey`, `WebhookDelivery` |
| Шина | `ControlOutbox` |

Две детали, которые стоит знать заранее:

- **Организации как отдельной сущности нет.** Инстанс — единственная «система»:
  `SystemSettings` (ровно одна строка с id `system`) держит реквизиты, а дочерние
  записи носят `organizationId`/`ownerId` = системный якорь. Подробнее —
  [../docs/04-domain-model.md](../docs/04-domain-model.md) §1.
- **Каталог прав не хранится.** Он вычисляется из манифестов включённых модулей —
  см. [../docs/03-access-model.md](../docs/03-access-model.md) §2.

Секреты интеграций шифруются в БД (AES-256-GCM, ключ выводится из
`FF_SECRET_ENCRYPTION_KEY`); без ключа сохранение секрета отклоняется, а уже
сохранённый не читается — fail-closed на обеих ветках (`src/integrations/secret-crypto.ts`).

## gRPC-API

Пакет `fairflow.control.v1`, контракт — [`proto/fairflow/control/v1/control.proto`](../proto/fairflow/control/v1/control.proto),
реализация — `src/grpc/control.grpc.controller.ts`.

| gRPC-сервис | Методов | Назначение |
| --- | --- | --- |
| `ProjectGrpc` | 28 | CRUD проекта, участники, приглашения, жизненный цикл (`ArchiveProject`, `RequestProjectDeletion`, `RestoreProject`), шаблоны (`ApplyTemplate`), настройки модулей, шаринг записей (`ShareRecord`/`ListRecordShares`/`UnshareRecord`), PDP-запросы (`CheckAccess`, `ResolveRecordVisibility`, `GetProjectAccessEpoch`) |
| `OrganizationGrpc` | 38 | реквизиты системы, сотрудники, подразделения и их привязки к проектам, приглашения, места (`GetOrgSeats`), орг-роль и её проекция прав, журнал `ListOrgAudit`, предпросмотры реорганизации и офбординга |
| `RoleGrpc` | 18 | каталог прав (`GetPermissionCatalog`), кастомные роли, назначения, гранты, расчёт эффективных прав (`ResolveEffectivePermissions`, `CheckPermissions`), симуляция доступа (`SimulateAccess`, `SimulateAccessExplain`), журнал ролей |
| `AccessUnitGrpc` | 10 | единицы доступа: дерево, состав, участники, предпросмотр состава |
| `ModuleLifecycleControlGrpc` | 8 | установка/включение/выключение/обновление модулей проекта, возобновление доставки |
| `IntegrationGrpc` | 10 | интеграции проекта, проектные API-ключи (включая `ValidateProjectApiKey`), доставки вебхуков |

Правила вызова, метадата и маппинг ошибок — [../docs/02-grpc-model.md](../docs/02-grpc-model.md).

Входящие вызовы проходят `GrpcInboundApiKeyGuard`: сервисный ключ из метадаты
валидируется в auth (`ApiKeyGrpc.ValidateServiceApiKey`) с кэшем. Исходящие
вызовы control делает в auth (`UserDirectoryGrpc.ResolveUsers` — резолв имён и
email участников) и в pipe/orders/documents/automation — при провижининге проекта
и жизненном цикле модулей.

## HTTP

Только эксплуатационный контракт `ops-http-contract` из `@fairflow/shared`:
`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`. Бизнес-маршрутов по
HTTP у домена нет и быть не может — см.
[../docs/01-architecture.md](../docs/01-architecture.md) §1 (инвариант 2) и
барьер `shared/src/security/nfr-520-domain-http-surface-barrier.spec.ts`.

## События

**Публикует** через transactional outbox (`ControlOutbox` → relay → RabbitMQ,
`src/outbox/`):

- проект и модули — `control.project.purged`, `control.module.installed|enabled|disabled|uninstalled|upgraded|runtime_resumed`, `control.policy.updated`, `control.preset.applied`;
- доступ и видимость — `control.record.shared`, `control.record.unshared`, `control.visibility.changed`, `control.visibility.narrowed`, `control.member.offboarded`;
- факты аудита — ключ выводится из `(action, entityType)` в `src/outbox/control-event-map.ts`:
  `control.member.added|changed|removed`, `control.department.changed`,
  `control.binding.changed`, `control.invitation.created|accepted|revoked`,
  `control.org.changed|deactivated`, `control.role.assigned|changed|revoked`,
  `control.grant.changed`. Неотображённое действие событие **не** порождает
  (fail-safe: нелегальный ключ не попадёт в outbox).

**Потребляет** — `WebhookConsumerService` (`src/webhooks/`) привязывает durable-очередь
`<BUS_NAMESPACE>.control.webhooks` к ключам `crm.#`, `control.#`, `pipe.#`, `orders.#`
и отдаёт каждый конверт в доставку исходящих вебхуков проекта. Выключается
`CONTROL_WEBHOOKS_DISABLED=true`.

## Разработка

```bash
# из корня репозитория
npm run build:shared          # @fairflow/shared собирается первым
npm run db:migrate:control    # миграции схемы control
npm run start:control:dev     # HTTP 3002, gRPC 5002
```

Порядок запуска: auth (5001) → **control** → CRM-домены → gateway последним.

Переменные — `.env.example`:

| Переменная | Назначение |
| --- | --- |
| `PORT` / `GRPC_PORT` | HTTP 3002 / gRPC 5002 |
| `DATABASE_URL` | PostgreSQL (схема `control`) |
| `AUTH_GRPC_URL` | валидация сервисного ключа; без неё бизнес-RPC не работают |
| `PIPE_GRPC_URL`, `ORDERS_GRPC_URL`, `DOCUMENTS_GRPC_URL`, `AUTOMATION_GRPC_URL` | провижининг и жизненный цикл модулей |
| `CONTROL_SERVICE_API_KEY` | ключ для auth `UserDirectoryGrpc` (fallback — `GATEWAY_SERVICE_API_KEY`) |
| `FF_SECRET_ENCRYPTION_KEY` | шифрование секретов интеграций (≥16 символов, fail-closed) |
| `RABBITMQ_URL` | шина (outbox-relay и consumer вебхуков) |
| `GRPC_REFLECTION_ENABLED` | server reflection — только для разработки |

Проверки:

```bash
cd control && npm run check          # tsc --noEmit + eslint + jest
cd control && npx jest projects      # один набор тестов
```

## Тесты

93 spec-файла (`src/**/*.spec.ts`). Крупнейшие группы:

| Область | Файлов | Что проверяют |
| --- | --- | --- |
| `organizations/` | 34 | орг-структура, приглашения и их истечение, места, каскады деактивации и офбординга (в т.ч. сквозные `*-box.integration.spec.ts` по доменам), резолвер видимости, шаринг записей, журнал аудита |
| `projects/` | 14 | CRUD и жизненный цикл проекта, приглашения, эпоха доступа, включение/выключение модулей и оценка последствий, purge, записи уходящего участника |
| `roles/` | 9 | PDP (`CheckPermissions`, enforcement, симуляция), CRUD ролей, истечение назначений, цепочка аудита |
| `grpc/` | 7 | маппинг сущностей на proto, `Struct`-поля настроек и политик, проекция орг-прав |
| `outbox/` | 6 | store, relay, публикатор, метадата аудита ролей |
| `provisioning/`, `webhooks/`, `integrations/`, `user-directory/` | 9 | провижининг проекта и жизненный цикл автоматизаций, consumer и доставка вебхуков, шифрование секретов, резолв пользователей |
| инфраструктура | 14 | конфиг, health/readiness, метрики, идемпотентность мутаций, валидация сервисного ключа, guard'ы, цепочка аудита, сквозные сценарии доступа |
