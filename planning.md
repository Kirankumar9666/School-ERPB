# 🏫 School ERP Portal — Implementation Plan

## Overview

The **School ERP Portal** is a multi-role web/mobile platform that manages complete school operations — student academics, employee HR, timetables, announcements, admissions, and results.

> **Source Document:** `school_portal.md`
> **Project Directory:** `d:\Projects\School-ERPB`
> **Date:** 2026-09-10

---

## 👤 User Roles

| Role        | Description                                   |
|-------------|-----------------------------------------------|
| `admin`     | Full access — manages all data and settings   |
| `teacher`   | Employee role with class/subject responsibilities |
| `accountant`| Employee role with payroll/fee access         |
| `librarian` | Employee role with library access             |
| `student`   | Read-only access to own academic data         |
| `parent`    | Read-only access to their child's data        |

---

## 🔐 Authentication Module

### Features
- Login with **Username + Password**
- Password visibility toggle (never store passwords in plain text)
- Role-based access control (RBAC) after login
- "Forgot Password" → admin-only password reset flow (no self-service reset)
- Session token with expiry (JWT or secure session cookie)
- Failed login attempt throttling (max 5 attempts → temporary lock)

### Rules
- Passwords must be **hashed** (bcrypt / argon2) — never stored raw
- All API routes must validate the **auth token** before responding
- Role checks must happen **server-side**, never trust client-side role claims
- Sensitive routes (payroll, documents) require **re-authentication** or elevated checks

---

## 🎓 Student Section

### 1. Student Home
- Displays date, day, greeting (morning/afternoon/evening) based on time
- Profile photo
- Navigation: Home | Profile
- Overview cards (tappable, route to detail screens):
  - Attendance Overview
  - Syllabus
  - Marks (Progress Card)
  - Time Table
  - Announcements / Circulars
  - Achievements
  - Holiday Calendar

### 2. Student Profile
- Photo, Full Name, Class, Parent/Guardian Name, Contact, Address
- All fields are **read-only** — edits go through Admin only
- Display note: *"Contact your admin to update any details"*

### 3. Attendance Overview
- Month-wise calendar view
- Color coding:
  - Blue → Present
  - Red → Absent
  - Green → Holiday
- Data fetched per student per month from backend

### 4. Marks / Progress Card
- List of exams attended
- Per exam: Subject | Max Marks | Obtained | Percentage
- Formatted as a "School Progress Card"

### 5. Time Table
- Daily/weekly view: Period | Time | Subject | Teacher
- Tabular format

### 6. Holiday Calendar
- Month calendar highlighting public holidays
- Admin-managed — add/edit upcoming holidays

### 7. School Circulars
- Card list of announcements/events
- Tap to expand for full details

### 8. Achievements
- Organized list of awards, certificates, and accomplishments
- Admin-entered per student

---

## 👨‍💼 Employee Section

### 1. Dashboard
- Employee photo, name, ID, designation, department, status
- Today's date + school name
- Quick-access shortcuts:
  - My Profile | Attendance | Leave | Payroll | Timetable | Assigned Classes | Notices | Documents

### 2. My Profile
**Personal:** ID, Name, Gender, DOB, Blood Group, Mobile, Email, Address, Emergency Contact
**Professional:** Department, Designation, Qualification, Join Date, Experience, Reporting Principal, Employment Type

### 3. Attendance
- Today's status (Present / Absent / Late / Half-Day)
- Monthly calendar view
- Summary: Present Days | Absent Days | Late Entries | Half Days | Working Hours

### 4. Leave Management
- Apply Leave form (type, dates, reason)
- Leave history with status (Pending / Approved / Rejected)
- Balance tracker: Casual | Sick | Earned leave

### 5. Payroll
- Monthly salary details: Basic Pay | Allowances | Deductions | Net Salary
- Downloadable salary slip (PDF)
- Data is **read-only** for employees; only HR/Admin can modify

### 6. Timetable
- Daily + weekly teaching schedule
- Details: Period | Subject | Class | Section | Time | Room

### 7. Assigned Classes
- Class teacher assignment
- Subjects handled, student strength, classroom number

### 8. Announcements / Notices
- Staff meetings, holidays, exam schedules, circulars, event updates

### 9. Documents
- Secure file storage per employee:
  - Appointment Letter, ID Card, Salary Slips, Certificates, ID Proof, Bank Details
- Files served via **signed URLs** (not direct public links)

---

## 🏛️ Admin Section (Derived from Requirements)

> Admin is the central manager of all data. All create/update/delete operations flow through admin.

