# 📋 School ERP Portal — Task List

> **Project:** School-ERPB
> **Started:** 2026-09-10
> **Status:** Development — mock-data prototype (backend + web app)

> **Stack note:** Frontend uses **React + Vite** (web), backend uses **Express + mock data**.
> PostgreSQL/Prisma and TypeScript are planned but the active prototype runs on JS + in-memory mock stores (Supabase/Postgres swap-out points are documented in code).

---

## Phase 1 — Project Setup

- [x] Initialize project repository (Git + `.gitignore`)
- [x] Setup monorepo structure (frontend + backend folders)
- [x] Configure `.env` files for backend + frontend (never committed to git)
- [ ] Setup TypeScript for both frontend and backend *(JS used in the prototype)*
- [x] Install and configure ESLint/linter (oxlint on frontend; backend deps tracked in package.json)
- [ ] Setup PostgreSQL database — *replaced with mock in-memory stores*
- [ ] Setup Prisma ORM and define base schema — *mock stores used instead*
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
  - [x] Username + Password fields
  - [x] Password visibility toggle
  - [x] Forgot password info message ("Contact admin")
  - [x] Loading state + error display

---

## Phase 3 — Database Schema

> **Status:** Mock stores in `backend/src/mock/*` model all the relationships below.
> Real PostgreSQL + Prisma migration remains future work.

- [ ] `schools` table (id, name, logo, address)
- [ ] `classes` table (id, school_id, name, section)
- [ ] `students` table — **mock equivalent exists** (`src/mock/students.js`)
- [ ] `employees` table — **mock equivalent exists** (`src/mock/employees.js`)
- [ ] `attendance_students` table — **mock equivalent exists**
- [ ] `attendance_employees` table — **mock equivalent exists**
- [ ] `marks` table — **mock equivalent exists**
- [ ] `exams` table (id, class_id, name, date)
- [ ] `subjects` table (id, class_id, name)
- [ ] `timetable` table — **mock equivalent exists**
- [ ] `leaves` table — **mock equivalent exists**
- [ ] `payroll` table — **mock equivalent exists**
- [ ] `announcements` table — **mock equivalent exists**
- [ ] `holidays` table — **mock equivalent exists**
- [ ] `achievements` table — **mock equivalent exists**
- [ ] `documents` table — **mock equivalent exists**
- [ ] `syllabus` table — **mock equivalent exists**
- [ ] Run initial migrations — *N/A (mock)*

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
- [x] Timetable management: `GET/POST/DELETE /api/v1/admin/timetable`
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
- [x] Student management (list, add, edit, delete)
- [x] Employee management (list, add, edit, delete)
- [x] Attendance marking screen (students + employees)
- [x] Marks entry screen (per student/exam)
- [x] Timetable editor
- [x] Announcements editor
- [x] Holiday management
- [x] Leave approval screen
- [x] Syllabus upload screen — `POST/GET /admin/syllabus` + `AdminSyllabus.jsx` (class select, upsert, progress bars)
- [x] Achievements management — `GET/POST/DELETE /admin/achievements` + `AdminAchievements.jsx`
- [x] Document upload screen — `GET/DELETE /admin/documents` + `AdminDocuments.jsx` (per-employee records)
- [x] Password reset screen — `GET /admin/users` (sanitized) + `AdminUsers.jsx` (modal reset flow)

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
- [x] Setup audit log table for admin actions — `src/mock/audit.js` + router-level audit middleware on all admin mutations + `GET /admin/audit-log` (newest-first, 500-entry cap)
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
- [x] E2E tests: login flow (all roles) — `tests/e2e.test.js` (admin/teacher/accountant/student login → role-correct data)
- [x] E2E tests: student views data correctly — student journey: profile → attendance (summary) → marks → timetable → announcements
- [x] E2E tests: employee leave apply + admin approve flow — apply → pending visible → admin approve → `approved`; reject path → `rejected`
- [ ] Manual UI testing on Android — deferred (responsive CSS done; needs a real device/emulator)
- [ ] Manual UI testing on iOS — deferred (needs a real device/simulator)

**Result: 86 tests, 86 passing, 0 failures** — run with `npm test` (Node built-in test runner, zero extra dependencies). Testability refactor: `src/server.js` is now the entry point (`app.js` exports the app only) and attendance-summary logic was extracted to `src/utils/attendance.js` and wired into both attendance endpoints.

---

## Phase 12 — Deployment & Final Polish

- [x] Setup CI/CD pipeline — GitHub Actions (`.github/workflows/ci.yml`): backend `npm ci` + `npm test`, frontend `npm ci` + lint + build; Node 22 LTS with npm cache; runs on push/PR to master
- [ ] Deploy backend to staging environment
- [ ] Run full test suite on staging
- [ ] Configure production environment variables
- [ ] Deploy to production
- [ ] Monitor error logs post-launch

---

## Progress Tracker

| Phase | Status      | Notes             |
|-------|-------------|-------------------|
| 1     | In Progress | Setup done; TS/Postgres/Prisma deferred (JS + mock stores) |
| 2     | Done        | Auth, JWT, RBAC, rate limit, login UI       |
| 3     | Mock        | Schema modeled in mock stores; DB migration pending |
| 4     | Done        | All student APIs (mock)         |
| 5     | Done        | All employee APIs (mock); slip/doc downloads are client-side |
| 6     | Done        | Full admin API set added         |
| 7     | Done        | All student screens              |
| 8     | Done        | All employee screens             |
| 9     | Done        | All admin screens incl. syllabus/achievements/documents/users |
| 10    | Done        | Security hardening (RBAC audit, rate limits, audit log, HTTPS option, npm audit 0 vulns) |
| 11    | Done        | 77 tests passing (`npm test`): unit + integration + E2E; device UI testing deferred |
| 12    | In Progress | CI pipeline done (GitHub Actions); deployment pending |

---

*Last Updated: 2026-09-11 | Author: Agent*
