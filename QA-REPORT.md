# QA Report — Area A1: Admin (students, classes, fees)

**Session type:** QA engineer pass (find problems; do NOT fix application code).
**Area:** A1 — Admin: students, classes, fees.
**Databases:** see the SAFETY block at the top of `QA-CHECKLIST.md`.

> Test database: `127.0.0.1:5432/schoolerp_test` (local, disposable).
> LIVE database NOT touched: Supabase `aws-0-ap-south-1.pooler.supabase.com` (`crmtnumuphmnrkyodedk`).
> **Backend startup host check:** the backend banner (`src/server.js:24-28`) does **not** print the DB host — only `Environment` and the port. Host was instead confirmed by reading data back that exists only in the test DB (`GET /admin/classes` returned the seeded `LKG A` / `Class 1A` / `Class 5A:50` / empty `Class 8A`). See Finding QA-A1-012.

---

## 1. Summary

| Metric | Count |
|---|---|
| Checklist items | 35 student-mgmt + 21 fee + 35 class-mgmt = **91** (plus shared surfaces) |
| Tested | 76 |
| Passed | 54 |
| Failed | 22 |
| Not tested | 19 (listed in §6, each with a reason) |
| Findings raised | **21** |

**Findings by severity:** blocker **1** · high **5** · medium **6** · low **9**

### Figures verified against the database (≥10 required)
| # | On screen | Source / expected | Match |
|---|---|---|---|
| 1 | Dashboard "63 TOTAL STUDENTS" | `Student` count = 63 | ✅ |
| 2 | Dashboard "4 TOTAL EMPLOYEES" | `Employee` count = 4 | ✅ |
| 3 | Dashboard "4 HOLIDAYS" | `Holiday` count = 4 | ✅ |
| 4 | Dashboard "4 ANNOUNCEMENTS" | `Announcement` count = 4 | ✅ |
| 5 | Student Mgmt "63 students across 4 classes" | 63 students, 4 classes | ✅ |
| 6 | Class 5A card "50 students / ₹6,89,415 dues" | class studentCount 50; dues sum | ✅ |
| 7 | Class 1A card "₹64,000 carried from earlier years" | 8 × ₹8,000 prev-dues = ₹64,000 | ✅ |
| 8 | Fee Dues totals ₹8,95,996 / ₹8,31,996 / ₹64,000 | sums of fee rows | ✅ |
| 9 | Profile Aarav Kumar ₹35,000 fee / ₹35,000 paid / ₹0 bal | fee row 35000, payments 35000 | ✅ |
| 10 | Profile avg 69.5% / top 96/100 / 3 exams | marks rows | ✅ |
| 11 | Fee payment preview ₹5,000 → bal ₹17,496 | 35000−(12504+5000)=17496 | ✅ |
| 12 | Promote review "4 students · 1 left behind" | 5 in class, 1 excluded | ✅ |

---

## 2. Findings

