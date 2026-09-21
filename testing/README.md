# @fairflow/testing — shared backend test utilities (QA-CI T-026)

Single home for cross-service test helpers so every workspace writes specs the
same way. Import as `@fairflow/testing` (npm-workspace package, resolves to
`dist/` — **run `npm run build -w @fairflow/testing` before running specs that
import it**, or `npm run build:testkit` from the repo root, which builds
`@fairflow/shared` + `@fairflow/testing`).

Decision (open question §8.2 of QA-STRATEGY): test-utils live in a **dedicated
dev-workspace `testing`**, NOT inside `@fairflow/shared`. Rationale: keeps test
deps (`pg`, `mongodb`, jest types) out of the shared runtime package that every
domain ships to prod, and lets the harness depend on `@fairflow/shared` (metadata
builder) without a cycle.

## Test levels (see QA-STRATEGY.md §1)

| Level | What | IO | Nest DI | File suffix |
|---|---|---|---|---|
| **unit** | pure logic: mappers, guards-predicates, parsers, hash-chain | none | no | `*.unit.spec.ts` / `*.spec.ts` |
| **component** | a service/controller/consumer via `Test.createTestingModule`, boundaries mocked | none (mocked) | yes | `*.component.spec.ts` / `*.spec.ts` |
| **integration** | repository/module against REAL Postgres/Mongo | real DB | yes | `*.spec.ts`, self-skips without env |

A plain `jest` run executes unit + component everywhere. Integration blocks use
`describeIntegration` / `describeMongoIntegration`, which become `describe.skip`
unless `TEST_DATABASE_URL` / `TEST_MONGO_URL` is set — so the same `jest` command
runs all three levels: locally it skips integration (green without a DB), in CI
the `services:` + env turn them on. No separate jest-project/testRegex needed.

## Helpers

- `metadata.ts` — `buildGatewayMetadata(ctx)` / `buildServiceMetadata()`. Builds
  the gateway→domain gRPC `Metadata` EXACTLY as production
  (`buildGatewayOutboundMetadata` from `@fairflow/shared`) emits it:
  `x-service-api-key`, `x-user-id`, `x-project-id`, `x-request-id`, roles,
  permissions, visibility scope, base64 ABAC predicate. Domains trust this
  metadata (never a JWT/body), so specs must exercise handlers through it.
- `grpc.ts` — `grpcOk(value)`, `grpcError(code,msg)`, `mockGrpcService({...})`.
  Observable-returning stubs for injected `ClientGrpc` proxies; each method is a
  `jest.fn` for argument assertions.
- `factories.ts` — `defineFactory<T>(build)`, `uuid()`, `id(prefix)`, `nextSeq()`,
  `resetSeq()`, `FIXED_NOW`/`nowIso()`. One override/merge contract for
  domain-local entity factories.
- `db/prisma.ts` — `describeIntegration`, `createEphemeralDatabase()`,
  `withDatabase()`, `truncateTables()`. Each integration run gets its own
  throwaway `qa_infra_*` Postgres DB, dropped in `afterAll` — never mutates a
  stand DB.
- `db/mongo.ts` — `describeMongoIntegration`, `connectEphemeralMongo()`. Same
  throwaway-DB discipline for CRM domains.
- `box/load-domain-app.ts` — loads local control/gateway Nest apps from
  `src/application.js` (mirrored from `dist/` via `npm run sync:box-harness-js`).
  Do not hand-edit colocated `src/*.js`; do not load `.ts` under Jest (ts-jest
  breaks Nest ClientGrpcProxy outbound service metadata).

## Running

```bash
export PATH=/opt/node/bin:$PATH
export DATABASE_URL="postgresql://x:x@localhost:5432/x"   # dummy, for prisma generate

# once (or after changing shared/testing):
npm run build:testkit                     # builds @fairflow/shared + @fairflow/testing

# unit + component (integration self-skips):
cd control && npx jest                     # or: npm test -w control

# add integration (points at throwaway servers / CI services:):
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
export TEST_MONGO_URL="mongodb://localhost:27017"
cd control && npx jest
```

## Jest config

Every workspace's `jest` field is just `{ "preset": "<rootDir>/../..", "rootDir":
"src" }`, resolving the canonical `backend/jest-preset.js` (ts-jest, `.spec.ts`,
node env, coverage ignores). Change transform/testRegex there, once — not per
service.
