# 📋 School ERP Portal — Task List

> **Project:** School-ERPB
> **Started:** 2026-09-10
> **Status:** Development — mock-data prototype (backend + web app)

> **Stack note:** Frontend uses **React + Vite** (web), backend uses **Express + Prisma**.
> PostgreSQL is live on **Supabase** (`backend/.env` → session-pooler connection string): the Prisma
> migrations are applied (`backend/prisma/migrations/`, incl. `20260914210000_rollnumber_per_class`)
> and the idempotent seed is loaded. **All route modules now serve live Prisma data** — the JS mock
> stores remain only as seed fixtures (and one unit-test fixture).

---

## Phase 1 — Project Setup

- [x] Initialize project repository (Git + `.gitignore`)
- [x] Setup monorepo structure (frontend + backend folders)
- [x] Configure `.env` files for backend + frontend (never committed to git)
- [ ] Setup TypeScript for both frontend and backend *(JS used in the prototype)*
- [x] Install and configure ESLint/linter (oxlint on frontend; backend deps tracked in package.json)
- [x] Setup PostgreSQL database — hosted on **Supabase** (Postgres via pooler, `DATABASE_URL` in `backend/.env`); `prisma migrate deploy` applied `20260911223002_init`; verified `prisma migrate status` → up to date (docker-compose Postgres remains available for local dev)
- [x] Setup Prisma ORM and define base schema — `backend/prisma/schema.prisma` (19 models, enums match API strings, money as Int, `@db.Date` calendar dates, Postgres scalar lists) + idempotent seed (`prisma/seed.js`) that loads the mock data preserving existing ids; verified offline via `prisma validate` + `prisma generate` (all 19 model delegates present); backend image updated to generate the client at build and prune the CLI
- [x] Swap route services from mock stores to Prisma queries — all five route modules
  (`admin`, `auth`, `employees`, `school`, `students`) now query via the shared
  `src/services/prisma.js` client (singleton, with transparent retry for transient
  Supabase pooler errors on reads) and map rows back to the exact mock API shapes via
  `src/services/mappers.js`; verified by the full test suite (86/86 green).
  Roll-number uniqueness was corrected to be per class (`@@unique([classId, rollNumber])`,
  migration `20260914210000_rollnumber_per_class`) to match the class-scoped auto-generation.
- [x] Configure JWT auth library (jsonwebtoken)
- [x] Setup folder structure as defined in planning.md

---

## Phase 2 — Authentication Module

- [x] Design `users` table (mock store: id, username, password_hash, role, status)
- [x] Implement password hashing with bcrypt (10 rounds)
- [x] Build Login API (`POST /api/v1/auth/login`)
  - [x] Validate username + password
  - [x] Return JWT access token + refresh token
  - [x] Return role info (password_hash never returned)
- [x] Build Refresh Token API (`POST /api/v1/auth/refresh`)
- [x] Implement auth middleware (JWT on every protected route)
- [x] Implement RBAC middleware (role check per route)
- [x] Implement login rate limiting (max 5 failed attempts → 15 min lock)
- [x] Admin-only password reset API (`POST /api/v1/auth/reset-password` + `PUT /api/v1/admin/users/:id/reset-password`)
- [x] Build Login Screen (UI)
  - [x] Username + Password fields — leading icons no longer overlap the placeholder/typed text: the shared `components.css` icon rules were broken because `.has-icon .form-input` (descendant selector) never matched inputs that carry the class themselves, so the reserved 38px padding silently never applied; padding is now derived in `.input-wrapper` from `--icon-inset + --icon-size + --icon-gap` (12+16+10 = the intended 38px, same for the right-side eye toggle) and matches either markup form, so it holds if icon size or input padding ever change
  - [x] Password visibility toggle — now actually clickable: `.input-icon-right` had `pointer-events: none`, which swallowed the eye button's clicks; re-enabled only for `[role='button']` icons
  - [x] Forgot password info message ("Contact admin")
  - [x] Loading state + error display

---

## Phase 3 — Database Schema

