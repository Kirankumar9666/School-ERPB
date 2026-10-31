# Final Class & Graduation — Testing Handoff

**For:** Nithin, Rahul
**Build under test:** `master` @ `eb48b48` (supersedes `7e17046`; see §7)
**Reported by:** engineering
**Date:** 31 October 2026

---

## 0. Read this first

1. **Test against the test database only.** The backend must be started with the overrides in §4. Without them it opens the **live** school database.
2. **The one previously known defect (F1, §7) is fixed in this build.** It is now a test case (C3) that must **pass**, not a defect to avoid. If you are reading an older copy of this document, or are on `7e17046`, you are on the broken build.
3. **Exact wording matters.** Several checks are about which sentence and which button name appears. Quote what you saw.

---

## 1. What the feature is, in plain language

- A school marks **one class level** as its **final class** (e.g. Class 10). Every section of that level graduates at year-end.
- Most children in the final class **pass out (graduate)**. A child who failed is the exception and is **kept back** to repeat the year.
- A class below the final (e.g. Class 9) still **promotes** to the next class normally.
- The final class can be changed or cleared at any time; “clear” falls back to the highest level that currently has students.
- A class **above** the final class (e.g. Class 11 while Class 10 is final) is still allowed to exist, but its students graduate rather than move up. Creating or adding a level there requires a deliberate confirmation.

---

## 2. The rules you are testing against

| Situation | Correct behaviour |
|---|---|
| Final class row (10A) | **Pass Out** primary, **Keep back** secondary; no “Promote” |
| Keep-back dialog | Defaults to the child’s own class = repeat the year |
| Below final (9B) | **Promote** primary; no Pass Out on the row |
| Above final (11A) | Treated as graduating; note says “above your final class” |
| No final class set | App uses the highest level **with students** and says so in the banner |
| Bulk action on a graduating class | Says “Graduate the whole class”; graduates only children still to decide; confirmation names the batch and warns |
| A child already kept back | Keeps their class, keeps their new-year seat active, is **not** touched by the bulk action |
| Roll numbers / fees | Cleared/blank for the new year; old year stays readable |

---

## 3. What changed on screen (before → after)

**Final-class class card**

| Before | After |
|---|---|
| `Mark as Passed Out` | **`Graduate the whole class`** |
| `2 of 2 still to move` | **`2 of 2 still to decide`** |
| `these students leave the school` | `these students graduate — open the student list to keep a child back` |
| `Mark Class 10A as passed out?` | **`Graduate Class 10A?`** |
| `…will leave the school as passed out / alumni.` | `…will graduate from the school and become alumni.` |

**Final-class roster row**

| Before | After |
|---|---|
| **Promote** (primary) + small red Pass Out | **Pass Out** (primary) + **Keep back** (secondary) |

**Keep-back dialog**

| Before | After |
|---|---|
| `Promote Arjun Kumar` | `Keep back or move Arjun Kumar` |
| `Promote to class` | `Class next year` |
| `Class 10A (stay in the same class)` | `Class 10A (keep back and repeat the year)` |
| `…will stay in Class 10A for 2027-28.` | `…will stay in Class 10A and repeat the year (2027-28).` |

**Roster note (final class)** now reads: `Each row can be passed out (graduated), or kept back to repeat the year.`

**Graduating-class count now follows decisions, not the register.** On a class that graduates, the card counts from the children **still to decide**, because the register deliberately keeps the row of a child already handled. After a single keep-back or pass-out out of two children the card reads `1 of 2 still to decide` — it used to read `2 of 2` after both had been decided (see F1).

**Bulk confirmation** now names the real batch: `1 student of Class 10A will graduate …`, plus `1 student in this class has already been moved or kept back for the new year and will not be touched.` It no longer claims the class becomes empty when a kept-back child remains. When nobody is left to decide, the button is disabled and its tooltip says so.

**Unchanged on purpose:** Class 9B keeps `Promote`, `Promote to class`, `(stay in the same class)`.

---

## 4. Environment

### Backend (terminal 1) — test database

```powershell
cd D:\Projects\School-ERPB\backend
$vars = @{}
Get-Content .env.test | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
}
$env:DATABASE_URL = $vars['TEST_DATABASE_URL']
$env:DIRECT_URL   = $vars['TEST_DIRECT_URL']
$env:NODE_ENV     = 'test'
$env:PORT         = '5000'
node src/server.js
```

