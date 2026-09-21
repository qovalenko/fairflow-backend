# Fairflow Auth Service

OAuth 2.0, JWT, API keys; OIDC/SSO-ready. All auth data in PostgreSQL schema `auth` (not `public`).

## Run

```bash
cp .env.example .env   # set DATABASE_URL, JWT_SECRET, OAUTH2_ISSUER
npm install
npm run db:generate
npm run db:push       # create schema auth and tables
npm run db:seed       # admin / fairflow-app client
npm run start:dev
```

- Health: `GET /healthz`, `GET /readyz`
- Swagger: `GET /docs`
- OAuth2: `GET/POST /api/v1/oauth/authorize`, `POST /api/v1/oauth/token`, introspect, revoke
- API keys: `POST /api/v1/api-keys/introspect` (header `X-API-Key` or `Authorization: Bearer <key>`)
- OIDC discovery: `GET /.well-known/openid-configuration`
- Direct login: `POST /api/v1/auth/login`, `GET /api/v1/auth/me` (Bearer)

## Seed

- User: `admin` / `admin`
- OAuth2 client: `fairflow-app` / `client-secret`, redirects `http://localhost:3000/callback`, `http://localhost:5173/callback`

## Env

See `.env.example`. Required: `DATABASE_URL`, `JWT_SECRET` (min 32 chars in prod), `OAUTH2_ISSUER`.
