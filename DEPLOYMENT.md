# 🚀 Deployment Runbook — School ERP Portal

Practical steps for shipping the API + web app to **staging** and **production**,
plus the health checks and rollback rules that go with them.

Related files: `docker-compose.yml`, `.env.docker.example`, `backend/Dockerfile`,
`frontend/Dockerfile`, `backend/.env.example`, `.github/workflows/ci.yml`.

---

## 1. Topology

| Piece | Runtime | Notes |
|-------|---------|-------|
| Web app | nginx container (`frontend/Dockerfile`) | Multi-stage Vite build; serves the SPA with an `index.html` no-cache rule and immutable hashed assets; proxies `/api/` to the backend container so the browser sees **one origin** (no CORS). |
| API | Node 22 container (`backend/Dockerfile`) | `NODE_ENV=production`, non-root `node` user, production deps only, `/health` HEALTHCHECK, listens on 5000. TLS terminates at the reverse proxy by default (`TLS_KEY_PATH`/`TLS_CERT_PATH` exist as an alternative). |
| Database | **Supabase Postgres** | Migrations are applied from a trusted machine/CI, never from the app container (the production image deliberately has no Prisma CLI). |
| Bundled Postgres | `postgres:16-alpine` in compose | Only for the local/self-hosted stack. **Not used** when `DATABASE_URL` points at Supabase — start with `docker compose up -d --no-deps --build backend frontend` in that case. |

The same compose file serves a laptop, staging and production; the only thing
that changes is `.env.docker` (secrets + `DATABASE_URL` + `ALLOWED_ORIGINS`).

---

## 2. Environment variables

Two files, never committed (both are in `.gitignore`):

- `backend/.env` — used by the API process itself and by the release step.
  Template: `backend/.env.example`.
- `.env.docker` at the repo root — only the *containers*: compose interpolation.

```bash
cp .env.docker.example .env.docker   # then fill in the real values
```

| Variable | Environment | Behaviour if missing |
|----------|-------------|----------------------|
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | containers (`compose`) and `backend/.env` | Compose refuses to start (`${VAR:?}`). The API **also** fails fast at boot with `[config] JWT_SECRET is required in production` — and refuses to start if either secret equals a **known dev/test/template value** (the development fallbacks, the CI secrets, or the `change-me` / `your_...` placeholders below), because a published secret is no better than a missing one. |
| `DATABASE_URL` | same | Required. Pooled URL in staging/production: Supabase **transaction** pooler on port **6543** with `?pgbouncer=true&connection_limit=10&pool_timeout=20`. |
| `DIRECT_URL` | `backend/.env` / release machine only | Used by `prisma migrate deploy`. Point it at the session pooler (port 5432) or the direct host. |
| `ALLOWED_ORIGINS` | containers | Defaults to `http://localhost:8080`. Must be the real public origin in staging/production. |
| `LOG_LEVEL` | containers | Defaults to `warn` in production: startup + errors only, **no per-request logs**. `debug` adds morgan `combined` + stack traces — temporary diagnosis only. |
| `TRUST_PROXY` | containers / `backend/.env` | How many reverse proxies sit in front of the API. Unset/`0`/`false` → **off**: the socket address is `req.ip` and `X-Forwarded-For` is ignored (safe default; correct for a direct connection). `1` → one proxy (nginx/traefik/CDN in front of the app). `2` → two hops (CDN → load balancer → app), and so on. **Set this to the real number of proxies in staging/production**, or every user behind the proxy shares one `req.ip` and the per-IP limits treat the whole school as one client. Setting it too high lets a client forge `X-Forwarded-For` and dodge the limits, so it must be exact. |
| `API_RATE_LIMIT_MAX` | containers | Defaults to `300` requests / 15 min / **IP**. This now applies only to **anonymous** requests (no valid token); see `API_RATE_LIMIT_USER_MAX`. |
| `API_RATE_LIMIT_USER_MAX` | containers | Defaults to `3000` requests / 15 min / **logged-in user**. Authenticated traffic is keyed on the user, not the IP, so a whole school behind one NAT IP no longer shares a single bucket. Raise for heavier usage; lower to tighten. |
| `LOGIN_IP_MAX_ATTEMPTS` | containers | Defaults to `50` failures / 15 min / IP for `POST /auth/login`. Deliberately above the per-account limit so a shared school IP is not locked out by a few typos; it only stops one address hammering the endpoint. |
| `LOGIN_ACCOUNT_MAX_FAILURES` | containers | Defaults to `10` failures / 15 min / **username** for `POST /auth/login`. The per-account backoff: grinding one account is throttled from any IP without touching classmates. Successful logins are never counted. |
| `CHANGE_PASSWORD_MAX_ATTEMPTS` | containers | Defaults to `5` failures / 15 min / IP for `POST /auth/change-password`. Strict per-IP is safe here because the route already requires a token. |
| `PORT`, `FRONTEND_PORT` | containers | Defaults `5000` / `8080`. |