> **Status:** Prisma schema migrated to Supabase Postgres and seeded with
> the mock dataset — tables are live and ids preserved. **All API routes now read/write
> live Prisma data; the mock stores are no longer served.**

- [x] `schools` table — *(school info is static config in the prototype; no table needed)*
- [x] `classes` table — Prisma `Class` (grade + section, unique pair; ids like `cls-10A` preserved)
- [x] `students` table — Prisma `Student` (mock equivalent `src/mock/students.js`), seeded
- [x] `employees` table — Prisma `Employee` (mock equivalent `src/mock/employees.js`), seeded
- [x] `attendance_students` table — Prisma `StudentAttendance`
- [x] `attendance_employees` table — Prisma `EmployeeAttendance`
- [x] `marks` table — Prisma `MarksEntry` (+ `Exam`)
- [x] `exams` table — Prisma `Exam`
- [~] `subjects` table — *no separate table; subjects live on timetable periods / syllabus / marks (matches mock)*
- [x] `timetable` table — Prisma `TimetablePeriod`
- [x] `leaves` table — Prisma `LeaveRequest` + `LeaveBalance`
- [x] `payroll` table — Prisma `PayrollRecord`
- [x] `announcements` table — Prisma `Announcement`
- [x] `holidays` table — Prisma `Holiday`
- [x] `achievements` table — Prisma `Achievement`
- [x] `documents` table — Prisma `EmployeeDocument`
- [x] `syllabus` table — Prisma `SyllabusEntry`
- [x] Run initial migrations — `20260911223002_init` applied to Supabase (`prisma migrate status` → up to date)

---

## Phase 4 — Student Module (Backend APIs)

- [x] `GET /api/v1/students/:id/profile`
- [x] `GET /api/v1/students/:id/attendance?month=&year=`
- [x] `GET /api/v1/students/:id/marks?examId=`
- [x] `GET /api/v1/students/:id/timetable`
- [x] `GET /api/v1/students/:id/achievements`
- [x] `GET /api/v1/school/announcements` *(path: `/school` instead of `/schools/:schoolId`)*
- [x] `GET /api/v1/school/holidays?month=&year=`
- [x] `GET /api/v1/students/:id/syllabus` *(path: `/students/:id` instead of `/classes/:classId`)*

---

## Phase 5 — Employee Module (Backend APIs)

- [x] `GET /api/v1/employees/:id/profile`
- [x] `GET /api/v1/employees/:id/attendance?month=&year=`
- [x] `POST /api/v1/employees/:id/leaves/apply`
- [x] `GET /api/v1/employees/:id/leaves`
- [x] `GET /api/v1/employees/:id/payroll?month=&year=`
- [~] `GET /api/v1/employees/:id/payroll/:month/slip` — *client-side text slip download (no PDF/cloud storage yet)*
- [x] `GET /api/v1/employees/:id/timetable`
- [x] `GET /api/v1/employees/:id/assigned-classes`
- [x] `GET /api/v1/employees/:id/documents`
- [~] `GET /api/v1/employees/:id/documents/:docId/download` — *client-side placeholder download (signed URLs are future work)*

---

## Phase 6 — Admin Module (Backend APIs)