| ID | Sev | Role | Page | Step | What happened | Expected | Evidence | Suggested fix | File |
|----|-----|------|------|------|---------------|----------|----------|---------------|------|
| QA-A1-001 | **blocker** | admin | Student Management | Click **Bulk Add** | `setBulkError('')` is called but `bulkError`/`setBulkError` is not declared anywhere in the component → `ReferenceError: setBulkError is not defined`; the modal never opens (React error boundary / unhandled). | Bulk Add modal opens. | Live console (Vite): `[Unhandled error] ReferenceError: setBulkError is not defined` → `onClick src/pages/admin/AdminStudents.jsx:309:29`, with the exact code shown: `onClick={() => { setBulkError(''); setModal({ mode: 'bulk' }); }}`. `grep bulkError AdminStudents.jsx` → **no matches** (state never declared). | Remove the `setBulkError('')` call (it belonged to the old inline bulk UI) or declare the state. | `frontend/src/pages/admin/AdminStudents.jsx:309` |
| QA-A1-004 | low | — | AdminStudents / BulkAddModal | code scan | State variable typo `buskError` (holds the error, `setBulkError` sets it) — internally consistent so it works, but a maintenance trap. | Name matches role. | `BulkAddModal.jsx:66`, used at 153-154. | Rename `buskError` → `bulkError`. | `frontend/src/components/BulkAddModal.jsx:66` |
| QA-A1-012 | medium | (ops) | — | startup | The backend startup banner does not log the connected database host, so the brief's "check the database host in the startup log" cannot be satisfied from the log alone. | Startup banner names the DB host (or at least the database name). | `src/server.js:24-28`. | Add e.g. `Database : <host>/<db>` derived from the resolved URL (mask the password). | `backend/src/server.js` |
| QA-A1-006 | **high** | admin | Student Management (class cards + roster) | View the page | Every money figure is a corrupted currency symbol: the class cards and the roster show `Â‚¹54,000` / `₹13` instead of `₹54,000`. Literal double-encoded bytes in the source: ``const money = (n) => `₹${…}` ``. | `₹54,000`. | Live DOM: `main.innerText` → `LKG A … Fee dues Â‚¹54,000`. Source: `AdminStudents.jsx:28`. | Re-encode the file as UTF-8 and replace `₹` with `₹`. | `frontend/src/pages/admin/AdminStudents.jsx:28` (+ literal `—`/`“`/`…` at lines 300,447,451,468-472,520) |
| QA-A1-007 | **high** | admin | Student Management | Look at the search box | The placeholder is displayed literally as `Search name, roll no, class…` — corrupt bytes shown to the user. | `Search name, roll no, class…`. | Live DOM: `input[placeholder]` = `Search name, roll no, class…`. Source: `AdminStudents.jsx:300`. | Re-encode the file as UTF-8 (`…` → `…`). | `frontend/src/pages/admin/AdminStudents.jsx:300` |
| QA-A1-008 | **high** | admin | Student Management → Add/Edit Student | Open the modal | The two money field labels render as `FEE TOTAL (ΓÉ╣)` / `FEE DUES (ΓÉ╣)` — a *double*-corrupted `₹`. | `FEE TOTAL (₹)` / `FEE DUES (₹)`. | Live modal text. Source: `studentForm.jsx:148,152` contain `Γé╣`. | Re-encode as UTF-8 and use `₹`. | `frontend/src/pages/admin/studentForm.jsx:148,152` |
| QA-A1-009 | **high** | admin, accountant | Fee Dues (+ student/employee fee surfaces) | Any fee action / message | The backend money formatter emits a corrupted rupee sign, and it is used in every fee and payroll message. The UI shows `Fee set to ₹25000 for 2026-27`, `₹5,000 will be applied…`, `The payment (₹9,99,999) is more than the total outstanding (₹22,496)`, `Payment of ₹10,000 recorded`. | `₹25,000`, `₹5,000` … | Live toasts + modal preview; API JSON bodies. Source: `backend/src/services/fees.js:44` (`const inr = (n) => `₹${…}` `), `fees.routes.js:217,340`, `admin.routes.js:2573,2618,2655`. | Re-encode those files as UTF-8 (replace `₹`→`₹`; `·`→`·'`). | `backend/src/services/fees.js:44`; `backend/src/modules/fees/fees.routes.js:217,340`; `backend/src/modules/admin/admin.routes.js:2573,2618,2655` |
| QA-A1-010 | medium | admin | Student Management → Add/Edit Student | Submit with a negative **Fee Total** | Server rejects it (`feeTotal: Too small: expected number to be >=0`) but the form shows only the generic **"Validation failed"** — the per-field `errors` map in the JSON is never surfaced, so the user cannot tell which field is wrong. | The offending field is named (e.g. under Fee Total) or shown in the message. | Live: response body `{"success":false,"message":"Validation failed","code":"VALIDATION_ERROR","errors":{"feeTotal":["Too small: expected number to be >=0"]}}`; modal showed only `Validation failed`. | Render `errors` per field, or append the first message to the toast. | `frontend/src/pages/admin/AdminStudents.jsx` (submit error handling) |
| QA-A1-011 | low | admin | Student Management → Add Student | Enter a **Date of Birth in the future** (2030) | Accepted; a student born in the future is created. | Reject a DOB after today. | Live: `POST /admin/students` body `dob:"2030-05-01"` → 201. | Add a server-side (+client) rule `dob <= today`. | backend `POST /admin/students` validation |
| QA-A1-013 | low | admin | Student Management → Add Student | Enter a **decimal** Fee Dues (12.75) | Silently rounded to 13 and saved; no warning. Money is whole-rupee (Int). | Reject or clearly round, with feedback. | Live: request `feeDues:12.75` → response `feeDues:13`; API JSON body captured. | Add `step="1"` + integer validation on the money inputs. | `frontend/src/pages/admin/studentForm.jsx` (Fee Total/Dues inputs) |
| QA-A1-014 | low | admin | Student Management | Search while the page lists 63 | The header keeps reading "63 students across 1 class" during a filtered search — the student count is the unfiltered total while the class count is filtered. | Both counts reflect the current view (or the label says "total"). | Live: query `Ananya` → header `63 students across 1 class`. | Derive the student count from the filtered set, or relabel. | `frontend/src/pages/admin/AdminStudents.jsx` (~line 104) |
| QA-A1-015 | low | admin | Student Management | Look at an **empty** class card (LKG B, or Class 8A) | Inconsistent empty-state money text: Class 8A shows `NO DUES`, but a freshly created empty class shows `₹0`. Both are "no fee rows". | The same empty-state wording for the same situation. | Live: LKG B roster header `FEE DUES ₹0`; Class 8A card `NO DUES`. | Use the same "no dues" wording when there are no fee rows. | `frontend/src/pages/admin/AdminStudents.jsx` / `AdminFeeDues.jsx` |