Generate real secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> **The API refuses to start in production** if `JWT_SECRET` or
> `JWT_REFRESH_SECRET` is missing *or* is still one of the shipped placeholder
> values (`change-me-to-a-long-random-string`, `change-me-to-another-long-random-string`
> from `.env.docker.example`; `your_super_secret_jwt_key_here`,
> `your_super_secret_refresh_key_here` from `backend/.env.example`) or the
> development/CI fallbacks. A `.env.docker` copied from the example and not
> edited fails closed instead of signing tokens with a public secret.

**Required variable names** (values are per-environment; this is the complete
list the app reads — everything else has a default):

| File | Variables |
|------|-----------|
| `.env.docker` (compose) | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `POSTGRES_PASSWORD` (local stack only), `LOG_LEVEL`, `TRUST_PROXY`, `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_USER_MAX`, `LOGIN_IP_MAX_ATTEMPTS`, `LOGIN_ACCOUNT_MAX_FAILURES`, `CHANGE_PASSWORD_MAX_ATTEMPTS`, `PORT`, `FRONTEND_PORT` |
| `backend/.env` (API + release machine) | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `DIRECT_URL`, `ALLOWED_ORIGINS`, `LOG_LEVEL`, `TRUST_PROXY`, `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_USER_MAX`, `LOGIN_IP_MAX_ATTEMPTS`, `LOGIN_ACCOUNT_MAX_FAILURES`, `CHANGE_PASSWORD_MAX_ATTEMPTS`, `PORT` |

`DIRECT_URL` is release-machine-only (migrations); it is never a container
variable. `SUPABASE_URL` / `SUPABASE_ANON_KEY` and the `TLS_*` pair are optional
and unset by default.

**Exact deploy order** (staging / production):

1. `cd backend && npm ci && npx prisma migrate deploy && npm test` — pre-flight.
2. `npm run prisma:deploy` — apply migrations **before** the new build serves (§3.2).
3. `docker compose --env-file .env.docker up -d --no-deps --build backend frontend` — start (§3.3).
4. `npm run create-admin -- --username <name>` — **only on a fresh database** (§3.4).
5. `npm run smoke:staging -- --base-url https://<host>/api/v1` — verify (§3.5).

**Never run the demo seed against production.** `npm run db:seed` /
`npm run seed:demo` hard-refuses when `NODE_ENV=production` (it creates accounts
with well-known passwords), and the fixture seed additionally refuses any
database whose name does not contain "test".

---

## 3. Release procedure (staging / production)

> Run every step from the repo root on the release machine.

### 3.1 Pre-flight (must be green — CI enforces it on every push)

```bash
cd backend  && npm ci && npx prisma migrate deploy && npm test
cd frontend && npm ci && npm run lint && npm run build
```

The CI `backend` job runs the same three commands against a throwaway
`postgres:16` service container, then seeds it (`npm run db:seed`), then `npm run smoke:staging` (the
production-boot rehearsal) on top — so the release gate is executed on every
push, not just described here. The `docker` job builds both images and
interpolates compose against `.env.docker.example`.

### 3.2 Migrations — always before the new build serves traffic

```bash
cd backend
npm run prisma:deploy      # = prisma migrate deploy, idempotent
npm run prisma:status      # optional: "Database schema is up to date!"
```

- Migrations are **forward-only** and additive in this project; there are no
  down migrations, so a rollback of the app must still run against the new
  schema (see §6).
- Migrations never run inside the API container: the runtime image is pruned to
  production dependencies and has no `prisma` CLI. If the deploy host cannot
  reach the database directly, run this step from CI with `DIRECT_URL` set.

### 3.3 Build and start

