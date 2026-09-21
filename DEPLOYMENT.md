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
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | containers (`compose`) and `backend/.env` | Compose refuses to start (`${VAR:?}`). The API **also** fails fast at boot with `[config] JWT_SECRET is required in production` — in production a missing secret can never silently fall back to the dev secret. |
| `DATABASE_URL` | same | Required. Pooled URL in staging/production: Supabase **transaction** pooler on port **6543** with `?pgbouncer=true&connection_limit=10&pool_timeout=20`. |
| `DIRECT_URL` | `backend/.env` / release machine only | Used by `prisma migrate deploy`. Point it at the session pooler (port 5432) or the direct host. |
| `ALLOWED_ORIGINS` | containers | Defaults to `http://localhost:8080`. Must be the real public origin in staging/production. |
| `LOG_LEVEL` | containers | Defaults to `warn` in production: startup + errors only, **no per-request logs**. `debug` adds morgan `combined` + stack traces — temporary diagnosis only. |
| `API_RATE_LIMIT_MAX` | containers | Defaults to `300` requests / 15 min / IP. Raise it for a school behind one NAT IP or before a load test. |
| `PORT`, `FRONTEND_PORT` | containers | Defaults `5000` / `8080`. |

Generate real secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

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

### 3.4 Verify the deployment (read-only, safe against production)

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

### 3.5 Frontend build-time variable

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

- Each run spends **one** failure against the login limiter (5 per IP / 15 min),
  so poll more often than that only with `SMOKE_SKIP_FAILED_LOGIN=1` — otherwise
  the monitor locks the shared IP out for real users.
- It issues ~13 requests per run against the `/api/v1` limiter (300 / 15 min / IP).
  Raise `API_RATE_LIMIT_MAX` if you poll aggressively from one IP.

---

## 5. Operational notes / known limits

- **Cache is per-process** (`backend/src/utils/cache.js`, TTL 30–60 s). Running
  more than one API instance means two instances each serve their own stale
  window: put Redis behind the cache (or drop to one instance) before scaling out.
- **Connection pool**: the Supabase transaction pooler allows 15 clients total;
  keep `connection_limit ≤ 10` per process and raise the pool tier before
  adding instances.
- **Rate limiting** is in-memory per process (same scaling caveat) and keyed by
  client IP: `API_RATE_LIMIT_MAX` must be raised for a NAT-ed school or a load test.
- **Login lockout / limiter** counts only failures: 5 per 15 min per IP.
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
| Production-mode rehearsal (local) | ✅ (2026-09-21) | `npm run smoke:staging` → **15/15 checks**. Covers the real production config path, `warn`-level log gating and the JWT fail-fast guard (exit 1). |
| Smoke in `--base-url` mode | ✅ (2026-09-21) | Run against a separately started server as a deployed environment → **13/13 checks**, exit 0 (proves the deployed-target code path, incl. the root `/health` probe). |
| Staging host | ⏳ pending | Needs the host + secrets. Run §3.1–3.4, then paste the smoke output here. |
| Production | ⏳ pending | Same procedure after staging signs off; then keep §4 monitoring running for the first days. |

**Not verifiable on this machine** (no Docker engine installed here): the image
builds and `docker compose config` interpolation — both are exercised by the CI
`docker` job on every push, which is why that step was added.

Update this table (and `task.md` Phase 12) as each environment goes green.