### Capabilities
- Manage Students (admissions, bio data, class assignment)
- Manage Employees (onboarding, profile, payroll setup)
- Mark/Edit Attendance (students + employees)
- Manage Time Tables per class
- Upload Syllabus per class/subject
- Post Announcements and Circulars
- Manage Holiday Calendar
- Upload/Manage Student Marks (per exam)
- Upload Employee Documents
- Reset Passwords (only admin can trigger)
- View Reports: Total Students, Total Employees, Fee Status, Results

---

## 🏗️ Technical Architecture

### Recommended Stack

| Layer       | Technology                              |
|-------------|-----------------------------------------|
| Frontend    | React Native (Expo) — cross-platform mobile |
| Backend     | Node.js + Express / NestJS              |
| Database    | PostgreSQL (relational, structured data)|
| Auth        | JWT (short-lived access + refresh tokens)|
| File Storage| Firebase Storage / AWS S3 (signed URLs) |
| PDF         | react-native-html-to-pdf / server-side  |
| State Mgmt  | Zustand / Redux Toolkit                 |
| API Style   | REST (versioned: /api/v1/...)           |

### Folder Structure (Backend)
```
src/
├── modules/
│   ├── auth/
│   ├── students/
│   ├── employees/
│   ├── attendance/
│   ├── marks/
│   ├── timetable/
│   ├── leaves/
│   ├── payroll/
│   ├── announcements/
│   ├── holidays/
│   ├── documents/
│   └── admin/
├── middleware/
│   ├── auth.middleware.ts
│   └── role.middleware.ts
├── utils/
└── config/
```

### Folder Structure (Frontend)
```
src/
├── screens/
│   ├── auth/
│   ├── student/
│   ├── employee/
│   └── admin/
├── components/
├── navigation/
├── services/        <- API calls only
├── store/
├── utils/
└── constants/
```

---

## 🔒 Security Rules

1. **No Hardcoded Secrets** — All API keys, DB credentials, and secrets go in `.env` files, never in code
2. **RBAC on every API** — Middleware validates role before processing any request
3. **Password Hashing** — Use `bcrypt` (min 10 rounds) or `argon2`
4. **JWT Security** — Short expiry (15–30 min access token) + Refresh token rotation
5. **Input Validation** — Validate and sanitize all inputs server-side (use `zod` / `joi`)
6. **SQL Injection Prevention** — Use parameterized queries / ORM (Prisma / TypeORM)
7. **File Upload Security** — Validate MIME type + file size; store in cloud, never in app server
8. **Signed URLs for Documents** — Private documents served via time-limited signed URLs
9. **Rate Limiting** — Apply on login and sensitive endpoints
10. **HTTPS Only** — No plain HTTP in production; enforce HTTPS redirect
11. **Audit Logs** — Log all admin actions (who changed what, when)

---

## 📋 Agent Coding Rules

> These rules apply to all code written for this project.

1. **No Hardcoding** — No hardcoded user IDs, class names, role strings in logic. Use constants/enums
2. **Config over Code** — All configurable values (school name, fee types, exam names) come from the database or config files
3. **Separation of Concerns** — Business logic in service layer, not in controllers or UI components
4. **API Versioning** — All endpoints under `/api/v1/`
5. **Error Handling** — All errors return consistent JSON: `{ success: false, message: "...", code: "ERROR_CODE" }`
6. **No Raw SQL** — Use an ORM or query builder; parameterized queries only
7. **Environment Variables** — All secrets in `.env`; never commit `.env` to git
8. **Reusable Components** — Build UI as composable, reusable components; no copy-paste screens
9. **Typed Code** — Use TypeScript throughout; no `any` types
10. **Documentation** — Every module/function must have a JSDoc comment explaining its purpose

---

## 🔗 Key Data Relationships

```
School
 ├── Classes (1 → Many)
 │    ├── Students (1 → Many)
 │    └── Timetable (1 → Many)
 ├── Employees (1 → Many)
 │    ├── Attendance
 │    ├── Leaves
 │    ├── Payroll
 │    └── Documents
 ├── Announcements (1 → Many)
 ├── Holidays (1 → Many)
 └── Exams → Marks (linked to Student + Class)
```

---

## Verification Plan

| Area                | Verification Method                                  |
|---------------------|------------------------------------------------------|
| Auth & Security     | Unit tests on login, token validation, RBAC checks   |
| Student Data        | Integration tests on attendance, marks, timetable APIs |
| Employee Module     | Integration tests on leave, payroll, documents       |
| Admin Operations    | E2E tests for CRUD operations                        |
| UI/UX               | Manual review + screenshots on Android & iOS         |
| Performance         | API response time < 500ms under normal load          |
| Security Audit      | Run npm audit; check for exposed secrets             |

---

*Last Updated: 2026-09-10 | Author: Agent*