```bash
# Bundled Postgres (single host / local staging)
docker compose --env-file .env.docker up -d --build

# External Supabase database (no bundled Postgres container)
docker compose --env-file .env.docker up -d --no-deps --build backend frontend
```

### 3.4 Create the first admin (a fresh database only)

A production database starts with **no users** — the demo seed refuses to run there
on purpose (it would insert accounts with well-known passwords), so the operator
creates the one account everything else flows from:

```bash
cd backend
npm run create-admin -- --username principal
# prompts for the password twice, hidden; never an argument, env var or file
```

- The password is checked against the **same complexity rule** the app's own
  password reset enforces (≥ 8 chars, upper + lower + digit).
- It **refuses if an admin already exists**, unless `--force` is passed.
- It runs against `DATABASE_URL`, including production — it is *not* blocked by
  the test-database guard (that guard is for *destructive* scripts; this only
  inserts one row).
- The account is created through `services/adminAccounts.js`, the same write
  path the app uses — there is no second way to make a user.

After this, the admin signs in and creates every other account (staff, students,
logins) from the admin panel. **Never run `npm run db:seed` / the demo seed
against production** — it is hard-refused there anyway.

### 3.5 Verify the deployment (read-only, safe against production)

```bash
cd backend
npm run smoke:staging -- --base-url https://staging.example.com/api/v1
```

Checks: `/health` returns `env=production`, helmet headers + no `x-powered-by`,
admin/teacher/student logins, `401` without a token, `403` for cross-role and
cross-student reads, gzip on JSON payloads, advertised rate-limit headers, the
API `404` envelope, and that an unknown CORS origin is not granted.

A bare origin (`--base-url https://staging.example.com`) works too — the
`/api/v1` prefix is filled in. **Order matters**: `/health` is probed on the
origin, so the frontend container must expose it (§1) before this passes.

Against a real environment the seeded demo accounts will not exist: supply the
credentials the target actually has, e.g.

```bash
SMOKE_ADMIN_USERNAME=principal SMOKE_ADMIN_PASSWORD='…' \
SMOKE_STUDENT_USERNAME=… SMOKE_STUDENT_PASSWORD=… \
SMOKE_STUDENT_ID=stu-2026-014 SMOKE_OTHER_STUDENT_ID=stu-2026-015 \
npm run smoke:staging -- --base-url https://staging.example.com/api/v1
```

`SMOKE_STUDENT_ID` must belong to the student account and `SMOKE_OTHER_STUDENT_ID`
must be a *different* real student — those two drive the data-scoping check.

Without a URL it instead rehearses the **production configuration path
locally**: it boots `src/server.js` with `NODE_ENV=production` on a free port
with freshly generated secrets, asserts the production log stream stays quiet
(no request logs, no errors), and asserts the fail-fast guard exits `1` when
the JWT secrets are absent.

### 3.6 Frontend build-time variable

`VITE_API_BASE_URL` is baked in at image build time and defaults to `/api/v1`
(nginx proxies it). Override only for a split-origin topology:

```bash
docker build -t school-erp-frontend --build-arg VITE_API_BASE_URL=https://api.example.com/api/v1 ./frontend
```

---

## 4. Post-deploy monitoring

| Signal | Command / endpoint | Expected |
|--------|--------------------|----------|
| Liveness | `curl -fsS https://staging.example.com/health` → `{ "success": true, "env": "production" }` | `200`; container HEALTHCHECK flips to `unhealthy` after 3 failed probes (30 s interval). |
| Container state | `docker compose ps`, `docker inspect --format '{{.State.Health.Status}}' <container>` | `healthy`. |
| API logs | `docker compose logs -f --tail=100 backend` | Startup banner only. In `warn` there are **no** per-request lines; `[ERROR]` and `[UNHANDLED-REJECTION]` lines are real incidents. |
| Temporary diagnosis | set `LOG_LEVEL=debug` in `.env.docker`, `docker compose up -d backend`, reproduce, then revert to `warn`. | Per-request `combined` logs + stack traces appear — never leave this on. |
| Admin actions | `GET /api/v1/admin/audit-log` (admin token) | Every admin mutation is recorded (who changed what, when). |
| Cache/pool pressure | `docker compose logs backend \| grep -i "max clients\|EMAXCONNSESSION"` | Nothing. If present, lower `connection_limit` per process (pooler caps at 15 clients). |

Smoke test on a schedule (cron/uptime monitor) is a cheap synthetic check —
it is read-only, so it can run against production. Two caveats:

