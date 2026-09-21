# Local development

Everything runs on your machine: infrastructure in Docker, services with
`npm run start:<service>:dev`. No external stand is required.

For the full reference (migrations, seeds, per-service ports, observability)
see [README.md](README.md); this file is the short path to a running system.

## 1. Prerequisites

- Node.js >= 20.19
- Docker (Compose v2)

## 2. Infrastructure

```bash
npm install
npm run build:shared          # @fairflow/shared is a dependency of every service
npm run start:infra           # Postgres, Mongo, Redis, RabbitMQ, MinIO
```

`start:infra` copies `docker/.env.example` to `docker/.env` on first run. The
defaults there are local-only credentials — change them for anything shared.

Stop with `npm run stop:infra`, follow logs with `npm run infra:logs`.

## 3. Schema and seed data

```bash
npm run seed:all              # Postgres migrations + seeds, then Mongo seeds
```

This applies migrations for the `auth`, `control`, `gateway` and `billing`
schemas and loads demo data. Migration folder names must be unique across all
four schemas — two `..._init` directories break the second one.

## 4. Environment files

Each service ships a `.env.example`. Copy the ones you need:

```bash
cp auth/.env.example auth/.env
cp gateway/.env.example gateway/.env
```

Three values must line up before the gateway will talk to the domains:

| Variable | Where it comes from |
| --- | --- |
| `GATEWAY_SERVICE_API_KEY` | `SEED_GATEWAY_SERVICE_API_KEY` from the root `.env` (format `ak_…`) |
| `GATEWAY_API_KEY_ID` | written out by the seed step |
| `JWT_SECRET` | must be identical in `auth` and `gateway` |

## 5. Run the services

Start order matters — the gateway opens gRPC clients to the domains on boot,
so it goes last:

```bash
npm run start:auth:dev        # HTTP :3001, gRPC 5001
npm run start:control:dev     # :3002 / 5002
npm run start:contact:dev     # :3003 / 5003
npm run start:company:dev     # :3004 / 5004
npm run start:gateway:dev     # :3000 — last
```

gRPC ports for the remaining domains: pipe 5005, orders 5006, product 5007,
activity 5008, documents 5010, reports 5011, automation 5012, search 5013,
audit 5014, notification 5015, billing 5016, chat 5017. The authoritative list
is `gateway/.env.example` — the gateway is the caller.

You only need the domains your work actually touches. The gateway will log a
failed client for anything that is not running.

## 6. Developing one domain against the rest

Point the gateway at a local instance of the service you edit and leave the
others wherever they run (another shell, a shared dev host):

```bash
# in gateway/.env
AUTH_GRPC_URL=127.0.0.1:5001
```

Every domain has its own `*_GRPC_URL`, so the same trick works for any of them.

## 7. Databases

With `start:infra` the stores are on localhost with the credentials from
`docker/.env`:

- **Postgres** — `localhost:5432`, database `fairflow`. Schemas `auth`,
  `control`, `gateway`, `billing`. Domain tables are deliberately not in `public`.
- **Mongo** — `localhost:27017`, database `fairflow`. Used by 14 services:
  contact, company, pipe, orders, product, activity, platform, documents,
  reports, automation, search, chat, notification, audit.
- **MinIO** — console on `localhost:9001`.

## 8. Checks

```bash
npm run check                 # tsc --noEmit + eslint across workspaces
npm run test                  # jest
```

Single service: `cd auth && npm run check`. Single test:
`cd auth && npx jest -t "test name"`.