### Frontend (terminal 2)

```powershell
cd D:\Projects\School-ERPB\frontend
npm run dev
```

### Before clicking anything

```powershell
Invoke-RestMethod http://localhost:5000/health
```

Must return `"env":"test"`. If it says `development`, stop the backend and redo terminal 1 — that instance is on live.

**URL:** http://localhost:5173 → Admin → Class Management (`/admin/classes`)
**Login:** `admin` / `Admin@123` (or click the demo credentials button)

### Reset between cases

```powershell
cd D:\Projects\School-ERPB\backend
$env:TEST_DATABASE_URL = <TEST_DATABASE_URL from .env.test>
npm run seed:fixture
```

Expected output: `Seed complete: 4 users, 2 classes, 3 students, 2 employees.`

Restart the backend after a reset (it caches the class list), then sign in again.

---

## 5. Test data (after a reset)

| Class | Students | Notes |
|---|---|---|
| Class 9B | Rahul Menon | below the final; normal promotion |
| Class 10A | Arjun Kumar, Sneha Reddy | becomes the final class in most cases |
| Levels | Nursery … Class 10 (13) | no final class set |

`2026-27` is the current year, `2027-28` the next. There is **no** Class 10B or Class 11 until a test creates one.

---

## 6. Test cases

Mark each **Pass / Fail**, quote exact text, attach a screenshot for failures.

### A. Final class setting

| ID | Do | Correct result |
|---|---|---|
| **A1** | Promote tab → `Set final class` → choose `10` | Toast “10 is now the final class”. Banner: “Your final class is **Class 10** — every section of it graduates rather than moves up.” + `Change final class`. 10A card: `Graduate the whole class`, `2 of 2 still to decide`. 9B unchanged: `Promote to 10B`, `1 of 1 still to move`. |
| **A2** | `Change final class` → `Clear the final class (use the highest class with students)` | Banner: “Final class not set — using the highest class with students (**Class 10**).” 10A still graduates. This is the fallback, not a second setting. |
| **A3** | Set final class to `9` (a level below the students’ top) | Banner “Your final class is Class 9”. 9B becomes a graduating class (card `Graduate the whole class`, rows Pass Out/Keep back). 10A is now **above** final: its roster note says “Class 10A is above your final class (Class 9), so its students graduate rather than move up.” Set it back to 10 afterwards. |

### B. Roster row actions (final class)

| ID | Do | Correct result |
|---|---|---|
| **B1** | With final = 10, open 10A → `Students` | Note: “Your final class is Class 10 — every section of it graduates rather than moves up. Each row can be passed out (graduated), or kept back to repeat the year.” Rows show **Pass Out** first (filled), **Keep back** second (outlined). No “Promote”. |
| **B2** | Row `Keep back` on Arjun | Title `Keep back or move Arjun Kumar`; line `Arjun Kumar · Roll STU-2022-001 · Class 10A (2026-27)`; Academic year `2027-28 (set automatically)`; label `Class next year`; option `Class 10A (keep back and repeat the year)`; sentence `Arjun Kumar will stay in Class 10A and repeat the year (2027-28).` Buttons Cancel / Confirm. |
| **B3** | B2 → `Confirm` | Toast keeps him in 10A for 2027-28 and mentions the new fee starts blank. Row now badged (kept back) with `Undo`. Card changes to `1 of 2 still to decide · 1 already handled`. |
| **B4** | B3 → `Undo` | Row returns to Pass Out / Keep back; card back to `2 of 2 still to decide`. |
| **B5** | Row `Pass Out` on Sneha → confirm | Confirm `Mark Sneha Reddy as passed out?`; confirm button `Mark as passed out`. After: badge passed out, `Undo` offered, card now reads `1 of 1 still to decide · 1 already handled`. |
| **B6** | B5 → `Undo` | She is back in 10A as an active student; card returns to `2 of 2 still to decide`. |
| **B7** | Pass a child out, then record attendance / marks / a fee payment for 2027-28, then try Undo | Undo is gone or blocked, with a readable reason (`Cannot be undone` or the explanation line). Not a crash. |
| **B8** | Reopen Keep back → choose a **higher** class (create `Intermediate` or `11` first) | Warning: “…is above your final class … moves the student past the school’s final year. Continue only if that is intended.” It is allowed, not blocked. |

### C. Whole-class graduation

