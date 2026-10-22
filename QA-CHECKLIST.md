# QA Checklist — Area A1: Admin (students, classes, fees)

**Session:** QA engineer pass. **Area:** A1 — Admin: students, classes, fees.
**Rule:** find problems, do not fix application code. Only test fixtures/scripts and the QA docs may be created/changed.

---

## Environment (safety)

| Item | Value |
|---|---|
| Live database — **MUST NOT TOUCH** | Supabase `aws-0-ap-south-1.pooler.supabase.com` (project `crmtnumuphmnrkyodedk`), from `backend/.env` → `DATABASE_URL` |
| Test database — **the one used here** | `postgresql://schoolerp_test:***@127.0.0.1:5432/schoolerp_test` (local, `backend/.env.test` → `TEST_DATABASE_URL`) |
| QA backend | `http://localhost:5100` — started with `DATABASE_URL`/`DIRECT_URL` = the test URL, `NODE_ENV=development`. **Verified** by reading the seeded QA school back through `/api/v1/admin/classes` (LKG A / Class 1A / Class 5A:50 / empty Class 8A) — data that exists only in the test DB. |
| QA frontend | `http://localhost:5173` — `npx vite --mode qa`, `frontend/.env.qa` sets `VITE_API_BASE_URL=http://localhost:5100/api/v1`. Verified in the built module. |
| QA seed | `backend/scripts/qa-seed.js` (run via `backend/scripts/qa-run.js` so it loads `.env.test`). Guarded by `assertSafeToWipe`. |

### QA seed contents (realistic + deliberately messy)
- 4 classes: **LKG A** (named level), **Class 1A**, **Class 5A (50 students)**, **Class 8A (0 students — empty on purpose)**.
- 63 students total. Messy on purpose: Telugu name (`అర్జున్ కుమార్`), Hindi name (`आरव शर्मा`), apostrophe (`Mohan D'Souza`), a 60-char long name, empty optional fields, **two students named "Ananya Reddy" with different guardians**, a student with no marks (`stu-nomarks`), a student with no fee row (`stu-lkg-004`).
- ~15 000 student-attendance rows (FN+AN, Saturdays included) across Jun→Mar.
- 5 exams, 751 marks rows; a prev-year undated backfill exam.
- Fees: current + previous year, partial payments, carried-forward dues.
- 4 employees: teacher **with** timetable (Priya Sharma), teacher **without** timetable (Suresh Babu), accountant, librarian. Payroll 2 months, one partial payment.
- User logins: `admin`/`Admin@123`, `teacher`/`Teacher@123`, `teacher2`/`Teacher@123`, `accountant`/`Accounts@123`, `librarian`/`Library@123`, `student`/`Student@123`, `student2`/`Student@123`, `student3`/`Student@123`.

---

## 1. Pages and routes in scope

| Page | Route | Source |
|---|---|---|
| Student Management | `/admin/students` | `frontend/src/pages/admin/AdminStudents.jsx` |
| Fee Dues | `/admin/fees` | `frontend/src/pages/admin/AdminFeeDues.jsx` (also `/employee/fees` for accountant) |
| Class Management | `/admin/classes` | `frontend/src/pages/admin/AdminClassManagement.jsx` |

### Shared components in scope
| Component | Used by | Source |
|---|---|---|
| Student Profile modal | Student Management, Fee Dues, Class History | `components/StudentProfileModal.jsx` |
| Create Class / Add Level modal | Student Management | `components/CreateClassModal.jsx` |
| Bulk Add modal | Student Management | `components/BulkAddModal.jsx` |
| Reset Password modal | Student Management (row) | `components/ResetPasswordModal.jsx` |
| Promote Classes tab | Class Management | `components/ClassManagementPromote.jsx` |
| Class History tab | Class Management | `components/ClassManagementHistory.jsx` |
| Enter Past Data tab | Class Management | `components/ClassManagementPastData.jsx` |
| Fee ledger table | Fee Dues, Profile modal, Promote | `components/FeeLedgerTable.jsx` |
| Student form fields | Student Management modal | `pages/admin/studentForm.jsx` |
| Attendance month calendar | Profile modal | `components/AttendanceMonthCalendar.jsx` |

---

## 2. Interactive-element inventory (click every one)

