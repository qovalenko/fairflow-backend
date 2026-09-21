# Fairflow — Backend

Монорепозиторий микросервисов проектно-центричной модульной CRM-платформы
Fairflow: NestJS 11 + Fastify, межсервисное взаимодействие по gRPC, npm
workspaces.

**Как устроена система — в [docs/](docs/README.md):** архитектура, модель
gRPC-взаимодействия, ролевая модель, доменная модель, требования по модулям.
Быстрый старт локально — [DEV-LOCAL.md](DEV-LOCAL.md). Ниже — полный
технический справочник.

Фронтенд — в репозитории `fairflow-frontend`.

---

## Содержание

1. [Требования](#требования)
2. [Инфраструктура (Docker)](#инфраструктура-docker)
3. [Миграции PostgreSQL](#миграции-postgresql)
4. [Сиды (Postgres + Mongo)](#сиды-postgres--mongo)
5. [Сборка и запуск сервисов](#сборка-и-запуск-сервисов)
6. [Переменные окружения](#переменные-окружения)
7. [Health / metrics](#health--metrics)
8. [Полный сброс локальной БД](#полный-сброс-локальной-бд)
9. [Скрипты npm (шпаргалка)](#скрипты-npm-шпаргалка)
10. [Workspaces и новые сервисы](#workspaces)

---

## Требования

- **Node.js** ≥ 20.19 (`engines` в корневом `package.json` сервисов)
- **Docker** + Docker Compose — для Postgres, Mongo, Redis, RabbitMQ, MinIO
- Для миграций/сидов: доступ к Postgres на `localhost:5432`

---

## Инфраструктура (Docker)

Каталог: **`docker/`**.

### Запуск

Из корня репозитория:

```bash
npm run start:infra
```

Что делает скрипт: копирует `docker/.env.example` → `docker/.env` (если нет), затем `docker compose up -d`.

Остановка:

```bash
npm run stop:infra
```

Логи:

```bash
npm run infra:logs
```

### Сервисы и порты (по умолчанию)

| Сервис     | Контейнер           | Порт хоста | Учётные данные (дефолт)        |
|-----------|---------------------|------------|--------------------------------|
| PostgreSQL | `fairflow-postgres` | 5432       | `fairflow` / `fairflow`, БД `fairflow` |
| MongoDB   | `fairflow-mongo`    | 27017      | root: `root` / `fairflow`, БД `fairflow` |
| Redis     | `fairflow-redis`    | 6379       | без пароля                     |
| RabbitMQ  | `fairflow-rabbitmq` | 5672 (AMQP), 15672 (UI) | `fairflow` / `fairflow` |
| MinIO     | `fairflow-minio`    | 9000 (API), 9001 (консоль) | `minioadmin` / `minioadmin` |

Настройка портов и паролей — в **`docker/.env`** (шаблон: **`.env.example`**).

### Наблюдаемость (опционально)

```bash
cd docker && docker compose --profile observability up -d
```

Поднимает Prometheus (`:9090`) и Grafana. **Внимание:** по умолчанию Grafana проброшена на **`3003`** хоста — тот же порт, что у **contact** при локальном запуске. При конфликте измените `GRAFANA_PORT` в `docker/.env`.

### Важно

- Сами Nest/gRPC-приложения **не** поднимаются compose’ом (кроме инфраструктуры). Их запуск — через `npm run start:*` из корня.

---

## Миграции PostgreSQL

Одна БД **`fairflow`**, отдельные **схемы** для приложений: **`auth`**, **`control`**, **`gateway`**, **`billing`**. Доменные таблицы не живут в `public`.

| Схема   | Пакет (workspace) | Команда из корня        |
|---------|-------------------|-------------------------------|
| `auth`  | `auth/`           | `npm run db:migrate:auth`     |
| `control` | `control/`      | `npm run db:migrate:control`  |
| `gateway` | `gateway/`      | `npm run db:migrate:gateway`  |
| `billing` | `billing/`      | `npm run db:migrate:billing`  |

### Полная цепочка (как у `seed:all`)

`npm run db:provision`:

1. `build:shared`
2. `prisma migrate deploy` + `prisma generate` в **auth**
3. то же в **control**
4. то же в **gateway**
5. то же в **billing**
6. **`npm run db:seed:postgres`** (см. ниже — нужен `SEED_GATEWAY_SERVICE_API_KEY`)

### Имена миграций

У **auth** и **control** папки миграций в одной БД должны иметь **разные имена** (например `20250318000000_auth_init` и `20250318000001_control_init`). Два одинаковых имени (`…_init`) ломают применение второй схемы.

### Новая миграция (разработка)

Внутри соответствующего сервиса (`auth` / `control` / `gateway`):

```bash
npx prisma migrate dev --name описание_изменения
```

(используйте Prisma как обычно для этого workspace; схема задаётся в `schema.prisma` сервиса.)

---

## Сиды (Postgres + Mongo)

### Пользователи auth (`db:seed:auth-users`)

Список логинов / **email** / паролей: **`scripts/data/auth-users.seed.json`**. Email в БД хранится в **нижнем регистре**; вход с фронта по полю email — **без учёта регистра**.

Только пользователи (без OAuth-ключа и control-проекта):

```bash
npm run db:seed:auth-users
```

Полный сид (`db:seed:postgres` / `seed:all`) подтягивает тот же JSON и дополнительно создаёт OAuth-клиент, ключ gateway и dev-проект для пользователя с `"devProjectOwner": true`.

### Postgres (`db:seed:postgres`)

Скрипт: **`scripts/postgres-seed.ts`**.

**Обязательно:**

- **`DATABASE_URL`** — строка подключения к Postgres (по умолчанию `postgresql://fairflow:fairflow@localhost:5432/fairflow`).
- **`SEED_GATEWAY_SERVICE_API_KEY`** — открытый ключ вида `ak_…` (не коммитить). Тот же значение потом кладётся в **`gateway`** как `GATEWAY_SERVICE_API_KEY`.

Переменные читаются из **`.env`** (и при необходимости `.fairflow-dev.env`). Пример **`.env`**:

```env
DATABASE_URL=postgresql://fairflow:fairflow@localhost:5432/fairflow
SEED_GATEWAY_SERVICE_API_KEY=ak_ваш_сгенерированный_ключ
```

После успешного сида создаётся **`.fairflow-dev.env`** (в gitignore), например:

- `ADMIN_USER_ID`, `DEV_PROJECT_ID`
- `GATEWAY_SERVICE_API_KEY`, `GATEWAY_API_KEY_ID` — скопировать в **`gateway/.env`**

### Mongo (`db:seed:mongo`)

Использует **`DEV_PROJECT_ID`** из **`.fairflow-dev.env`** (сначала нужен успешный Postgres-сид).

### Одной командой

```bash
# из корня, после start:infra и настроенного .env с SEED_GATEWAY_SERVICE_API_KEY
npm run seed:all
```

Это: **`db:provision`** (миграции + postgres seed) → **`db:seed:mongo`**.

---

## Сборка и запуск сервисов

### Сборка всех workspace’ов

```bash
npm install
npm run build
```

### Порядок запуска (рекомендуемый)

| Шаг | Сервис        | HTTP  | gRPC / прочее | Зависимости        |
|-----|---------------|-------|---------------|--------------------|
| 1   | Инфра         | —     | —             | Docker             |
| 2   | Сиды          | —     | —             | Postgres (+ потом Mongo) |
| 3   | **auth**      | 3001  | 5001          | Postgres           |
| 4   | **control**   | 3002  | 5002          | Postgres           |
| 5   | **contact**   | 3003  | 5003          | Mongo              |
| 5   | **company**   | 3004  | 5004          | Mongo              |
| 6   | **домены CRM** | —    | 5005–5017     | Mongo; pipe 5005, orders 5006, product 5007, activity 5008, documents 5010, reports 5011, automation 5012, search 5013, audit 5014, notification 5015, billing 5016, chat 5017 |
| 7   | **gateway**   | 3000  | —             | Postgres + gRPC к остальным; **последним** |

### Команды разработки (из корня)

```bash
npm run start:auth:dev
npm run start:control:dev
npm run start:contact:dev
npm run start:company:dev
# опционально:
npm run start:gateway:dev   # последним
```

Продакшен-сборка после `npm run build`:

```bash
npm run start:auth
npm run start:control
# … аналогично остальным доменам, gateway — последним
```

### Gateway: обязательно после сида

В **`gateway/.env`** (шаблон: **`gateway/.env.example`**):

- **`GATEWAY_SERVICE_API_KEY`** = тот же `ak_…`, что в `SEED_GATEWAY_SERVICE_API_KEY`
- **`GATEWAY_API_KEY_ID`** = из **`.fairflow-dev.env`** (строка в БД должна совпадать)
- **`JWT_SECRET`** должен совпадать с тем, с которым **auth** выдаёт access-токены (в примерах часто `change-me-in-production`; если auth без `.env`, у него другой дефолт — выровняйте вручную)
- Адреса gRPC: **`AUTH_GRPC_URL`**, **`CONTROL_GRPC_URL`**, **`CONTACT_GRPC_URL`**, **`COMPANY_GRPC_URL`**, и порты остальных доменов (`PIPE_GRPC_URL`, …) — см. **`gateway/.env.example`**

---

## Переменные окружения (кратко)

| Назначение              | Где задавать |
|-------------------------|--------------|
| Postgres URL            | `DATABASE_URL` (auth, control, gateway, billing; `.env` для сида) |
| Mongo                   | `MONGODB_URI` (все Mongo-домены: contact, company, pipe, orders, product, activity, documents, reports, automation, search, chat, notification, audit) |
| Ключ для сида gateway   | `SEED_GATEWAY_SERVICE_API_KEY` в **`.env`** |
| Рантайм gateway         | **`gateway/.env`** |
| Redis / RabbitMQ / MinIO| см. `docker/.env.example` и сервисы, которым они нужны |

---

## Health / metrics

Единый контракт (типы в `@fairflow/shared`, `ops-http-contract`):

| Метод | Путь       | Успех |
|-------|------------|--------|
| GET   | `/healthz` | `{"status":"ok"}` |
| GET   | `/readyz`  | `{"status":"ok"}` или **503** при ошибке |
| GET   | `/status`  | `{"status":"ok","timestamp":"…"}` |
| GET   | `/metrics` | Prometheus text |

Проверка: auth `http://127.0.0.1:3001/healthz`, gateway `http://127.0.0.1:3000/healthz`, и т.д.

---

## Полный сброс локальной БД

1. Остановить приложения.
2. `npm run stop:infra`
3. Удалить тома Postgres/Mongo (данные пропадут):

   ```bash
   cd docker && docker compose down -v
   ```

4. Снова `npm run start:infra`
5. Сгенерировать **новый** `ak_…` для сида, обновить **`.env`** и потом **`gateway/.env`**
6. `npm run seed:all`
7. Обновить **`GATEWAY_API_KEY_ID`** в gateway из нового `.fairflow-dev.env`

---

## Скрипты npm (шпаргалка)

| Скрипт | Назначение |
|--------|------------|
| `npm run build` | Сборка всех workspaces |
| `npm run build:shared` | Только `@fairflow/shared` |
| `npm run start:infra` / `stop:infra` | Docker-стек |
| `npm run db:migrate:auth` | Миграции схемы `auth` |
| `npm run db:migrate:control` | Миграции схемы `control` |
| `npm run db:migrate:gateway` | Миграции схемы `gateway` |
| `npm run db:provision` | Миграции auth+control+gateway + postgres seed |
| `npm run db:seed:postgres` | Только postgres seed (после миграций) |
| `npm run db:seed:auth-users` | Только пользователи из `scripts/data/auth-users.seed.json` |
| `npm run db:seed:mongo` | Mongo seed по `DEV_PROJECT_ID` |
| `npm run seed:all` | `db:provision` + mongo seed |
| `npm run start:*:dev` / `start:*` | Запуск отдельных сервисов |
| `npm run lint` / `test` / `check` | По workspace’ам |

---

## Workspaces

19 workspace'ов:

- **`shared`** — контракты, метадата, ошибки, RBAC, реестр модулей; собирается первым
- **`testing`** — общий тестовый инструментарий
- **`gateway`** — единая публичная точка входа, gRPC-клиенты к доменам
- **`auth`** — сессии, API-ключи, JWT · **`control`** — проекты, участники, роли · **`billing`** — лицензии и счета (все на PostgreSQL)
- CRM-домены на MongoDB: **`contact`**, **`company`**, **`pipe`** (сделки), **`orders`**, **`product`**, **`activity`**, **`documents`**, **`reports`**, **`automation`**, **`search`**, **`chat`**, **`notification`**, **`audit`**

Каталог `platform/` существует на диске, но в `workspaces` не включён — команды
вида `npm run build --workspaces` его не затрагивают.

Новый сервис: взять за образец любой существующий доменный workspace, добавить имя в `workspaces`, задать свои `PORT` / БД. Детали — в разделе ниже.

### Межсервисная авторизация

Два слоя: клиент → gateway по пользовательскому JWT, gateway → домен по
сервисному API-ключу в gRPC-метадате (`x-service-api-key`), который домен
валидирует через auth. Доменные сервисы пользовательский JWT не разбирают.
Полностью — в [docs/02-grpc-model.md](docs/02-grpc-model.md).

---

## Adding a new service

1. Взять за образец существующий доменный workspace и скопировать его в `<id>/`.
2. В `package.json`: `"name": "fairflow-<id>-service"`, добавить папку в `workspaces`.
3. Задать `PORT` / gRPC / `DATABASE_URL` или `MONGODB_URI`.
4. Заменить доменный модуль; сохранить health, metrics, конфиг.