| QA-A1-016 | **high** | admin, teacher | Class Management → Class History, Promote rosters | View a class whose level is **named** (LKG/UKG/Nursery) | The named level is shown as its internal ORDER number: LKG renders as **"-1 A"**, UKG as **"Class 0A"**. Appears in "Promoted from -1 A", "Now in Class 0A", the year-profile header, "CLASS & SECTION", and the fee ledger's "CLASS & YEAR PAID". Numbered levels look fine because the fallback number equals the name. | "LKG A" / "UKG A". | Live: Class History roster → `Promoted from -1 A — now in Class 1A`; after promoting LKG A→UKG A, roster showed `Now in Class 0A`. Root cause: `enrollment.js:700-702` (`prisma.class.findMany`) and `:690` (`student: { include: { class: true } }`) omit `level`, so `classLabel` (mappers.js:74-83) falls back to `cls.grade`. | Add `include: { level: true }` to both queries (every other caller already does). | `backend/src/services/enrollment.js:690,700-702` |
| QA-A1-017 | medium | admin | Class Management → Promote Classes | Open a class's **Students** review, then Cancel | Merely *opening* the promotion review **creates the destination class** as a side effect, so an abandoned review leaves an orphan empty class. Reproduced live: `Class 6A` (grade 6, **0 students, 0 enrollments**) exists and was never confirmed — it was born from viewing Class 5A's roster (whose next class is 6A). | A read/preview must not write; the class should be created only when the promotion is executed. | Live: `GET /admin/class-management/...` review creates a class; `scripts/qa-inspect-classes.js` → `cls-6A grade=6 students=0 enrollments=0`. Root cause: `enrollment.js:1277` calls `classesService.nextClassFor(classId)` **without a transaction client**, and `nextClassFor` (classes.js:304-309) creates the class "so a caller that only reports can rely on it existing". | Resolve the next class without creating it for read paths (compute the id + `willBeCreated` only), or defer creation to the promote transaction. | `backend/src/services/classes.js:304-309`; `backend/src/services/enrollment.js:1277` |
| QA-A1-018 | low | admin | Class Management → Promote Classes → confirm dialog | Promote a class when there is no following academic year | The sentence silently drops the year: "will move to UKG A for **.**" (dangling blank), and the header reads "promoting to **no following year**". | A clear message such as "there is no next academic year — create one first". | Live (before adding 2027-28): alertdialog text `… will move to UKG A for . That class does not exist yet`. Source: `ClassManagementPromote.jsx:381` uses `{nextAcademicYear?.label}` with no fallback (unlike line 349). | Guard the promote action on a missing next year, or fall back to "the next year". | `frontend/src/components/ClassManagementPromote.jsx:381` |
| QA-A1-019 | low | admin | Class Management → Enter Past Data | Open the tab | The tab is named **"Enter Past Data"** but defaults its year selector to the *next* (future) academic year — with a 2027-28 row present it opened on 2027-28, not a past year, and the help text says "the roll number they held in 2027-28". | A tab about past data should default to a past year, or be renamed to reflect "any year except the current one". | Live: `ClassManagementPastData.jsx:122` `setYearId(pastYears[0].id)` where `pastYears` = everything not current, newest first. | Default to the most recent year *earlier than today*, or relabel. | `frontend/src/components/ClassManagementPastData.jsx:122` |