### 2.1 Student Management (`/admin/students`)
| # | Element | Type | Handler / action |
|---|---|---|---|
| S1 | Search box ("Search name, roll no, class…") | input | debounced re-fetch `/admin/students/by-class?q=` |
| S2 | **Bulk Add** | button | opens Bulk Add modal |
| S3 | **Create Class** | button | opens Create Class modal |
| S4 | **Add Student** | button | opens Add Student modal |
| S5 | Class card | clickable div | opens class roster modal |
| S6 | Class card (keyboard) | Enter/Space | opens roster (a11y) |
| S7 | Header summary "N students across M classes" | text | (display) |
| S8 | "not in a current class" hint | text | (display) |
| — | *Class roster modal* | | |
| S9 | **Delete class** | button | only when class has 0 students → confirm → `DELETE /admin/classes/:id` |
| S10 | **Add Student to this Class** | button | opens Add Student modal preset to the class |
| S11 | Row **View** (eye) | icon button | opens Student Profile modal |
| S12 | Row **Edit** (pencil) | icon button | opens Edit Student modal |
| S13 | Row **Reset password** (key) | icon button | opens Reset Password modal (only when `userId`) |
| S14 | Row **Delete** (trash) | icon button | confirm → `DELETE /admin/students/:id` |
| — | *Add/Edit Student modal* | | |
| S15 | Full Name | input | form field |
| S16 | Class | select | form field (from `/school/options`) |
| S17 | Section | select or readonly | form field |
| S18 | Roll Number | input | form field |
| S19 | Parent / Guardian | input | form field |
| S20 | Guardian Contact | phone input | form field |
| S21 | Admission Year | number input | form field |
| S22 | Blood Group | input | form field |
| S23 | Date of Birth | date input | form field |
| S24 | Fee Total | number input | form field |
| S25 | Fee Dues | number input | form field |
| S26 | Address | textarea | form field |
| S27 | **Save Student** | button | `POST /admin/students` or `PUT /admin/students/:id` |
| S28 | **Cancel** | button | closes modal |
| — | *Bulk Add modal* | | |
| S29 | Class | select | bulk scope |
| S30 | Upload spreadsheet | file input | `POST /admin/students/bulk` |
| S31 | **CSV** template | button | `GET /admin/students/bulk-template?format=csv` |
| S32 | **XLSX** template | button | `GET /admin/students/bulk-template?format=xlsx` |
| S33 | **Clear** file | button | clears chosen file |
| S34 | **Cancel** | button | closes |
| S35 | **Create a class** (when none) | button | closes modal |
| — | *Create Class modal* | | |
| S36 | Level | select | `POST /admin/classes` |
| S37 | Section | input | |
| S38 | **Create …** | button | `POST /admin/classes` |
| S39 | **Add a level** | button | opens Add Level modal |
| S40 | **Cancel** | button | closes |
| — | *Add Level modal* | | |
| S41 | Level name | input | `POST /admin/class-levels` |
| S42 | Position ("After X") | select | |
| S43 | **Add Level** | button | `POST /admin/class-levels` |
| S44 | **Cancel** | button | |
| — | *Reset Password modal* | | |
| S45 | New Password | password input | `PUT /admin/users/:id/reset-password` |
| S46 | Confirm Password | password input | |
| S47 | **Reset Password** | submit | |
| S48 | **Cancel** | button | |
| — | *Student Profile modal (from View)* | | |
| S49 | **Create login** | button | `POST /admin/students/:id/create-login` (only when no username + has contact) |
| S50 | **View All Exams** | button | opens nested All Exams modal |
| S51 | Month navigation in attendance calendar | buttons | reads `/students/:id/attendance` |
| S52 | **Close** | button | closes |
| — | *Nested All Exams modal* | | |
| S53 | **Close** | button | |

### 2.2 Fee Dues (`/admin/fees`)
| # | Element | Type | Handler / action |
|---|---|---|---|
| F1 | Filter **Has dues** | button | re-fetch `/fees/dues?filter=dues` |
| F2 | Filter **Fee not set** | button | `/fees/dues?filter=not_set` |
| F3 | Filter **All students** | button | `/fees/dues` |
| F4 | Search box | input | client-side filter |
| F5 | Stat cards (Current year unpaid / Previous dues / Total outstanding / Fee not set) | display | from `/fees/dues` totals |
| F6 | Row **previous dues** amount | button | expands inline ledger `/fees/students/:id` |
| F7 | Row **Set fee** (gear) | icon button | opens Set Fee modal |
| F8 | Row **Record payment** (banknote) | icon button | opens Payment modal (disabled when nothing due) |
| F9 | Row **View** (eye) | icon button | Student Profile modal |
| — | *Set Fee modal* | | |
| F10 | Amount (₹) | number input | `PUT /fees/students/:id/amount` |
| F11 | **Clear (not set)** | button | `PUT ... {amount:null}` |
| F12 | **Save fee** | button | `PUT ... {amount}` |
| F13 | **Cancel** | button | |
| — | *Payment modal* | | |
| F14 | Amount (₹) | number input | live preview `POST /fees/students/:id/allocate`; save `POST /fees/students/:id/payments` |
| F15 | Paid on | date input | |
| F16 | Note | input | |
| F17 | "Apply to a specific year instead" | button | toggles year select |
| F18 | Year select | select | |
| F19 | "Use oldest-first instead" | button | |
| F20 | **Record payment** | button | `POST /fees/students/:id/payments` |
| F21 | **Cancel** | button | |