- Each run spends **one** failure against the login limiter (per account: 10 per
  username / 15 min; per IP: 50 per IP / 15 min), so poll more often than your
  budget allows only with `SMOKE_SKIP_FAILED_LOGIN=1` — otherwise the monitor
  can lock accounts out for real users.
- It issues ~13 requests per run against the `/api/v1` limiter. Anonymous
  requests count against `API_RATE_LIMIT_MAX` (300 / 15 min / IP); the smoke
  test's own traffic is anonymous in the failed-login probe, so raise
  `API_RATE_LIMIT_MAX` if you poll aggressively from one IP.

---

## 5. Operational notes / known limits

- **Cache is per-process** (`backend/src/utils/cache.js`, TTL 30–60 s). Running
  more than one API instance means two instances each serve their own stale
  window: put Redis behind the cache (or drop to one instance) before scaling out.
- **Connection pool**: the Supabase transaction pooler allows 15 clients total;
  keep `connection_limit ≤ 10` per process and raise the pool tier before
  adding instances.
- **Rate limiting** is in-memory per process (same scaling caveat). The general
  API limit is keyed on the **logged-in user** (`API_RATE_LIMIT_USER_MAX`,
  default 3000 / 15 min) and falls back to **per-IP** (`API_RATE_LIMIT_MAX`,
  default 300 / 15 min) only for requests with no token — so a NAT-ed school no
  longer shares one bucket. `TRUST_PROXY` must be set correctly for `req.ip` to
  be the real client address behind a proxy.
- **Login limiting** is two-layered: per-IP (`LOGIN_IP_MAX_ATTEMPTS`, default 50)
  and per-account (`LOGIN_ACCOUNT_MAX_FAILURES`, default 10 failed logins per
  username). Both count failures only. `change-password` is a strict 5 per IP
  (`CHANGE_PASSWORD_MAX_ATTEMPTS`).
- **Migrations are additive**; the app must be able to run against the schema
  one release ahead.

---

## 6. Rollback

1. **App only** (bad build, same schema): redeploy the previous image/tag
   (`docker compose up -d --build` from the previous commit) — migrations are
   additive, so the older code still works against the newer schema.
2. **Schema**: there are no down migrations. Roll back by deploying a
   corrective *forward* migration (make the change nullable, restore the
   column, …) rather than editing a migration that is already applied.
3. **Config**: `.env.docker` changes take effect on `docker compose up -d`
   (a restart), not on file edit.

---

## 7. Verification status

| Environment | Status | Evidence |
|-------------|--------|----------|
| Local dev | ✅ (2026-09-21) | Backend suite **142/142 pass, 0 fail** (621 s, `node --test --test-concurrency=1` against the live Supabase pooler); frontend `oxlint` clean + `vite build` ok. |
| Local dev (test database) | ✅ (2026-10-15) | Backend suite **447/447 pass, 0 fail** (113 s, `node --test --test-concurrency=1` against the local `schoolerp_test` Postgres from `backend/.env.test`) — includes the new `tests/prod-secrets.test.js` (production refuses missing/known JWT secrets) and the extended smoke rehearsal (**16/16**, incl. the "known dev/test JWT secret → exit 1" check). Pre-deployment security audit (default accounts, secrets, CORS, headers/uploads/responses, DB/migrations/health) complete; live-DB counts unchanged after the run (`node scripts/counts.js compare`). |
| Production-mode rehearsal (local) | ✅ (2026-10-15) | `npm run smoke:staging` → **16/16 checks**. Covers the real production config path, `warn`-level log gating and the JWT fail-fast guard (missing secret **and** a known dev/test value both exit 1). |
| Smoke in `--base-url` mode | ✅ (2026-09-21) | Run against a separately started server as a deployed environment → **13/13 checks**, exit 0 (proves the deployed-target code path, incl. the root `/health` probe). |
| Staging host | ⏳ pending | Needs the host + secrets. Run §3.1–3.5, then paste the smoke output here. |
| Production | ⏳ pending | Same procedure after staging signs off; then keep §4 monitoring running for the first days. |

**Not verifiable on this machine** (no Docker engine installed here): the image
builds and `docker compose config` interpolation — both are exercised by the CI
`docker` job on every push, which is why that step was added.

Update this table (and `task.md` Phase 12) as each environment goes green.

