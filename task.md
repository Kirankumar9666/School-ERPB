# 📋 School ERP Portal — Task List

> **Project:** School-ERPB
> **Started:** 2026-09-10
> **Status:** Development — mock-data prototype (backend + web app)

> **Stack note:** Frontend uses **React + Vite** (web), backend uses **Express + Prisma**.
> PostgreSQL is live on **Supabase** (`backend/.env` → session-pooler connection string): the Prisma
> migrations are applied (`backend/prisma/migrations/`, incl. `20260918120000_syllabus_topic_completion`)
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
- [x] Admin-only password reset API (`POST /api/v1/auth/reset-password` + `PUT /api/v1/admin/users/:id/reset-password`) — both enforce complexity (min 8 chars with upper + lower case and a digit) via the shared zod rule, and both are covered by tests including RBAC (student 403), weak-password 400s, and proof the new password really logs in while the old one is rejected
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
- [x] `syllabus` table — Prisma `SyllabusEntry` — topics now stored per-topic as JSON `[{ topic, done }]` (migration `20260918120000_syllabus_topic_completion` backfilled existing rows with every topic not done); the subject-level completion % is **derived** (done / total), never stored
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
- [x] `GET /api/v1/employees/:id/payroll/:month/slip` — **server-generated PDF payslip (2026-09-21)**: `services/payslip.js` composes a print-ready A4 slip at request time entirely from the two live rows (employee profile + that month's PayrollRecord) — nothing hardcoded (names, IDs, amounts, dates and the paid/pending state are all read at generation time, so one template serves every employee and month); pdfkit with embedded DejaVu Sans TTFs (`src/assets/fonts`, subset on export) because the standard-14 PDF fonts are WinAnsi-encoded and cannot render ₹ (U+20B9); the palette mirrors the frontend design tokens. Served as `application/pdf` with `Content-Disposition` naming the file, CORS now exposes that header so the browser can read the filename cross-origin; the employee Payroll screen fetches the blob and saves it under the backend-chosen name (`utils/download.js`: `downloadBlob` + `filenameFromDisposition` + data-derived fallback `payslipFilename`)
- [x] `GET /api/v1/employees/:id/timetable`
- [x] `GET /api/v1/employees/:id/assigned-classes`
- [x] `GET /api/v1/employees/:id/documents`
- [~] `GET /api/v1/employees/:id/documents/:docId/download` — *client-side placeholder download (signed URLs are future work)*

---

## Phase 6 — Admin Module (Backend APIs)

- [x] Student CRUD: `POST/PUT/DELETE /api/v1/admin/students`
- [x] Class-grouped summaries: `GET /api/v1/admin/students/by-class` (derived aggregation over students + marks: counts, fee dues, avg/top %)
- [x] Auto-provisioned student logins (2026-09-21) — every student created through the admin surface (single "Add Student" **and** Bulk Add/Bulk Upload) gets a STUDENT login automatically via the new `services/studentAccounts.js` (`createStudentAccount`, called from both create paths in `admin.routes.js`): username = the student's full name lowercased with separator dots ('Sneha Reddy' → 'sneha.reddy'; non-alphanumeric runs collapse to a dot), collisions with ANY existing username resolved by a numeric suffix ('kavya.nair', 'kavya.nair.2', …) so the add/upload never fails over a username clash and never overwrites an existing account (User.username is @unique; the insert retries on P2002); initial password = the student's guardian contact exactly as stored (including the '+91-' prefix), bcrypt-hashed like any other — a deliberate, visible trade-off (documented in the service header and the UI), with the admin resetting the password from User Accounts (`PUT /admin/users/:id/reset-password`) after handing over the login. The UI states the initial password's source wherever the username is shown: the add/bulk success toasts ("initial password = guardian contact") and the Student Profile modal's Login Account section (username + initial password + reset hint, with an explicit empty state when no contact was on file). Covered by `tests/students.bulk.test.js` + `tests/admin.api.test.js` (bulk-created students get logins; single Add Student auto-creates the login, skipped without a contact)
- [x] Bulk admissions: `POST /api/v1/admin/students/bulk` — CSV/XLSX parsed & validated server-side (multer + exceljs + csv-parse), atomic per-row/per-column errors, auto roll numbers per class/section, 200-row cap; JSON fallback kept
- [x] Employee CRUD: `POST/PUT/DELETE /api/v1/admin/employees`
- [x] Attendance management: `POST /api/v1/admin/attendance`
- [x] Marks upload: `POST /api/v1/admin/marks`
- [x] Bulk marks entry: `POST /api/v1/admin/marks/bulk` + `GET /api/v1/admin/marks/bulk-template` — long/tidy CSV/XLSX (one row per student per subject) parsed & validated server-side; rows matched by **RollNumber** (never by name), subjects are free text, re-uploads upsert instead of duplicating, single-transaction atomic rejection with per-row/per-column errors, 200-row cap; the downloadable template is generated by the same ExcelJS version that reads it back
- [x] Timetable management: `GET/POST/DELETE /api/v1/admin/timetable`
- [x] Payroll management: `GET /api/v1/admin/payroll` (every employee + full payment history, status **derived** from `paidOn`, never stored) · `PUT /api/v1/admin/payroll/:employeeId/:month` — upsert on the `employeeId+month` unique pair with `netSalary` **recomputed server-side** (a client-posted net is ignored), pending months only (paid months immutable → 409 `ALREADY_PAID`), deductions-exceed-earnings → 400 `INVALID_PAYROLL` · `POST /api/v1/admin/payroll/:employeeId/:month/mark-paid` — record payment with a `paidDate` (defaults to today UTC), requires an existing record (404) and refuses double-payment (409); covered by `tests/payroll.api.test.js` (9 tests: RBAC, derived statuses, validation, upsert, lock-after-pay)
- [x] Syllabus upload: `POST /api/v1/admin/syllabus` — full-replacement upsert per (class, subject): `topics: [{ topic, done }]` (name 1–200 chars, explicit boolean `done`, 1–100 topics); there is **no** stored percentage anywhere — the admin and student clients derive completion from the done flags; `GET /admin/syllabus` returns normalized topics (legacy string-array rows → all not done); student `GET /students/:id/syllabus` returns the same shape; covered by `tests/syllabus.api.test.js` (7 tests: grouped shape, validation, per-topic persistence, full replacement, not-done defaults)
- [x] Announcements: `GET/POST/PUT/DELETE /api/v1/admin/announcements`
- [x] Circular scheduling (2026-09-20) — every announcement carries a show window (`showFrom`/`showUntil`, `DATE`, both inclusive): "Show from" left blank on create → the server defaults it to the school's real current date (`schoolToday()` in `services/mappers.js`, Asia/Kolkata, computed fresh per request — nothing hardcoded or cached); "Show until" is **required** and validated ≥ showFrom on POST and PUT (PUT may extend the window later, e.g. an exam-schedule notice). `GET /school/announcements` (shared by student Circulars + employee Notices) returns only rows with `showFrom ≤ today ≤ showUntil`, newest showFrom first (posted date tiebreak) — a circular disappears from every portal on its own once showUntil passes, no manual hiding. Admin list shows `Visible: 8 Sep 2026 → 15 Oct 2026` + a live Scheduled/Visible/Expired chip (display-only, recomputed each render) and an Edit-schedule modal. Migration `20260920120000_announcement_scheduling` backfills existing rows: showFrom = posted day, showUntil = posted day + 30 (nothing silently vanishes or stays forever during the migration; admins adjust per row). Covered by `tests/admin.api.test.js` (missing/reversed/malformed dates → 400, blank showFrom defaults to today, future window hidden → extend via PUT → visible, expired window stays hidden, showFrom-desc ordering)
- [x] Holidays: `GET/POST/DELETE /api/v1/admin/holidays`
- [x] Achievements: `POST/DELETE /api/v1/admin/achievements`
- [x] Document upload: `POST /api/v1/admin/employees/:id/documents` — plus the per-student mirror: `GET /admin/students/:id/documents` (newest first, strictly scoped), `POST /admin/students/:id/documents`, `DELETE /admin/student-documents/:docId` (deletes exactly one record by unique id — can never touch another person's records); new `StudentDocument` table (migration `20260918140000_student_documents`, mirrors `EmployeeDocument`); **PDF upload flow (2026-09-20):** both POST endpoints take multipart (`multer` memory storage, 5 MB cap, MulterError → 400), validate server-side (`.pdf` extension **+** `application/pdf` MIME **+** `%PDF-` magic bytes — a renamed .txt or forged blob is rejected "Only PDF files are allowed"), derive the stored `fileName` from the actual file (extension stripped, never admin-typed), and keep `type` as a quick-select category (Birth Certificate / ID Proof / Transfer Certificate / Report Card / Marksheet / Migration Certificate / Other) instead of the removed free-text input. UI: "Upload Document Record" form is now Category select + native `<input type="file" accept="application/pdf">` behind a "Choose File" label showing the picked file's name, inline "Only PDF files are allowed" error, button renamed **Upload → Confirm** (both tabs). Covered by `tests/documents.api.test.js` (upload paths reworked for multipart: RBAC, scoped listing, no-file / wrong-MIME / forged-magic-bytes rejection + file-derived stored name, scoped delete, employee surface regression)
- [x] Teacher class attendance (employee portal) — `GET /employees/:id/attendance/classes` (the teacher's markable classes, derived live from `TeachingAssignment` with live headcounts), `.../attendance/group?groupKey=&date=` (roster + saved statuses + edit-window state), `.../attendance/students?groupKey=` (roster for the "Check student" selector) and `POST .../attendance/bulk` (the same whole-group save). All four are `TEACHER_ROLES`-only. The shared rules live in `services/attendance.js` (`loadAttendanceRoster` / `saveBulkAttendance` / `teacherTeachesClass` / `teacherClassGroups`), which the admin router now calls too — teacher saves land in `StudentAttendance` + `AttendanceConfirmation`, so they are byte-identical to admin-entered data. **Scoping is server-side**: every entry point calls `assertOwnClass` → `teacherTeachesClass(employeeId, classId)` and returns 403 `FORBIDDEN` for a class the teacher isn't assigned, even when the id is posted directly; the read side is closed too (`GET /students/:id/attendance` now rejects staff reading a student outside their own classes, which previously let a teacher pull any class's records by naming its students). Covered by `tests/attendance.teacher.test.js`
- [x] Personal reminders (2026-09-20, all three portals) — new `Reminder` table (`userId`, `date DATE`, `title`; migration `20260920150000_reminders`, no seed data — reminders are always user-created). Private per-user CRUD at `GET/POST/DELETE /api/v1/school/reminders`, all scoped to `req.user.id` (delete's lookup includes `userId`, so another user's reminder → 404, never their data); list sorted soonest first. UI: one shared `AttendanceCalendarWithReminders` layout (calendar card + `ReminderSection`: date + title + Add + upcoming list with delete) renders in all three portals — Student Attendance, Employee "My Attendance" and the new admin **Calendar** page (`/admin/calendar`, sidebar item) whose compact month grid marks holidays (gold) and the admin's own reminders (accent dot) from real stored dates via `buildCalendar`. Shared `ReminderPopup` mounted once in `ProtectedLayout`: on portal load it reads the signed-in user's own reminders and — comparing each stored date against the **real current date** (`todayISO()`, nothing hardcoded) — shows a centered bell modal for a due reminder with a "Got it" dismiss; dismissal is recorded in `sessionStorage` keyed `${date}:${id}`, so the same popup stays quiet for the rest of that day but the reminder remains in the Upcoming list. Covered by `tests/school.api.test.js` ('reminders: private per-user CRUD' — validation, privacy, foreign-delete → 404, soonest-first ordering, owner delete). Student Attendance calendar shrank to the shared compact grid (`.calendar-grid.compact`, ~30px cells; the compact gold-dot holiday marker is scoped to `button` cells so attendance `holiday`-status divs keep their shade). The shared layout is styled by a dedicated `styles/components.css` block — `.att-layout` (calendar + a 280–360px reminder column, collapsing to one column ≤ 860px), `.att-legend`, and the `.rm-form` / `.rm-list` / `.rm-chip` (day-over-month chip, oxblood when due today) / `.rm-body` / `.rm-title` / `.rm-remove` rules — and the calendar's `loading` flag is **derived** from the settled request key rather than set inside the effect, so the component adds no lint warning (frontend stays at its 2 pre-existing `AuthContext` warnings, 0 errors)
- [x] Password reset: `PUT /api/v1/admin/users/:id/reset-password` — and `GET /admin/users` now actually applies the `mapUserPublic` mapper (it was imported but unused) and `include`s the student/employee relations, so each row carries `linkedEntityId`; without it the User Accounts screen had no way to match an account to the student/employee it belongs to (the raw row never exposed the link, since the FK lives on `Student.userId`/`Employee.userId`)
- [x] Reports: `GET /api/v1/admin/reports/summary`

---

## Phase 7 — Student Section (Frontend Screens)

- [x] Student Home screen (greeting, date, cards grid)
- [x] Student Profile screen (read-only)
- [x] Attendance Overview screen (month calendar, color coding)
- [x] Marks / Progress Card screen
- [x] Timetable screen (tabular)
- [x] Syllabus screen — same per-topic chips as the admin panel (green = done, outline = pending), progress bar and % derived live from the done flags; badge shows "Finished" at 100%
- [x] Holiday Calendar screen — compact redesign: small 30px cells in a centered max-420px card (no tall aspect-ratio squares), holidays marked with a gold date + dot under it (`.cal-day.compact.holiday` in index.css) instead of shading the whole cell; clicking a marked day opens the shared `Modal` with the holiday's name + full date from `GET /school/holidays` (the `Holiday` model has no description field, so none is shown), non-holiday days are plain non-clickable divs; Prev/Next month navigation unchanged; the old full-width grid + inline per-holiday list were removed — details are on-click only
- [x] School Circulars screen (list + detail view)
- [x] Achievements screen

---

## Phase 8 — Employee Section (Frontend Screens)

- [x] Employee Dashboard screen (quick-access shortcuts)
- [x] My Profile screen
- [x] Attendance screen (calendar + summary stats) — "My Attendance" now renders the **same shared layout as the student and admin portals** (`AttendanceCalendarWithReminders`), keeping only its own data: today's status card, the month stat row (Present / Absent / Late / Half Day / Working Hours, taken from the server's own month summary for the rows on screen), the compact month calendar painting every status the API can return (present/absent green·red, late + half-day gold, stored/school holidays shaded, today outlined) with per-day working hours in the cell tooltip, a legend matching that palette (`.badge-half-day` added) and the employee's personal reminder panel beside it — stacked calendar-first under 860px
- [x] **Mark Attendance tab (teaching staff)** — `EmployeeAttendance.jsx` now has top-level **"My Attendance" | "Mark Attendance"** tabs (same `.tabs`/`.tab-btn` pattern as the admin panel); "My Attendance" is the unchanged personal calendar/summary, and "Mark Attendance" renders the shared `MarkAttendance` component scoped to `GET /employees/:id/attendance/classes` — the classes that teacher is actually assigned. Search → select → give/check, tap-to-mark-absent toggles, live counts, one atomic confirm and the 1-hour edit window all behave exactly as in the admin panel because it is literally the same component and the same tables; a teacher with no classes gets an explicit empty state, and a failed load is distinguished from "no classes" with a Retry
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
- [x] Timetable editor — rebuilt on the shared `Modal` pattern: **"+ Add Period"** opens a dialog (teacher dropdown is the real staff list from `GET /admin/employees` — name + designation, nothing hardcoded), fields validated client-side (positive unique period, valid `HH:MM` times, end > start, subject/teacher/room required), periods render **sorted by period number then start time**; before saving it detects conflicts — another period of the class overlapping the slot, or the chosen teacher already scheduled in a **different** class at the same time (half-open intervals, so back-to-back slots don't clash) — and shows the specific clashes in a **stacked `ConfirmModal`** (gold warning icon, one highlighted list item per conflict pulled live from the real timetable, "Add Anyway"/"Cancel") that leaves the in-progress Add-Period form open and intact behind it; smart prefill (next free period number, 45-minute slot continuing after the last saved period)
- [x] No native browser dialogs anywhere — shared `components/ConfirmModal.jsx` (portal + centered panel, dimmed backdrop, gold `TriangleAlert` header, Cancel + action button with `danger`/`primary` tones, focus trap, Esc/backdrop/✕ to cancel) replaces every `window.confirm`/`window.alert`: the timetable's Schedule Conflict warning (stacked above the Add-Period form — z-index 120 vs 100, capture-phase keydown so Esc/Tab are consumed by the top layer only) and every destructive confirmation (delete student / employee / document record / achievement / announcement / holiday / timetable period), each with the record's real identity in the message and the delete executing only on confirm
- [x] Payroll screen — `GET /admin/payroll` + `AdminPayroll.jsx`: staff table (name, employee ID, department, designation, paid/pending counts, live substring search) opening a wide **history modal** (one row per month, status badge); per month the admin can **edit the salary components** (earnings vs deductions laid out like the employee portal, live net preview — the API recomputes the real net anyway), **mark the month paid** with a paid date, and **download the slip** (same text format the employee portal uses); paid months show no edit/mark-paid controls; a new month's form prefills from the latest existing month
- [x] Announcements editor
- [x] Holiday management
- [x] Leave approval screen
- [x] Syllabus upload screen — `POST/GET /admin/syllabus` + `AdminSyllabus.jsx`: every topic renders as a **chip** (soft-green stamp = done, neutral outline = not done) with the completion % **derived from the chips** (`done/total × 100`, rounded) shown as a progress bar — "100% — Finished" when every chip is green; the old manual "Completed (%)" input is gone entirely. **Edit** opens the shared modal (`Update "[Subject]" syllabus`): clicking a chip toggles done/not-done (local state only), a live "X% complete" badge + progress bar update instantly, Cancel discards and Save persists via the upsert; an **"Edit topic list"** section inside the same modal keeps renames/additions/removals possible (unchanged names keep their done state, renamed/added topics start not done); new subjects upload with all topics not done
- [x] Shared `ClassSelect` component (`components/ClassSelect.jsx`) — the one renderer for every admin "Select Class" dropdown (Syllabus + Timetable use it; Attendance/Students source the same `loadOptions()` data). Options always come from `GET /school/options` via `classChoices()` — never a local list. With zero classes it renders **disabled with "No classes found — add students first"** instead of a silently empty select, and a failed page load shows an explicit error empty-state with a **Retry** button (a dead API used to look exactly like "no classes" — the actual root cause of the empty Syllabus dropdown, the backend dev server was down); "No syllabus uploaded for this class yet" now only shows when a class IS selected
- [x] Achievements management — `GET/POST/DELETE /admin/achievements` + `AdminAchievements.jsx`
- [x] Document management screen — `AdminDocuments.jsx` rebuilt with **Students / Employees top-level tabs** (same `.tabs`/`.tab-btn` pattern as the Attendance page; only the active tab renders). **Students tab:** shared `ClassSelect` ("Choose a class…" placeholder, `GET /school/options` source) **side-by-side with a student search bar** (name or roll number, live-filtering the roster and scoped to the selected class — disabled with a "Choose a class first…" hint until a class is picked, cleared on class change) → live roster table (Roll No, Name from `GET /admin/students`) → clicking a row **collapses the table down to a compact selected-student summary card** (Roll No + Name on the soft-green tint, with a "Change student" button that restores the full table/search results) sitting directly above the "Documents — [Name]" section (file icon, name, type, upload date, delete) strictly scoped via `GET /admin/students/:id/documents`, with the per-student "Upload Document Record" form below; a class with zero students, a search with no matches and a person with zero documents each show clear empty states. **Employees tab:** live "Search employee by name…" over the real staff list → results table (Name, Role) → per-employee documents + upload form. Selecting a different class/student/employee or switching tabs clears the document view first (no stale records); deletes are confirmed and scoped to the exact record; a failed page load shows an error empty-state with Retry
- [x] Password reset screen — `AdminUsers.jsx` rebuilt with **Students / Employees top-level tabs** (same `.tabs`/`.tab-btn` pattern as Attendance and Documents; only the active tab renders), replacing the flat "All Users" table. **Students tab:** shared `ClassSelect` + a student search bar (name/roll number, live, scoped to the class — disabled with a "Choose a class first…" hint until a class is picked, cleared on class change) → live roster table → clicking a student **collapses to just that student's account row** (Name / Username / Role badge / Status badge / Reset Password, the original row layout) above a "Change student" control that restores the search results. **Employees tab:** live employee search (name or role) → results table (Name, Role) → same collapsed single-account view with "Change employee". Accounts are matched to people by `linkedEntityId`; a student/employee with **no** account shows "No account set up for [Name]" (account creation is out of scope — no such API). Any account not tied to a student or employee record (e.g. the admin, `linkedEntityId: null`) stays visible in a separate **"Other Accounts"** section below both tabs so no account type is lost. Every list is live (`GET /admin/users`, `/admin/students`, `/admin/employees`, `/school/options`); selecting a new class or person replaces the previous view entirely, and empty class/search/account states each render a clear message. **Reset Password behaviour is byte-for-byte the same flow** — this was a navigation/layout change only. **Per-row Reset Password buttons also live on the Students and Employees admin screens** (the KeyRound action next to Edit/Delete on each roster/employee row, only when that person has a linked account) — all three screens open the same shared `components/ResetPasswordModal.jsx` (new password + confirm-password fields, client-side min-8/upper/lower/digit validation mirroring the server's zod rule, real `PUT /admin/users/:id/reset-password` call, success toast "Password updated for [Name]" and inline server error display)
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

**Result: 142 tests, 142 passing, 0 failures** — run with `npm test` (Node built-in test runner, zero extra dependencies); the last full run (2026-09-20, live Supabase pooler) took 308 s at `--test-concurrency=1`. Testability refactor: `src/server.js` is now the entry point (`app.js` exports the app only) and attendance-summary logic was extracted to `src/utils/attendance.js` and wired into both attendance endpoints.

---

## Phase 12 — Deployment & Final Polish

- [x] Setup CI/CD pipeline — GitHub Actions (`.github/workflows/ci.yml`): backend `npm ci` + `npm test`, frontend `npm ci` + lint + build, Docker image builds for backend + frontend; Node 22 LTS with npm cache; runs on push/PR to master
- [x] Containerize for deployment — backend image (node:22-alpine, prod deps only, non-root `node` user, `/health` healthcheck), frontend multi-stage image (Vite build → nginx:1.27-alpine with SPA fallback + `/api` proxy so the app is same-origin), `docker-compose.yml` (Postgres 16 + volume + healthcheck provisioned for the Prisma migration, required-secrets wiring), `.env.docker.example` template
- [x] Perf hardening for ~1000 concurrent users — **Stage 1** (2026-09-15): `DATABASE_URL` → Supabase transaction pooler (6543) with `pgbouncer=true&connection_limit=10&pool_timeout=20` + new `DIRECT_URL` (session pooler) wired into `schema.prisma` for migrations; `compression` middleware on Express (new dep); nginx gzip + `no-cache` on `index.html` in the frontend image; request logging gated behind `LOG_LEVEL` (prod default `warn` → no access logs, no stack traces; `debug` opts in); server timeouts (`requestTimeout` 30s / `headersTimeout` 70s / `keepAliveTimeout` 65s > nginx 60s). Verified: `prisma validate` ok, full suite 107/107 green on the pooled connection, boot smoke test 200 + `Vary: Accept-Encoding`.
- [x] Perf hardening — **Stage 2** (2026-09-15): `GET /admin/students/by-class` rewritten to two lean queries (5-column `select` + `marksEntry.groupBy(_sum)`) — same response shape, DB-side aggregation instead of full-table row loads; deliberately **not** cached (bulk-marks flow re-reads it immediately). New `utils/cache.js` (in-memory TTL, prefix invalidation, no deps): `/school/options` class list cached 60s, `/school/summary` + `/admin/reports/summary` cached 30s, both invalidated by a single hook in the admin mutation middleware (+ leave-apply route). Bulk endpoints batched: attendance confirm now = 1 existence read + `createMany` + one `updateMany` per distinct status (~80 queries → ~3 for a 40-student class); marks bulk upload = 1 existence read + `createMany` + grouped `updateMany`s (200 sequential upserts → ~2–4 queries). Frontend: all 27 pages converted to `React.lazy` + `Suspense` (spinner fallback unchanged) — each page is now its own chunk, main bundle 347 kB/113 kB gzip. Verified: oxlint 0 errors, `vite build` ok with per-page chunks, full suite **107/107 green** on the pooled DB. Stage 3 (schema indexes + GIN, native bcrypt) pending review.
- [x] Perf hardening — **Stage 3** (2026-09-15): migration `20260915210000_perf_indexes` applied to Supabase via `prisma migrate deploy` (additive only, no data change): `@@index` on `LeaveRequest.employeeId`, `EmployeeDocument.employeeId`, `Achievement.studentId`, `TeachingAssignment.classId` (schema) + **GIN index on `Announcement.targetRoles`** (raw SQL — Prisma can't express scalar-list indexes) so the `targetRoles has role` filter on every announcements read is index-backed. `bcryptjs` → **native `bcrypt` v6** (same `$2a/$2b` hash format — existing password hashes verify unchanged; login CPU work moves off the event loop); backend Dockerfile gains python3/make/g++ for the alpine source build (removed post-install). Verified: `migrate deploy` ok + `prisma validate`, full suite **107/107 green**. All three stages done — load test (autocannon, hot endpoints, before/after p99) next.
- [x] Load test — before/after (2026-09-15; autocannon 7 + a deterministic SQL-count harness, both against the live Supabase pooler): **caching is the dominant win** — `/school/summary` uncached 17–28 req/s, avg 284–353 ms, p99 3.8–6.2 s (4–5 × HTTP 503 under pool pressure) → cached **10,583–11,556 req/s, avg 0.1–0.2 ms, p99 1 ms, 0 errors** (~400–620× throughput, p99 ~4000× lower); `/school/options` 42 ms → 0 ms per hit and `/admin/reports/summary` 133 ms → 0 ms per hit, each 5–6 SQL statements → 0. **Bulk attendance batching** (measured inside always-rolled-back transactions, so no data changed): a 9-student class went 12 → 5 SQL statements (851 ms → 435 ms), i.e. ~53 → 5 for a 40-student class and ~267 → 5 for a 200-row marks group. **`/admin/students/by-class`** rewrite: wall-time neutral on the current 9-student seed data (p50 ~100 ms both, dominated by the ~70–120 ms round trip to the remote pooler) — its gain is structural (one aggregate row per student instead of every marks row, 5-column projection: 18 → 9 fields shipped) and grows with dataset size. **Operational note:** the Supabase transaction pooler caps `pool_size` at 15 clients and raises `EMAXCONNSESSION` ("max clients reached in session mode") when exceeded — keep `connection_limit` ≤ 10 per process and re-size the pool before running extra app instances. `/health` baseline (no auth, no DB): 8,327 req/s, p99 363 ms, 0 non-2xx at c=1000; higher-concurrency tiers (c≥25) produced local Windows-loopback socket resets, so only c≤10 tiers are reported as trustworthy.
- [x] Perf workstream re-verified on the final tree (2026-09-15, no code changes after the run): full suite **107/107 pass, 0 fail** (169 s, `node --test --test-concurrency=1` against the pooled DB), frontend `oxlint` **0 errors** (2 pre-existing `AuthContext` effect warnings) + `vite build` ok with all 27 pages as separate chunks (main 347.27 kB / 113.23 kB gzip), and a boot smoke test on a spare port (`/health` → 200, `Vary: Origin, Accept-Encoding`).
- [x] Feature batch re-verified on the final tree (2026-09-20): backend full suite **142/142 pass, 0 fail** (308 s at `--test-concurrency=1`, live Supabase pooler); frontend `oxlint` **0 errors** (2 pre-existing `AuthContext` warnings — the new shared calendar component adds none) + `vite build` ok with `AdminCalendar` as its own chunk; a className↔CSS audit across every JSX file reports **0 class names without a rule** (the shared layout's `.att-*` / `.rm-*` styles were the last gap) and every `var(--token)` reference resolves to a defined custom property; live smoke test against the running dev servers — Vite transforms all four new modules (200 `text/javascript`) and the reminders API round-trips over HTTP as the seeded student (login → list → create → malformed date 400 → delete → gone, no leftovers).

- [x] Mobile responsiveness pass (2026-09-20) — **all 33 routes audited at 375 / 390 / 427 / 1440 px** with a headless-Chrome CDP harness (viewport crossings, parent overflows, clipped text, scroll containers). Fixes, all CSS-only inside the existing breakpoints (desktop pixel-identical): stat/info/overview grids stack 1-per-row ≤480; shared attendance layout stacks calendar-first ≤860; month calendar shrinks to fit 7 columns ≤430 with a `.cal-scroll` fallback wrapper; every wide table lives in `.table-wrapper` (thin always-styled scrollbar + scroll-edge shadows that appear only while content is cut off on that side + sticky first column), same for wide-modals; tables/inputs shrink padding ≤640; `form-grid-2`, form-groups, modals (full-height sheet ≤640), login sheet ≤480 all reflow; navbar title/date wrap instead of clipping. **Final audit: 0 viewport crossings at every phone width** (the only remaining flags are the by-design icon-rail items whose children keep their expanded x-position inside the 64px rail, and 4 table pages — student/employee marks & timetable, employee leave, admin employees roster — that scroll horizontally by design with the visible affordance). Desktop 1440 baseline: 0 crossings, 0 scroll containers, unchanged. Lint 0 errors / build ok after the pass. Rate-limit `429`s seen during the audit were the harness's own rapid requests, not app bugs.
- [x] Staging/production **release automation + verification** (2026-09-21):
  - `backend/scripts/staging-smoke.js` — read-only deployment smoke test (`npm run smoke:staging`). Two modes: `--base-url <host>/api/v1` probes a deployed environment, or bare it **rehearses the production path locally** by booting `src/server.js` with `NODE_ENV=production` on a free port with per-run generated secrets. 15 checks: `/health` env, helmet/`x-powered-by`, admin login + `/auth/me`, wrong password → 401, no-token → 401, student/teacher → admin route 403, cross-student read 403, JSON compression (Vary + gzip above the 1 kB threshold), rate-limit headers, API 404 envelope, CORS deny-by-omission, plus production-only assertions that the log stream stays quiet (no request logs, no errors) and that a missing JWT secret **exits 1** instead of using the dev fallback. Exit 1 on any failure. Verified live: **15/15** in rehearsal mode and **13/13** in `--base-url` mode against a separately started server.
  - `DEPLOYMENT.md` — runbook: topology (nginx same-origin proxy, API container, Supabase), required env matrix, release order (pre-flight → `prisma migrate deploy` → build/start → smoke), monitoring table, known scaling limits (per-process cache, pooler 15-client cap, in-memory rate limiting), rollback rules (additive migrations, forward-only fix).
  - `docker-compose.yml` — `DATABASE_URL` is now a required, environment-specific input (`${DATABASE_URL:?...}`) instead of a hard-coded compose-network URL, so the same file serves the bundled-Postgres stack and a Supabase-backed staging/prod stack; `LOG_LEVEL` (default `warn`) and `API_RATE_LIMIT_MAX` (default 300) are now tunable without rebuilding. `.env.docker.example` documents the pooled vs. direct URLs and how to generate secrets.
  - `.github/workflows/ci.yml` — **the backend job was silently unable to run**: it ran `npm test` with no database, but since the Prisma swap the suite requires a real Postgres (`DATABASE_URL` + `DIRECT_URL`). It now provisions a throwaway `postgres:16` service container, applies `prisma migrate deploy`, runs the suite, and then runs the production-boot rehearsal (`npm run smoke:staging`) against that database — so the release gate really executes on every push. The docker job additionally runs `docker compose --env-file .env.docker.example config -q`, so a missing/misnamed compose variable fails CI instead of the first real deploy.
  - `frontend/nginx.conf` — added `location = /health` proxying to the API: the public origin previously answered `/health` with the SPA's `index.html`, so an external uptime monitor would report "up" even with the API down.
  - `src/app.js` — CORS denials now use the cors package's deny-by-omission (`callback(null, false)`) instead of throwing: a disallowed `Origin` used to hit the global error handler as a **500 `SERVER_ERROR`** and log an `[ERROR]` line for every bot/scanner probe. The response now simply carries no `Access-Control-Allow-Origin` (browser blocks it), the status stays 200 and production logs stay clean — asserted by the smoke test.
  - Re-verified after the change: full suite **142/142 pass, 0 fail**; production rehearsal 15/15.


- [ ] Operational follow-ups before running more than one API instance: the TTL cache is **per-process** (`utils/cache.js`) — two instances each serve their own 30–60 s staleness window, so horizontal scale needs Redis; the Supabase transaction pooler caps `pool_size` at 15 clients, so raise it before adding instances (`connection_limit` ≤ 10 each). For load tests or a whole school behind one NAT IP, raise `API_RATE_LIMIT_MAX` (default 300 / 15 min) or the general limiter trips first.

- [~] Deploy backend to staging environment — *blocked on a host + real secrets (no staging host provisioned yet).* Everything else is ready: images build, compose takes the environment-specific `DATABASE_URL`, and the release order is written down (DEPLOYMENT.md §3: pre-flight → `prisma migrate deploy` → `up -d` → smoke).
- [~] Run full test suite on staging — *same blocker.* The post-deploy gate exists and is read-only: `npm run smoke:staging -- --base-url https://<staging-host>/api/v1` (13 checks incl. RBAC/scoping + rate-limit headers); the full 147-test suite still needs `DATABASE_URL` for the staging DB.
- [x] Configure production environment variables — contract is now enforced rather than remembered: `JWT_SECRET`/`JWT_REFRESH_SECRET` fail fast in `config/env.js` **and** `docker-compose.yml` (`${VAR:?}`), `DATABASE_URL` is required and environment-specific, `LOG_LEVEL` (default `warn` — no request logs) and `API_RATE_LIMIT_MAX` (default 300) are tunable without a rebuild. `.env.docker.example` documents every value (pooled vs. direct URL, secret generation); CI validates compose interpolation so a missing variable fails the pipeline, not the deploy.
- [x] Employee default salary structure — the Add/Edit Employee form gains a Salary / Compensation section (Basic Pay, HRA, Transport Allowance, Medical Allowance · Provident Fund, Professional Tax, TDS — the exact component set PayrollRecord stores, since the schema is a fixed 7-amount model, not an extensible line-item list) with non-negative whole-rupee inputs (shared AmountInput, negatives/junk stripped as typed), live Total Earnings / Total Deductions / Net Payable read-only totals and a deductions-cannot-exceed-earnings guard; a new migration adds the 7 `Int @default(0)` columns to Employee (additive, applied via migrate deploy), `employeeSchema`/`employeeDataFrom`/`mapEmployee` carry them and `GET /admin/payroll` now ships each employee's `defaultSalary` so a brand-new payroll month prefills from the saved structure instead of zeros (existing months and the latest-month prefill stay untouched — the form sets the default, the Payroll page still applies month-specific adjustments, paid months remain immutable and payslips read PayrollRecord as before); the component lists + ₹ formatter moved to shared `constants/payroll.js` used by both the employee form and AdminPayroll so labels can't drift; verified: migrate deploy ok + prisma validate, `tests/admin.api.test.js` + `tests/payroll.api.test.js` **29/29 pass**, frontend oxlint 0 errors (2 pre-existing warnings) + vite build ok
- [~] Deploy to production — *blocked on staging sign-off first* (rollback rules are documented in DEPLOYMENT.md §6; migrations are additive/forward-only).
- [~] Monitor error logs post-launch — *checklist ready, nothing to point it at yet*: container `healthy` state, `warn`-level log stream staying free of `[ERROR]`/`[UNHANDLED-REJECTION]`, `GET /admin/audit-log` for who-changed-what, pool-pressure grep, and a scheduled read-only smoke run (DEPLOYMENT.md §4).

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
| 11    | Done        | 142 tests passing (`npm test`): unit + integration + E2E; device UI testing deferred |
| 12    | In Progress | CI (GitHub Actions) + Docker/Compose incl. Postgres done; perf hardening for ~1000 concurrent users done (cache, batched writes, indexes, lazy chunks) with a before/after load test; admin Payroll (API + screen + 9 tests), Timetable editor rework and teacher "Mark Attendance" in the employee portal (shared engine + server-side class scoping, 6 tests), circular scheduling (per-announcement show window), personal reminders + the shared calendar/reminder layout across all three portals incl. the admin Calendar screen, student documents, per-topic syllabus completion and the shared Reset Password modal done; employee default salary structure (7 fixed components on the employee form, prefilled into each new payroll month via `defaultSalary`), server-generated PDF payslips (pdfkit + DejaVu fonts for ₹) and auto-provisioned student logins (username from name, initial password = guardian contact) done; release tooling + runbook done (read-only `smoke:staging` gate with a prod-boot rehearsal, `DEPLOYMENT.md`, required-env contract enforced in compose + CI, public `/health` proxy, CORS denial no longer a 500) — actual deploy still pending a host + secrets |

---

*Last Updated: 2026-09-21 | Author: Agent*