- [x] Student CRUD: `POST/PUT/DELETE /api/v1/admin/students`
- [x] Class-grouped summaries: `GET /api/v1/admin/students/by-class` (derived aggregation over students + marks: counts, fee dues, avg/top %)
- [x] Bulk admissions: `POST /api/v1/admin/students/bulk` — CSV/XLSX parsed & validated server-side (multer + exceljs + csv-parse), atomic per-row/per-column errors, auto roll numbers per class/section, 200-row cap; JSON fallback kept
- [x] Employee CRUD: `POST/PUT/DELETE /api/v1/admin/employees`
- [x] Attendance management: `POST /api/v1/admin/attendance`
- [x] Marks upload: `POST /api/v1/admin/marks`
- [x] Bulk marks entry: `POST /api/v1/admin/marks/bulk` + `GET /api/v1/admin/marks/bulk-template` — long/tidy CSV/XLSX (one row per student per subject) parsed & validated server-side; rows matched by **RollNumber** (never by name), subjects are free text, re-uploads upsert instead of duplicating, single-transaction atomic rejection with per-row/per-column errors, 200-row cap; the downloadable template is generated by the same ExcelJS version that reads it back
- [x] Timetable management: `GET/POST/DELETE /api/v1/admin/timetable`
- [x] Payroll management: `GET /api/v1/admin/payroll` (every employee + full payment history, status **derived** from `paidOn`, never stored) · `PUT /api/v1/admin/payroll/:employeeId/:month` — upsert on the `employeeId+month` unique pair with `netSalary` **recomputed server-side** (a client-posted net is ignored), pending months only (paid months immutable → 409 `ALREADY_PAID`), deductions-exceed-earnings → 400 `INVALID_PAYROLL` · `POST /api/v1/admin/payroll/:employeeId/:month/mark-paid` — record payment with a `paidDate` (defaults to today UTC), requires an existing record (404) and refuses double-payment (409); covered by `tests/payroll.api.test.js` (9 tests: RBAC, derived statuses, validation, upsert, lock-after-pay)
- [x] Syllabus upload: `POST /api/v1/admin/syllabus`
- [x] Announcements: `GET/POST/PUT/DELETE /api/v1/admin/announcements`
- [x] Holidays: `GET/POST/DELETE /api/v1/admin/holidays`
- [x] Achievements: `POST/DELETE /api/v1/admin/achievements`
- [x] Document upload: `POST /api/v1/admin/employees/:id/documents`
- [x] Leave approval: `PUT /api/v1/admin/leaves/:id/status`
- [x] Password reset: `PUT /api/v1/admin/users/:id/reset-password`
- [x] Reports: `GET /api/v1/admin/reports/summary`

---

## Phase 7 — Student Section (Frontend Screens)

- [x] Student Home screen (greeting, date, cards grid)
- [x] Student Profile screen (read-only)
- [x] Attendance Overview screen (month calendar, color coding)
- [x] Marks / Progress Card screen
- [x] Timetable screen (tabular)
- [x] Syllabus screen (subjects + progress)
- [x] Holiday Calendar screen
- [x] School Circulars screen (list + detail view)
- [x] Achievements screen

---

## Phase 8 — Employee Section (Frontend Screens)

- [x] Employee Dashboard screen (quick-access shortcuts)
- [x] My Profile screen
- [x] Attendance screen (calendar + summary stats)
- [x] Leave Management screen (apply + history + balance)
- [x] Payroll screen (salary details + slip download)
- [x] Timetable screen
- [x] Assigned Classes screen
- [x] Announcements / Notices screen
- [x] Documents screen (list + download)

---

## Phase 9 — Admin Section (Frontend Screens)

