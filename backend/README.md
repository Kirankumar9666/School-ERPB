# School ERP API — Backend

Express 4 REST API for the School ERP portal. Live Prisma data over PostgreSQL
(Supabase in staging/production); the JS mock stores remain only as seed fixtures.

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the API (`src/server.js`) on `PORT` (default 5000) |
| `npm run dev` | Same, with `nodemon` auto-restart |
| `npm test` | Run the full test suite (`node --test`) — test database only |
| `npm run create-admin -- --username <name>` | Create the first admin (prompts for the password). Refuses if an admin exists unless `--force` |
| `npm run db:seed` | Demo seed — adds fixtures, **refused in production** |
| `npm run seed:fixture` | Fixture seed (wipes) — **test database only** |

## Layout

```
src/
  server.js        # entry point — binds app to HTTP/HTTPS
  app.js           # configured Express app (exported for tests)
  config/env.js    # all environment variables, fail-fast JWT secrets
  constants/       # role definitions
  middleware/      # auth (JWT), RBAC, rate limiters, admin audit
  mock/            # seed dataset source (consumed by prisma/seed.js and test fixtures, never at runtime)
  modules/         # routes: auth, students, employees, school, admin
  utils/           # response envelope, attendance calculations
tests/
  helpers.js       # boots the app on an ephemeral port + fetch utils
  auth.test.js     # login/tokens/RBAC/password reset
  attendance.test.js
  students.api.test.js
  employees.api.test.js
  school.api.test.js
  admin.api.test.js
  e2e.test.js      # cross-role lifecycle flows
```

## Testing

The suite uses Node's built-in test runner — no extra dependencies:

```bash
npm test           # everything
node --test tests/auth.test.js   # a single file
```

Each integration file boots a fresh app instance on an ephemeral port, logs in real users via the API, and tears the server down afterwards. Tests set `NODE_ENV=test`, which disables request logging and uses dev-fallback JWT secrets.

## Environment

Copy `.env.example` to `.env`. In production, `JWT_SECRET` and `JWT_REFRESH_SECRET` are required (the process refuses to start without them). Optional `TLS_KEY_PATH`/`TLS_CERT_PATH` enable in-app HTTPS; prefer terminating TLS at a reverse proxy.

## Demo credentials (dev/test fixtures only)

These come from the fixture/demo seed and exist **only** on a seeded
developer/staging database — never in production (the demo seed refuses
production, and a production database is created with `npm run create-admin`).

The seeded accounts are `admin`, `teacher`, `accountant` and `student`. Their
passwords are **not printed here on purpose** — they are well-known demo values
with no place in a document that might be skimmed next to a real deployment.
Read them from the single source, `src/mock/users.js`, which holds the bcrypt
hashes (the fixture login names and roles are listed there too). On a real
environment no demo account exists at all: create the first admin with
`npm run create-admin -- --username <name>` (§ Scripts above).