### 2.3 Class Management (`/admin/classes`)
| # | Element | Type | Handler / action |
|---|---|---|---|
| C1 | Tab **Promote Classes** | tab button | |
| C2 | Tab **Class History** | tab button | |
| C3 | Tab **Enter Past Data** | tab button | |
| — | *Promote Classes tab* | | |
| C4 | Class card **Promote to …** | button | confirm → review screen |
| C5 | Class card **Mark as Passed Out** | button | confirm → `POST /class-management/classes/:id/pass-out` |
| C6 | Class card **Students** | button | opens per-student roster modal |
| C7 | Review **Confirm** checkbox per flagged row | checkbox | |
| C8 | Review **Leave behind** checkbox | checkbox | |
| C9 | Review **Confirm all N flagged** | button | |
| C10 | Review **Promote N students** | button | `POST /class-management/classes/:id/promote` |
| C11 | Review **Cancel** | button | |
| C12 | Roster row **Promote to …** | button | confirm → `POST /class-management/students/:id/move` |
| C13 | Roster row **Keep in …** | button | confirm → move `keep` |
| C14 | Roster row **Pass Out** | button | confirm → move `pass_out` |
| C15 | Roster row **Undo** | button | `POST /class-management/students/:id/undo` |
| C16 | Roster **Close** | button | |
| — | *Class History tab* | | |
| C17 | Academic Year | select | `GET /class-management/years/:id/classes` |
| C18 | Class | select | `GET /class-management/years/:id/classes/:cid/roster` |
| C19 | Row **View Profile** | button | Student Profile modal scoped to the year |
| — | *Enter Past Data tab* | | |
| C20 | Academic Year | select (past only) | `GET /class-management/years/:id/classes` |
| C21 | Class | select | |
| C22 | Search box | input | `GET /class-management/students/search` |
| C23 | **Search** | button | search |
| C24 | **Add them as a historical record** | button | → new-child form |
| C25 | Search result row **Select/Edit** | button | loads existing year record |
| C26 | New child Full Name / Roll / Guardian Name / Guardian Contact | inputs | |
| C27 | **Continue with this child** | button | |
| C28 | **Cancel** | button | |
| C29 | Roll No. for year | input | |
| C30 | Working Days / Days Present / Days Absent | number inputs | |
| C31 | Exam rows (name/subject/max/obtained) | inputs | |
| C32 | **Add another result** | button | |
| C33 | **Remove this result** | button | |
| C34 | **Save Historical Record** | button | `POST /class-management/historical-records` |
| C35 | **Change student** | button | resets subject |

---

## 3. Backend routes this area uses (for existence / method checks)

| Frontend call | Method | Backend route | File |
|---|---|---|---|
| `/admin/students/by-class` | GET | ✅ `GET /admin/students/by-class` | admin.routes.js:414 |
| `/admin/students` | GET | ✅ `GET /admin/students` | admin.routes.js:390 |
| `/admin/students` | POST | ✅ `POST /admin/students` | admin.routes.js:1225 |
| `/admin/students/:id` | PUT | ✅ | admin.routes.js:1303 |
| `/admin/students/:id` | DELETE | ✅ | admin.routes.js:1395 |
| `/admin/students/:id/create-login` | POST | ✅ | admin.routes.js:1440 |
| `/admin/students/bulk` | POST | ✅ | admin.routes.js:848 |
| `/admin/students/bulk-template` | GET | ✅ (separate router) | bulkTemplate.js:73 |
| `/admin/students/:id/documents` | GET | ✅ | admin.routes.js:3921 |
| `/admin/classes` | GET/POST | ✅ | admin.routes.js:604,636 |
| `/admin/classes/:id` | DELETE | ✅ | admin.routes.js:663 |
| `/admin/class-levels` | GET/POST | ✅ | admin.routes.js:709,737 |
| `/admin/class-management/*` | GET/POST | ✅ | admin.routes.js:2000-2290 |
| `/admin/users/:id/reset-password` | PUT | ✅ | admin.routes.js:4014 |
| `/fees/dues` | GET | (fees.routes.js) |
| `/fees/students/:id` | GET | (fees.routes.js) |
| `/fees/students/:id/amount` | PUT | (fees.routes.js) |
| `/fees/students/:id/allocate` | POST | (fees.routes.js) |
| `/fees/students/:id/payments` | POST | (fees.routes.js) |
| `/students/:id/profile` | GET | students.routes.js:83 |
| `/students/:id/marks`, `/attendance`, `/fees` | GET | students.routes.js |
| `/school/options` | GET | (school.routes.js) |

---

## 4. Circumstances to test (per the brief)

- Empty fields, 1 char, very long, spaces-only, special chars, quotes, emoji, Telugu/Hindi, `<script>alert(1)</script>`.
- Numbers: 0, negative, decimal, huge, letters-in-number.
- Dates: past, future, today, invalid, leap day, month end, year end, Sat/Sun, holiday, midnight, FN/AN.
- Repeated: double-click, submit twice, refresh mid-form, back after save.
- Empty states: empty class, student with no marks/fees/documents, teacher with no timetable.
- Large data: 50-student class, 200-row bulk upload, long lists.
- Failure states: backend stopped, slow, expired login, 401/403/404/429/500.
- Files: wrong type, empty, oversized, renamed; download every template/PDF.
- Time rules: attendance 1h edit window, marks 2-day window, announcement dates. *(A1-adjacent; only where a student/class/fee route is affected.)*
- Two users at once: two admins editing, two payment saves for same dues.
- Numbers on screen agree with the DB (≥10 cross-checks).