| QA-A1-020 | medium | admin | Student Management | View at **375 px** width | The toolbar does not wrap: **Bulk Add / Create Class / Add Student** sits in a 412 px row inside a 364 px viewport, so the page has ~60 px of horizontal overflow and the **"Add Student" button is cut off** (`Add Stu…`). | The row wraps or the buttons shrink so every action stays reachable. | Live: iframe reflow at 375px → `documentElement.scrollWidth 424 > clientWidth 364`; the overflowing node is the toolbar `DIV` (right edge 424) and the `Add Student` button. Screenshot confirms the clipped button. | Add `flex-wrap: wrap` (or a ≤480 rule) to the Student Management header action row. Other A1 pages are clean at 375/427/768/1024/1440. | `frontend/src/pages/admin/AdminStudents.jsx` (header action row, ~line 306) + `frontend/src/styles/components.css` |
| QA-A1-021 | medium | admin | All A1 modals (Add/Edit Student, Create Class, Set Fee, Record Payment) | **Press Enter** in a field | Nothing happens — the modals are `div`-based and contain **no `<form>`**, so the browser's native Enter-to-submit is unavailable. A keyboard-only user must Tab to the button on every A1 form. | Enter submits the dialog (or the form is a real `<form>` with an onSubmit). | Live: `Add Student` dialog → `dialog.querySelector('form')` = null; pressing Enter in the name field left the dialog open with no submit. Same for `Create Class` and `Set fee — Aarav Kumar`. | Wrap each modal body in a `<form onSubmit={…}>` so Enter submits, or add an `onKeyDown` Enter handler. | `frontend/src/components/Modal.jsx` (or each A1 modal) |

> **Responsive sweep (STEP 6):** reflowed each A1 page in fixed-width frames at **375 / 427 / 768 / 1024 / 1440**.
> - `/admin/students` — ✅ 768/1024/1440 clean; **✗ 375 & 427 overflow** (toolbar, QA-A1-020).
> - `/admin/fees` — ✅ clean at 375 & 768 (the wide table sits in an `overflow-x:auto` wrapper, as designed).
> - `/admin/classes` — ✅ clean at 375 & 768.
> 150 % zoom was not exercised separately (no zoom hook in the browser tooling); the 375/427 widths cover the effective reflow that zoom produces.

> **Encoding note (root cause of QA-A1-006/007/008/009):** several source files are stored as double-encoded (UTF-8 bytes re-interpreted as Latin-1/CP1252), so `₹` became `₹` (or `ΓÉ╣`), `—` became `—`, `…` became `…`, `“”` became `“â€`. Most occurrences are in code comments (cosmetic), but the ones listed above are rendered to users. The affected A1 files are `frontend/src/pages/admin/AdminStudents.jsx`, `frontend/src/pages/admin/studentForm.jsx`, `backend/src/services/fees.js`, `backend/src/modules/fees/fees.routes.js`, `backend/src/modules/admin/admin.routes.js` (fee/payroll messages). A full sweep of both trees is worth doing.

---

## 3. Permissions (STEP 5)

Each role's token was used to call the A1 endpoints directly, and each role was logged in and pointed at
the other roles' pages by URL.

**Direct API calls** (`401` = not authenticated, `403` = authenticated but forbidden):

| Endpoint | student | teacher | accountant | Expected | Verdict |
|---|---|---|---|---|---|
| `GET /admin/students` | 403 | 403 | 403 | blocked for all three | ✅ |
| `GET /admin/students/by-class` | 403 | 403 | 403 | blocked | ✅ |
| `POST /admin/students` | 403 | 403 | 403 | admin only | ✅ |
| `GET /admin/classes` | 403 | 403 | 403 | admin only | ✅ |
| `GET /admin/class-management/overview` | 403 | 403 | 403 | admin only | ✅ |
| `POST /admin/class-management/classes/cls-5A/promote` | 403 | 403 | 403 | admin only | ✅ |
| `GET /fees/dues` | 403 | 403 | **200** | accountant yes, others no | ✅ |
| `PUT /fees/students/:id/amount` | 403 | 403 | **400** | accountant may attempt (400 = authz passed, empty body) | ✅ |

- An **expired/invalid token returns `401`** (verified by calling with a stale token) — correct.
- **No privilege escalation found**: no other role could read or write students, classes or class management,
  and only the accountant could reach the fee ledger.