| ID | Do | Correct result |
|---|---|---|
| **C1** | 10A card → `Graduate the whole class` → **Cancel** | Modal `Graduate Class 10A?`, body `2 students of Class 10A will graduate from the school and become alumni.`, four bullets including the repeater warning, note “Class 10A is at the top of the school…”, buttons `Cancel` / `Graduate 2 students`. Cancel changes nothing. |
| **C2** | C1 → confirm | Toast: `2 students from Class 10A marked as passed out. Their records stay available in Class History.` Class 10A disappears from the grid. Students page no longer lists them as current. Class History still shows both. |
| **C3** | **(was defect F1 — must now PASS)** Keep Arjun back, close the roster, then press `Graduate the whole class` on 10A | The card read `1 of 2 still to decide`. The confirmation must say **1** student will graduate, and add `1 student in this class has already been moved or kept back for the new year and will not be touched.` It must **not** say `Class 10A becomes empty`. Button reads `Graduate 1 student`. Confirm it in a throwaway run: Arjun must stay in Class 10A with his kept-back badge, Sneha must graduate. |

### D. Below-final regression

| ID | Do | Correct result |
|---|---|---|
| **D1** | Open 9B → `Students` | Single `Promote` button. Dialog title `Promote Rahul Menon`; label `Promote to class`; own option `Class 9B (stay in the same class)`; choosing it gives `…will stay in Class 9B for 2027-28.` |
| **D2** | 9B → `Promote to 10B` → `Continue to review` → finish | Review screen lists Rahul; confirm promotes him. Toast mentions the move. If 10B did not exist it is created (the confirm says so). Roll number cleared for the new year. |

### E. Above-final class (optional, needs setup)

| ID | Do | Correct result |
|---|---|---|
| **E1** | Students page → create a class at level 11 | Warning “…is above your final class…”; the Create button is **disabled** until “Yes, create it above the final year” is ticked. Unticked + click = nothing happens, no message (prevention, not a bug). |
| **E2** | Add a level positioned above Class 10 | Same tick-to-confirm; copy says the final class is unchanged. |
| **E3** | Admit one student into 11A, then open its roster | Card `Graduate the whole class`; roster rows Pass Out/Keep back; note “…is above your final class (Class 10), so its students graduate rather than move up.” |

### F. Regression

| ID | Do | Correct result |
|---|---|---|
| **F1** | Visit Students, Class History, Enter Past Data, Dashboard, Attendance, Fees | All load, no 500, counts consistent. |
| **F2** | After a pass-out, open Class History for 2026-27 | The graduated child is still listed with their class and year; marks/attendance/fees readable. |
| **F3** | Reload the Promote tab after a move | Counts and badges persist; the same child cannot be moved twice (row is badged, no action buttons). |
| **F4** | Keep both children of 10A back (one at a time), then look at the card | `0 of 2 still to decide · 2 already handled`; `Graduate the whole class` is **disabled** and its tooltip reads “Every student in this class has already been moved or kept back for the new year”. |

---

## 7. Defect F1 — fixed in this build (`eb48b48`)

**Was:** `passOutClass` graduated everyone whose `classId` pointed at the class. A child kept back to repeat the year keeps that pointer but already holds a seat in the **next** year, so the bulk action flipped that new seat to `passed_out` and cleared their class — undoing the one decision the office had deliberately made. The confirmation also counted the headcount, so it claimed “All 2 students” while the card beside it said `1 of 2 still to decide`.

**Now:** the write skips any child whose newest active seat is in a **later** year — the same cycle filter `promoteClass` has always used. Earlier-year seats and children with no seat at all stay in, so nobody is stranded on a class that no longer offers to graduate. `classOverview` returns `passOutCount` from that same rule, and the card, the confirmation and the button all read it, so the screen cannot promise a child the write will not touch.

**Regression test:** `backend/tests/final.class.test.js` → `bulk graduation: a child already kept back for the new year is left alone`. It keeps one child back, bulk-graduates, and asserts exactly one child graduates while the repeater keeps their class pointer and their next-year seat stays `active`.

**Your job:** case **C3**. It must pass. If it fails, that is a blocker — say so in the report.

---

## 8. Known limitations — do **not** report as bugs