- [x] Admin Dashboard (summary cards: students, employees, fee status)
- [x] Student management (list, add, edit, delete) — class rows open a **roster modal** (not inline expansion): dimmed backdrop, header stats + scrollable member table + "Add Student to this Class" footer, `Esc`/backdrop/✕ to close, focus trapped inside and returned to the triggering row; centered panel on desktop, full-height sheet on phones; shared `Modal` upgraded with focus trap, Esc handling and focus restore for every dialog in the app; search is a **plain live input** (no icon button — removed after it proved unreliable): debounced 400 ms as you type, refetching only the class-group list
- [x] Employee management (list, add, edit, delete) — `AdminEmployees.jsx` now opens with a **live search bar** (labelled input, `type="search"` for the native clear affordance) that filters the staff table as you type: case-insensitive substring across name, employee ID, department, designation, role, mobile, email and status, with the subtitle switching to "X of Y employees match …", a "No employees match …" empty state and zero extra requests (the endpoint already returns the full list)
- [x] Attendance marking screen (students + employees) — rebuilt as search → select → act: live class/staff-group search (results and counts derived from real data, never a fixed list), per-group roster with **local-only "Absent" toggles** and a live absent/present summary, one **atomic bulk confirm** (`POST /admin/attendance/bulk` — whole group in a single transaction, unknown-member rejection leaves no partial rows) with a **1-hour edit window** after each confirmation (`AttendanceConfirmation` table; later edits need the explicit override path), and a "Check student" month calendar rendered from saved records with prev/next navigation; Employees tab mirrors the flow grouped by designation
- [x] Marks entry screen (per student/exam) — `AdminMarks.jsx`: named subject rows for one student **plus** CSV/XLSX bulk upload (template download, per-row/column rejection list); every stat card, saved-marks table and total on the page is recomputed from the rows actually stored, never hardcoded
- [x] Timetable editor — rebuilt on the shared `Modal` pattern: **"+ Add Period"** opens a dialog (teacher dropdown is the real staff list from `GET /admin/employees` — name + designation, nothing hardcoded), fields validated client-side (positive unique period, valid `HH:MM` times, end > start, subject/teacher/room required), periods render **sorted by period number then start time**; before saving it detects conflicts — another period of the class overlapping the slot, or the chosen teacher already scheduled in a **different** class at the same time (half-open intervals, so back-to-back slots don't clash) — and shows the specific clashes in a `window.confirm` override; smart prefill (next free period number, 45-minute slot continuing after the last saved period)
- [x] Payroll screen — `GET /admin/payroll` + `AdminPayroll.jsx`: staff table (name, employee ID, department, designation, paid/pending counts, live substring search) opening a wide **history modal** (one row per month, status badge); per month the admin can **edit the salary components** (earnings vs deductions laid out like the employee portal, live net preview — the API recomputes the real net anyway), **mark the month paid** with a paid date, and **download the slip** (same text format the employee portal uses); paid months show no edit/mark-paid controls; a new month's form prefills from the latest existing month
- [x] Announcements editor
- [x] Holiday management
- [x] Leave approval screen
- [x] Syllabus upload screen — `POST/GET /admin/syllabus` + `AdminSyllabus.jsx` (class select, upsert, progress bars)
- [x] Achievements management — `GET/POST/DELETE /admin/achievements` + `AdminAchievements.jsx`
- [x] Document upload screen — `GET/DELETE /admin/documents` + `AdminDocuments.jsx` (per-employee records)
- [x] Password reset screen — `GET /admin/users` (sanitized) + `AdminUsers.jsx` (modal reset flow)
- [x] Collapsible navigation (shared layout — student, employee and admin) — a hamburger (☰) in the top bar toggles the sidebar: **pinned open with the content pushed** on desktop (≥1024px) and an **off-canvas drawer over a dimmed backdrop** on smaller screens (tap outside / `Esc` / the in-panel ✕ dismiss it). The open/collapsed state persists in `localStorage` so it survives navigation, and only desktop toggles are remembered — a drawer left open on a phone never turns off the pinned default. The toggle is a real button with `aria-expanded` + `aria-controls`, the closed panel is `visibility: hidden` (so it cannot trap keyboard focus), and the nav list, profile block and Sign Out are untouched (layout/interaction only)

---

## Phase 10 — Security Hardening

- [x] Audit all routes for missing auth/RBAC middleware — verified: every router mounts `authMiddleware`; `/admin/*` guarded by router-level `requireRole([ADMIN])`; student/employee routes enforce role + ownership (`linkedEntityId`) checks
- [x] Verify no secrets exist in codebase (`git grep` check) — clean; only intentional demo-credential hints in `Login.jsx` (prototype-only, remove before real users)
- [x] Confirm `.env` is in `.gitignore` — covered in root, `backend/`, and `frontend/` `.gitignore`; `git check-ignore` confirms both `.env` files are ignored and untracked
- [x] Enable HTTPS (SSL certificate) on server — optional in-app HTTPS via `TLS_KEY_PATH`/`TLS_CERT_PATH` (server auto-switches); production recommendation: terminate TLS at a reverse proxy
- [x] Add rate limiting middleware to all sensitive routes — login (5 fails/15 min), refresh (30 fails/15 min), and a general 300 req/15 min limiter on all of `/api/v1`
- [x] Verify all file downloads use signed URLs (not public links) — N/A: all downloads are generated client-side (CSV/print); no public file URLs exist
- [x] Sanitize all user inputs (zod/joi validation on every endpoint) — verified on all write endpoints incl. `/auth/refresh` (schema added); student/employee routes are GET-only, params validated server-side
- [x] Confirm passwords are never logged or returned in API responses — verified: login/reset responses omit hashes, `GET /admin/users` strips `passwordHash`, morgan logs request lines only, audit log never captures bodies
- [x] Setup audit log table for admin actions — router-level audit middleware on all admin mutations writes `AuditEntry` rows + `GET /admin/audit-log` (newest-first, reads the DB table)
- [x] Run `npm audit` — fix critical/high vulnerabilities — 0 vulnerabilities in backend and frontend
- [x] JWT secrets fail-fast — production startup throws if `JWT_SECRET`/`JWT_REFRESH_SECRET` missing; dev uses a labelled insecure fallback + warning

---

## Phase 11 — Testing

- [x] Unit tests: auth service (login, token, RBAC) — `tests/auth.test.js` (14 tests: login success/failure, JWT payload, `/me`, refresh incl. inactive-account rejection, RBAC 403s, password-reset flow, 404 envelope)
- [x] Unit tests: attendance calculation logic — `tests/attendance.test.js` (8 tests: student/employee month summaries incl. working hours, half-day weighting, holiday exclusion, empty/unknown-status safety)
- [x] Integration tests: student API endpoints — `tests/students.api.test.js` (15 tests: ownership 403s, 404s, attendance with computed summary, marks, timetable, achievements, syllabus)
- [x] Integration tests: employee API endpoints — `tests/employees.api.test.js` (15 tests: own/other profile access, attendance summary, leaves, payroll month filter, timetable by teacher, documents, apply-leave happy/validation/forbidden paths)
- [x] Integration tests: admin CRUD operations — `tests/admin.api.test.js` (20 tests: students/employees CRUD, attendance marking + upsert verification, marks publish, announcements, holidays, leaves approve/reject, users, audit log, RBAC denials)
- [x] Integration tests: bulk student upload — `tests/students.bulk.test.js` (9 tests: CSV/XLSX server-side parsing, header enforcement, per-row/per-column atomic validation, roll-number auto-generation, by-class summary re-read, RBAC denial)
- [x] Integration tests: bulk marks upload — `tests/marks.bulk.test.js` (12 tests: CSV/XLSX server-side parsing incl. real spreadsheet date cells, RollNumber matching, upsert instead of duplicate rows, per-row/per-column atomic rejection naming each failing row + column with no partial save, wrong header / missing file / bad extension / header-only / 200-row cap, in-file duplicate student+exam+subject guard, template sheets + template round-trip, manual single-student path, class-summary recompute, RBAC denial)
- [x] E2E tests: login flow (all roles) — `tests/e2e.test.js` (admin/teacher/accountant/student login → role-correct data)
- [x] E2E tests: student views data correctly — student journey: profile → attendance (summary) → marks → timetable → announcements
- [x] E2E tests: employee leave apply + admin approve flow — apply → pending visible → admin approve → `approved`; reject path → `rejected`
- [ ] Manual UI testing on Android — deferred (responsive CSS done; needs a real device/emulator)
- [ ] Manual UI testing on iOS — deferred (needs a real device/simulator)

**Result: 98 tests, 98 passing, 0 failures** — run with `npm test` (Node built-in test runner, zero extra dependencies). Testability refactor: `src/server.js` is now the entry point (`app.js` exports the app only) and attendance-summary logic was extracted to `src/utils/attendance.js` and wired into both attendance endpoints.

---

## Phase 12 — Deployment & Final Polish

- [x] Setup CI/CD pipeline — GitHub Actions (`.github/workflows/ci.yml`): backend `npm ci` + `npm test`, frontend `npm ci` + lint + build, Docker image builds for backend + frontend; Node 22 LTS with npm cache; runs on push/PR to master
- [x] Containerize for deployment — backend image (node:22-alpine, prod deps only, non-root `node` user, `/health` healthcheck), frontend multi-stage image (Vite build → nginx:1.27-alpine with SPA fallback + `/api` proxy so the app is same-origin), `docker-compose.yml` (Postgres 16 + volume + healthcheck provisioned for the Prisma migration, required-secrets wiring), `.env.docker.example` template
- [x] Perf hardening for ~1000 concurrent users — **Stage 1** (2026-09-15): `DATABASE_URL` → Supabase transaction pooler (6543) with `pgbouncer=true&connection_limit=10&pool_timeout=20` + new `DIRECT_URL` (session pooler) wired into `schema.prisma` for migrations; `compression` middleware on Express (new dep); nginx gzip + `no-cache` on `index.html` in the frontend image; request logging gated behind `LOG_LEVEL` (prod default `warn` → no access logs, no stack traces; `debug` opts in); server timeouts (`requestTimeout` 30s / `headersTimeout` 70s / `keepAliveTimeout` 65s > nginx 60s). Verified: `prisma validate` ok, full suite 107/107 green on the pooled connection, boot smoke test 200 + `Vary: Accept-Encoding`.
- [x] Perf hardening — **Stage 2** (2026-09-15): `GET /admin/students/by-class` rewritten to two lean queries (5-column `select` + `marksEntry.groupBy(_sum)`) — same response shape, DB-side aggregation instead of full-table row loads; deliberately **not** cached (bulk-marks flow re-reads it immediately). New `utils/cache.js` (in-memory TTL, prefix invalidation, no deps): `/school/options` class list cached 60s, `/school/summary` + `/admin/reports/summary` cached 30s, both invalidated by a single hook in the admin mutation middleware (+ leave-apply route). Bulk endpoints batched: attendance confirm now = 1 existence read + `createMany` + one `updateMany` per distinct status (~80 queries → ~3 for a 40-student class); marks bulk upload = 1 existence read + `createMany` + grouped `updateMany`s (200 sequential upserts → ~2–4 queries). Frontend: all 27 pages converted to `React.lazy` + `Suspense` (spinner fallback unchanged) — each page is now its own chunk, main bundle 347 kB/113 kB gzip. Verified: oxlint 0 errors, `vite build` ok with per-page chunks, full suite **107/107 green** on the pooled DB. Stage 3 (schema indexes + GIN, native bcrypt) pending review.
- [x] Perf hardening — **Stage 3** (2026-09-15): migration `20260915210000_perf_indexes` applied to Supabase via `prisma migrate deploy` (additive only, no data change): `@@index` on `LeaveRequest.employeeId`, `EmployeeDocument.employeeId`, `Achievement.studentId`, `TeachingAssignment.classId` (schema) + **GIN index on `Announcement.targetRoles`** (raw SQL — Prisma can't express scalar-list indexes) so the `targetRoles has role` filter on every announcements read is index-backed. `bcryptjs` → **native `bcrypt` v6** (same `$2a/$2b` hash format — existing password hashes verify unchanged; login CPU work moves off the event loop); backend Dockerfile gains python3/make/g++ for the alpine source build (removed post-install). Verified: `migrate deploy` ok + `prisma validate`, full suite **107/107 green**. All three stages done — load test (autocannon, hot endpoints, before/after p99) next.
- [x] Load test — before/after (2026-09-15; autocannon 7 + a deterministic SQL-count harness, both against the live Supabase pooler): **caching is the dominant win** — `/school/summary` uncached 17–28 req/s, avg 284–353 ms, p99 3.8–6.2 s (4–5 × HTTP 503 under pool pressure) → cached **10,583–11,556 req/s, avg 0.1–0.2 ms, p99 1 ms, 0 errors** (~400–620× throughput, p99 ~4000× lower); `/school/options` 42 ms → 0 ms per hit and `/admin/reports/summary` 133 ms → 0 ms per hit, each 5–6 SQL statements → 0. **Bulk attendance batching** (measured inside always-rolled-back transactions, so no data changed): a 9-student class went 12 → 5 SQL statements (851 ms → 435 ms), i.e. ~53 → 5 for a 40-student class and ~267 → 5 for a 200-row marks group. **`/admin/students/by-class`** rewrite: wall-time neutral on the current 9-student seed data (p50 ~100 ms both, dominated by the ~70–120 ms round trip to the remote pooler) — its gain is structural (one aggregate row per student instead of every marks row, 5-column projection: 18 → 9 fields shipped) and grows with dataset size. **Operational note:** the Supabase transaction pooler caps `pool_size` at 15 clients and raises `EMAXCONNSESSION` ("max clients reached in session mode") when exceeded — keep `connection_limit` ≤ 10 per process and re-size the pool before running extra app instances. `/health` baseline (no auth, no DB): 8,327 req/s, p99 363 ms, 0 non-2xx at c=1000; higher-concurrency tiers (c≥25) produced local Windows-loopback socket resets, so only c≤10 tiers are reported as trustworthy.
- [x] Perf workstream re-verified on the final tree (2026-09-15, no code changes after the run): full suite **107/107 pass, 0 fail** (169 s, `node --test --test-concurrency=1` against the pooled DB), frontend `oxlint` **0 errors** (2 pre-existing `AuthContext` effect warnings) + `vite build` ok with all 27 pages as separate chunks (main 347.27 kB / 113.23 kB gzip), and a boot smoke test on a spare port (`/health` → 200, `Vary: Origin, Accept-Encoding`).
- [ ] Operational follow-ups before running more than one API instance: the TTL cache is **per-process** (`utils/cache.js`) — two instances each serve their own 30–60 s staleness window, so horizontal scale needs Redis; the Supabase transaction pooler caps `pool_size` at 15 clients, so raise it before adding instances (`connection_limit` ≤ 10 each). For load tests or a whole school behind one NAT IP, raise `API_RATE_LIMIT_MAX` (default 300 / 15 min) or the general limiter trips first.

- [ ] Deploy backend to staging environment
- [ ] Run full test suite on staging
- [ ] Configure production environment variables
- [ ] Deploy to production
- [ ] Monitor error logs post-launch

---

## Progress Tracker

| Phase | Status      | Notes             |
|-------|-------------|-------------------|
| 1     | Done        | Setup done; Supabase live (migrations + seed); mock→Prisma swap complete, 98/98 tests green |
| 2     | Done        | Auth, JWT, RBAC, rate limit, login UI       |
| 3     | Done        | Schema on Supabase + rollNumber per-class migration; routes fully Prisma-driven |
| 4     | Done        | All student APIs (mock)         |
| 5     | Done        | All employee APIs (mock); slip/doc downloads are client-side |
| 6     | Done        | Full admin API set added         |
| 7     | Done        | All student screens              |
| 8     | Done        | All employee screens             |
| 9     | Done        | All admin screens incl. syllabus/achievements/documents/users + bulk marks upload (CSV/XLSX + template); delete confirmations added; single `<Toaster/>` mount fixed so toasts actually render; collapsible hamburger sidebar (shared layout, state persisted) |
| 10    | Done        | Security hardening (RBAC audit, rate limits, audit log, HTTPS option, npm audit 0 vulns) |
| 11    | Done        | 116 tests passing (`npm test`): unit + integration + E2E; device UI testing deferred |
| 12    | In Progress | CI (GitHub Actions) + Docker/Compose incl. Postgres done; perf hardening for ~1000 concurrent users done (cache, batched writes, indexes, lazy chunks) with a before/after load test; admin Payroll (API + screen + 9 tests) and Timetable editor rework done; actual deploy pending |

---

*Last Updated: 2026-09-18 | Author: Agent*