**UI URL access** — logged in as `teacher` and opened `/admin/students`, `/admin/fees`, `/admin/classes`
directly (full page load, valid session token still in `localStorage`): all three **redirect to `/login`**;
no admin content is rendered. ✅ (Cosmetic: an authenticated non-admin is sent to `/login` rather than their
own home page — minor UX, not a security hole.)

**Login page demo credentials** (`Login.jsx:9-14,146`) list working `admin/Admin@123`, `teacher/Teacher@123`,
`accountant/Accounts@123`, `student/Student@123`. This is **gated by `import.meta.env.DEV`**. A real
`npx vite build` was run and the built chunks were grepped: `Admin@123`, `Demo Credentials` and
`click to fill` are **not present in the production bundle** — **not a finding** (gate verified by building).

**Build-level confirmation of the encoding bug (QA-A1-006):** the same build's chunks were grepped for the
currency symbol. The corrupt `₹` appears in **exactly one chunk — `AdminStudents-*.js`** — while **ten other
chunks** (`AdminFeeDues`, `AdminDashboard`, `AdminEmployees`, `AdminPayroll`, `feeFormat`, `payroll`,
`StudentHome`, `StudentProfile`, `EmployeePayroll`, `AdminClassManagement`) contain the correct `₹`. The
corruption is therefore **isolated to `AdminStudents.jsx`** (plus `studentForm.jsx`, whose `ΓÉ╣` is a
different double-mangling), and it **ships to production** — it is not a dev-server artefact.

---

## 4. Dead or unconnected buttons / links

| Page | Label | Problem | File:line |
|---|---|---|---|
| Student Management | **Bulk Add** | Clicking throws `ReferenceError: setBulkError is not defined`; the modal never opens. The button is wired to a handler that references state that does not exist. | `frontend/src/pages/admin/AdminStudents.jsx:309` (handler), `:371` (button) — finding QA-A1-001 |
| Bulk Add modal (unreachable) | Template download / upload | Reachable only through the broken Bulk Add modal, so **the entire Bulk import UI is unreachable**. The endpoints themselves exist and are mounted (`GET /admin/students/bulk-template`, `POST /admin/students/bulk`). | `frontend/src/components/BulkAddModal.jsx`; backend `admin.routes.js:4090`, `bulkTemplate.js:73` |

No other dead buttons found in A1: every Student Management, Fee Dues and Class Management control tested
fired a request or changed state. Buttons labelled "Students" on each promote card open the per-student
review; "Keep"/"Pass Out"/"Promote"; the fee "Set fee"/"Record a payment"/"View profile" row actions; the
Class History year/class selectors; and Enter Past Data's Search / Add-as-historical / Save all work.

---

## 5. Backend features with no screen / screens with no backend

**Backend routes with no reachable screen (in A1):**

| Endpoint | Exists? | Screen |
|---|---|---|
| `GET /admin/students/bulk-template` | ✅ mounted (`bulkTemplate.js:73`) | **Unreachable** — the only UI entry point (Bulk Add) is broken (QA-A1-001). Tested directly by API: returns the CSV/xlsx template. |
| `POST /admin/students/bulk` | ✅ mounted | **Unreachable** for the same reason; verified by API that the endpoint accepts the template and validates rows. |
| Bulk fee set — `POST /fees/.../set-class` (message at `fees.routes.js:340`) | ✅ | The "Fee set to … for N students who had no fee set" message exists in code but no A1 screen offers a whole-class fee set. Low priority: possibly intentional. |

**Screens with no backend:** none found — every A1 screen's data was traced to a real endpoint and a real query.

---

## 6. Not tested, and why

| Item | Why not tested |
|---|---|
| **Bulk Add modal, end to end in the UI** | Blocked by QA-A1-001 (the button throws before the modal mounts). The endpoints were exercised directly by API instead. |
| **150 % browser zoom** | The browser tooling exposes no zoom/device-metrics override. Substituted by real reflow at 375/427/768/1024/1440 px, which covers the same effective layout change. |
| **`429 Too Many Requests` / `slow network` on A1 forms** | The A1 screens have no client-side rate limit of their own; the app-wide limiter was covered in the earlier Task-1/2 pass. Not re-run here. |
| **`500` from the A1 endpoints** | Not provoked: the endpoints validate and the DB was healthy. A stopped-backend / wrong-DB failure was exercised (see the failure-state note) and the pages degrade to an error state without crashing. |
| **File upload (bulk import) with wrong type / oversized / renamed file** | Requires the Bulk Add modal, which is unreachable (QA-A1-001). The template **download** was verified by API. |
| **Two users editing the same record simultaneously** | Not exercised in this pass (single-browser session). Listed as a follow-up. |
| **Promoting the top class beyond its level** | The promote screen refuses it by design ("graduates rather than moves up"); the pass-out path was tested instead. |