- Bulk graduation cannot skip failures by itself; the office keeps a child back first, and the confirmation says so.
- No reason/note field when keeping a child back.
- Sections do not merge: a repeater stays in 10A while 9B promotes to 10B.
- No delete-level button in the UI; the API has one and it asks for `FINAL_LEVEL_CONFIRM`.
- Unticked “above final” leaves the button disabled with no explanatory text.
- Graduating a class leaves its **this-year register rows** open by design — Class History reads them for a reason. The card no longer counts from the register because of this.
- Bulk graduation is still all-or-nothing over the children still to decide; there is no per-child tick list on that confirmation.

---

## 9. Already verified by engineering

- **Live Supabase is migrated.** Both pending migrations (`20261024120000_passout_undo_timestamps`, `20261025120000_final_class_level`) were applied on 30 October; `prisma migrate status` reports 27/27 up to date, the `isFinal` column and its partial unique index are present, and the data was unchanged by the migration (14 levels, 31 enrollments, 18 attendance rows).
  An earlier report said the migration was still pending. It is not — that report predates the deploy. **Testers still use the test database; nothing here is a reason to point the app at live.**
- Frontend lint unchanged at its 17 pre-existing warnings, build clean.
- Backend suite **515/515** (514 before the F1 regression test), Docker build green.
- Browser on the test DB, on this build: final banner, card wording and counts, roster buttons, Keep-back dialog, the post-keep-back card count, the bulk confirmation naming the 1-child batch, the disabled button when nobody is left, the graduation itself (Arjun untouched, Sneha graduated), and 9B untouched.
- Live API in development mode returns 200 for `/health`, `/school/options`, `/admin/students`, `/admin/class-levels`, `/admin/class-management/overview`.

## 10. Not covered — please test

- Completing a keep-back, a single pass-out, and each Undo (B3–B6).
- Completing the bulk graduation in the normal all-clear case (C2), and the mixed case (C3).
- The disabled state after every child is decided (F4).
- Undo blocked after new-year records (B7).
- Above-final class with a real student (E3).
- No next academic year on file (the dialog should refuse and say so).
- Delete-final-level confirmation (API only; skip unless asked).

---

## 11. How to report a defect

```
ID:            (case number, e.g. B3)
Tester:        Nithin / Rahul
Build:         eb48b48
Environment:   test DB (env=test)
Steps:         1. … 2. … 3. …
Expected:      (quote the sentence from this document)
Actual:        (quote what the screen said)
Screenshot:    attached / not possible
Severity:      blocker / high / medium / low
```

**Severity guide:** blocker = data loss or cannot use the screen; high = wrong student moved/graduated, or wrong year-end; medium = misleading text/count; low = cosmetic.

---

## 12. Background and research (why the design is this way)

| Source | What it says |
|---|---|
| **PowerSchool SMS** — *Set the students’ promotion status* (support.powerschool.com) | “Promoted” promotes **or graduates**; “Retained” keeps the same grade. Retention is the explicit alternative, not the default. |
| **openSIS** — *How to Add/Drop a Student* (support.os4ed.com) | Default is “Next Grade at Current School”; “Retain” if failed; “Do not enroll after this school year” when graduating. |
| **GegoK12** — *Promotion management* (gegok12.com) | One P/F column per student; “retained students stay exactly where they are, marked as retained with the reason”; final grade goes to Alumni; the run is all-or-nothing. |

All three make **advance/graduate the default and retention the exception** — the behaviour this build presents. We match them on the decision model, the all-or-nothing bulk run, and keeping history. We lag on three things: recording a **reason** for retention, **deciding pass/keep in one review list** (GegoK12’s spreadsheet step), and **choosing the destination section** so repeaters and promoted children can share a class.

**Analysis.** The wording change itself was screens only — no API, no schema, no server action — because the server already refused promotion above the final class. The interesting part is what testing found afterwards: the bulk action read one thing (the class pointer) while the card beside it read another (this year’s register), and the gap between the two was exactly the kept-back child. That is the general shape of this class of bug — two read paths for one concept drifting apart — and it is the same shape as the earlier derived-top defect the stored final class was introduced to end. The fix removes the second read path rather than teaching the first one a special case.

That is also the strongest argument for the **review-list flow** next: it would make pass/keep a per-child decision on one screen, so a bulk button could never disagree with a checklist the office had already filled in.

---

## 13. Sign-off

| | Nithin | Rahul |
|---|---|---|
| Cases run | | |
| Passed | | |
| Failed | | |
| Blockers | | |
| Date | | |
| Signature | | |
