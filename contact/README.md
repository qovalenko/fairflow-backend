# Template API Service

NestJS 11 + Fastify 5 + Prisma 7 API template. Based on `backend-project-template.md`.

## Stack

- **Runtime:** Node.js >=20.19
- **Framework:** NestJS 11, Fastify 5
- **ORM:** Prisma 7 (PostgreSQL)
- **Validation:** class-validator, class-transformer
- **Auth:** JWT (Passport), optional Local (login/password)
- **Docs:** Swagger UI at `/docs`
- **Metrics:** Prometheus at `/metrics`
- **Logging:** pino, request context (AsyncLocalStorage)

## Quick start

```bash
cp .env.example .env
# Set DATABASE_URL and JWT_SECRET

npm install
npm run db:push
npm run db:seed
npm run start:dev
```

- Health: `GET /healthz`, `GET /readyz`, `GET /status`
- Swagger: http://localhost:3000/docs
- Login: `POST /api/v1/auth/login` with `{ "login": "admin", "password": "admin" }`
- Me: `GET /api/v1/auth/me` with `Authorization: Bearer <token>`

## Обязательная миграция данных: дедуп-ключи контактов

`normalizePhone` приводит телефон к E.164 (`+79123456789`). Записи, созданные до
этой правки, хранят `phoneNormalized` в старом формате (`89123456789`,
`79123456789`). Для Mongo это разные значения, поэтому на непересчитанных данных:

- партиал-уникальный `uniq_project_phone_normalized` не видит конфликта в паре
  «старая запись против новой» и пропускает дубль;
- дедуп-радар (`findDuplicates`) и очередь дублей сводят записи строго по
  равенству ключа — такую пару они не показывают.

Пересчёт — разовый скрипт (идемпотентен, повторный запуск даёт 0 изменений):

```bash
npm run db:backfill:normalized -- --dry-run   # отчёт без записи
npm run db:backfill:normalized                # применить + поднять уникальные индексы
npm run db:backfill:normalized:check          # гейт: exit 1, если пересчёт не выполнен
npm run db:backfill:normalized -- --project <id> --report /tmp/report.json
```

**Выкатка домена привязана к миграции:** прогонять `…:check` перед стартом новой
версии (exit 1 = данные не мигрированы). Скрипт также сам создаёт уникальные
индексы дедупа и возвращает 1, если создать их не удалось: в `MongoService`
создание индексов best-effort (warn в лог), то есть без этого прогона сервис
спокойно поднимется вообще без уникального индекса.

Коллизии (две живые записи схлопнулись в один ключ) миграция **не сливает** —
слияние необратимо-дорого и требует решения человека. Ключ остаётся у одной
записи (у кого он уже верен → самая ранняя `createdAt` → меньший `_id`), у
остальных снимается, пары складываются в коллекцию
`contacts_normalize_conflicts` и печатаются в отчёт. Это та же развязка, что
домен применяет при `restore` конфликтующей записи (стратегия `clear_keys`).

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | prisma generate + nest build |
| `npm run start:dev` | watch mode |
| `npm run start:prod` | node dist/main.js |
| `npm run db:push` | push schema to DB |
| `npm run db:migrate` | run migrations |
| `npm run db:seed` | seed admin user (admin/admin) |
| `npm run db:backfill:normalized` | разовый пересчёт дедуп-ключей (см. выше) |
| `npm run db:backfill:normalized:check` | гейт выкатки: exit 1, если миграция не выполнена |
| `npm run db:studio` | Prisma Studio |
| `npm run test` | Jest |
| `npm run lint` | ESLint |

## Env (see .env.example)

- `PORT` / `LISTEN_PORT` — port (default 3000)
- `DATABASE_URL` — PostgreSQL URL
- `JWT_SECRET`, `JWT_EXPIRE`
- `CORS_ORIGIN`, `CORS_CREDENTIALS`
- `SLEEP_BEFORE_SHUTDOWN_MS`, `FORCE_SHUTDOWN_TIMEOUT_MS` — graceful shutdown

## Project structure

- `src/common` — errors, RequestContext, AppErrorFilter, @Public()
- `src/config` — ConfigModule, AppConfigService
- `src/prisma` — PrismaModule, PrismaService
- `src/auth` — JWT + Local strategies, guards, login, me
- `src/health` — healthz, readyz, status, ReadinessService
- `src/metrics` — Prometheus MetricsService, MetricsInterceptor
- `src/users` — list users (example CRUD)
- `src/init-fastify.ts` — requestId, traceId, RequestContext, logging
- `src/init-swagger.ts` — Swagger setup