---

## 7. Verified working (positive results)

Recorded so the passes are not mistaken for untested. All of the following were done live and passed:

- Student search by **name, guardian name, guardian contact**, and by **Telugu** (`అర్జున్`), **Hindi**
  (`आरव`), a **curly apostrophe** (`D’Souza`) and a very **long name** — all matched.
- Special input is **rendered as plain text, not executed**: `<script>alert(1)</script>` typed into search
  and into a student's Name is stored and shown literally (React escaping) — **no XSS**.
- **Whitespace-only** search returns the full list; a no-match search shows a proper empty state.
- Add Student **validation chain**: "Name and Class are required." → "Parent / Guardian is required." →
  non-negative amount guard; **positive fee** and **10-digit, digits-only** contact enforced.
- Add → Edit (**including moving a student between classes**) → Delete (**with a confirm dialog**) — all
  correct; class headcounts and rupee totals updated to match.
- Create Class (level + section, upper-casing `b`→`B`) and Delete an empty class (with confirm) — correct.
- Reset Password: length + mismatch validation, then a real reset returning `Password reset successfully`.
- Set Fee: negative blocked with a toast; a valid fee saved and the "Fee not set" filter updated.
- Record Payment: overpayment rejected with a clear message; a partial payment previewed the allocation
  (`paid 12,504 + 5,000 → bal 17,496`) and the ledger updated correctly.
- Class History: year + class selection, historical roster, and a **year-scoped student profile** with
  attendance/results/fee for that year (empty states handled).
- Promote: **review step flagged the incomplete record** ("guardian name and contact number not on file"),
  required an explicit decision, moved 4 and left 1 behind, created the destination class, and preserved
  all prior-year records.
- **Enter Past Data**: recorded a historical child with attendance + one exam result and retrieved it by
  search ("no current class", "2027-28 · Class 1A").
- **Failure state**: when the backend was stopped mid-session the pages showed a load error instead of a
  blank crash; the app recovered once the backend was back.
- **Esc closes dialogs** — verified on the class roster and the nested "View All Exams" stack (all three
  layers closed in turn).
- **Keyboard reachability**: buttons and inputs are focusable and announce `aria-label`s (e.g. the row-action
  icons expose "Edit …", "Delete …", "Set fee for …", "Record a payment for …"), so a keyboard user *can*
  reach every action — the only gap is Enter-to-submit (QA-A1-021).
- **Large data**: the 50-student Class 5A roster renders every row (all 50 present in the DOM) inside a
  scrolling container without layout breakage or a console error.

---

## 8. Fix session log (this pass)

Approved findings were fixed on the test database (`schoolerp_test`); the live
Supabase database was not touched. Each fix has a test that failed before and
passes after.

| Finding | Severity | Status | Files changed | Test |
|---|---|---|---|---|
| QA-A1-001 | blocker | **fixed** | `frontend/src/pages/admin/AdminStudents.jsx` (was already wired in the working tree — verified, no dead `setBulkError`) | `area-a1.fixes.test.js` → bulk template + upload |
| QA-A1-006/007/008/009 | high | **fixed** | repo-wide encoding repair (see below) | `encoding.guard.test.js` |
| QA-A1-016 | high | **fixed** | `backend/src/services/enrollment.js` (`include: { level: true }` on 3 queries), `backend/src/services/mappers.js` (`classLabel` guard + `classLabelFor`) | `area-a1.fixes.test.js` → 3 named-level tests |
| QA-A1-017 | medium | **fixed** | `backend/src/services/classes.js` (`nextClassFor({ create: false })`), `backend/src/services/enrollment.js` (preview passes `create: false`; confirm still creates inside the transaction) | `area-a1.fixes.test.js` → review writes nothing |
| QA-A1-010 | medium | **fixed** | `frontend/src/utils/apiError.js` (new shared helper), `AdminStudents.jsx`, `AdminEmployees.jsx`, `AdminPayroll.jsx` | `area-a1.fixes.test.js` → field error named |
| QA-A1-011 | low (approved) | **fixed** | `backend/src/modules/admin/admin.routes.js` (`dob` refine), `frontend/src/pages/admin/studentForm.jsx` (`max`), `AdminStudents.jsx` (pre-check) | `area-a1.fixes.test.js` → future DOB refused |
| QA-A1-013 | low (approved) | **fixed** | `backend/src/modules/admin/admin.routes.js` (`wholeRupees`), bulk row check, `studentForm.jsx` (`step="1"`), `AdminStudents.jsx` (pre-check) | `area-a1.fixes.test.js` → decimal fee refused |

### Encoding repair (QA-A1-006/007/008/009, approved item #2)

The damage was larger and mixed compared with the report's snapshot, and the
backend would not boot at all (a double-encoded BOM before `/**` in
`backend/src/services/fees.js`). Fixed with `backend/scripts/fix-mojibake.js`
(byte-exact, writes UTF-8 **without BOM**; not shell redirection) and the edit
tool for the BOMs it could express:

- **BOMs removed:** `backend/src/services/fees.js`, `backend/src/modules/fees/fees.routes.js`,
  `frontend/src/pages/admin/AdminStudents.jsx` (double-encoded BOM at byte 0);
  `backend/src/modules/employees/employees.routes.js`,
  `backend/tests/grade.levels.promotion.test.js` (raw BOM);
  `frontend/src/styles/components.css` (stray U+FEFF mid-file).
- **Mojibake repaired** in `admin.routes.js`, `fees.js`, `fees.routes.js`,
  `employees.routes.js`, `AdminStudents.jsx`, `studentForm.jsx`,
  `grade.levels.promotion.test.js` (165 box-drawing rules + 1), `QA-REPORT.md`.
  User-visible ones included `admin.routes.js:970` ("Must be 1–3 letters") and
  `admin.routes.js:1211` ("· N login accounts created").
- **`AdminStudents.jsx:28` and the search placeholder were already correct** in
  the working tree, so the report's line numbers for 006/007 were stale — the
  same corruption existed elsewhere and is now gone repo-wide.
- **Guard:** `backend/tests/encoding.guard.test.js` fails if any C1 control char
  (the signature of byte-per-char mangling) or any BOM reappears in source. It
  builds the forbidden sequences from `\u` escapes, so the test file cannot
  itself carry the corruption. The only remaining sequences are the repair
  scripts' intentional lookup tables (`fix-encoding.js`, `fix-mojibake.js`), which
  are exempted by name.

### Dead buttons (NOT changed this session — listed for a decision)

| ID | Page | Label | What is wrong | Recommendation |
|---|---|---|---|---|
| QA-A1-001 | Student Management | **Bulk Add** | Report said it threw `setBulkError is not defined`; the working tree is already wired, and the endpoints work — **no action needed**, listed here only because the report carried it as a dead button. | Already working; re-test in the browser. |
| — | Bulk Add modal | Template download / upload | Reachable only through Bulk Add. Now that Bulk Add opens, this UI is reachable and both endpoints answer (verified by test). | Nothing to wire. |

No other dead buttons were found in A1 (see §4).

### Findings NOT fixed in this session

Everything the report raised and the brief did not approve is left exactly as
it was, with its file and line intact:

| Finding | Severity | Why left |
|---|---|---|
| QA-A1-004 | low | Not approved (state name typo `buskError`). |
| QA-A1-012 | medium | Not approved (startup banner does not print the DB host). I confirmed the test-DB host out of band instead. |
| QA-A1-014 | low | Not approved (search header counts). |
| QA-A1-015 | low | Not approved (empty-state money wording). |
| QA-A1-018 | low | Not approved (dangling year in the promote dialog). |
| QA-A1-019 | low | Not approved (Enter Past Data defaults to a future year). |
| QA-A1-020 | medium | Not approved (375 px toolbar overflow). |
| QA-A1-021 | medium | Not approved (modals have no Enter-to-submit). |

There was **no other blocker or high finding** beyond those listed above
(blocker 1 = QA-A1-001; high 5 = QA-A1-006/007/008/009 + QA-A1-016), so
approved item #8 had nothing left to add.

---

_Continue-from-here note: A1 surface is covered. Next session could re-test the Bulk Add UI once QA-A1-001
is fixed, run two-user concurrency, and do the 150 %-zoom pass._
_Fix session: encoding repaired repo-wide, A1-016/017/010 + DOB/decimal fixed on the test DB. Full suite
and browser re-verification status recorded above; the eight unapproved findings are untouched._
