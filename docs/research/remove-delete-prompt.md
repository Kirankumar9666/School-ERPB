# Remove the student-delete route — prompt for Nithin

**Prepared by:** assistant ⬥ **Reviewed by:** Ritwik (first review, 3 Nov 2026) ⬥ **Approved by:** Rahul
**Rule this implements:** a student is never deleted — never a soft delete, never an `isDeleted` flag. The decision is remove-not-decide.
**Scope:** one step. No schema change, no new column, no new status.

> Review note: this prompt is the product of Ritwik's first review. He found the test section
> was wrong in a way that would half-remove the feature, and that naming the frontend files
> was required. Both are fixed below. The prompt supersedes the earlier version.

---

## The prompt (verbatim, paste-ready)

```
Remove the ability to delete a student. It is the school's rule that a student is
never deleted: they either pass out or are given a transfer certificate, and the
year's data stays exactly as it is.

WHY
DELETE /api/v1/admin/students/:id (backend/src/modules/admin/admin.routes.js, line
1537) hard-deletes the student row AND their login user. Its only guard is a
foreign-key error (P2003), so a child with no attendance, marks or achievements is
deleted instantly and for real. It contradicts the rule above, and it undermines
admission numbers: a number can only be "never reused" while the row it points at
still exists.

WHAT TO DO

1. BACKEND — delete the route and its handler.
   - backend/src/modules/admin/admin.routes.js, line 1537 (router.delete('/students/:id')).
   - Remove the handler body: the prisma.student.delete / prisma.user.delete calls,
     and the P2025 / P2003 error handling written only for this route.
   - Leave REGISTERED the other delete routes: class deletion
     (router.delete('/classes/:id')) and employee deletion. This change is only
     about students.

2. FRONTEND — remove exactly these, all in frontend/src/pages/admin/AdminStudents.jsx:
   - line 2: remove `Trash` from the lucide-react import — but ONLY if nothing else
     in the file still uses it. The class-delete button DOES use it (line 439), so
     keep `Trash` in the import. Remove only the student-delete usage.
   - line 34: the header comment says "add / edit / delete" this file manages —
     correct it to "add / edit", because deletion is no longer something this file
     offers. This is a comment describing behaviour we are removing: change it, do
     not leave it lying.
   - lines 168-190: the whole `handleDelete` function.
   - lines 516-522: the delete `<button className="btn btn-danger btn-sm">` with the
     `<Trash size={14} />` icon and `aria-label={`Delete ${s.name}`}`.
   - DO NOT remove the shared confirm state (line 163) or the shared <ConfirmModal>
     render (620-630). That dialog is used by OTHER destructive confirms in this
     file (the reset-password flow, and the class-delete flow routed through the
     separate `deleteClass` state at line 166). Narrowing the student usage is the
     job; deleting the dialog breaks unrelated screens.
   - After the edit, `confirm` / `setConfirm` must still be used by the remaining
     callers, or the build will warn on unused state. Confirm that before finishing.

3. COMMENTS — remove any comment that explains why student deletion is safe or
   desirable. If a comment described behaviour we are removing, delete the comment
   with it. (Line 34 is one such; check for others near the handler.)

4. TESTS — this is the part that must not be done sloppily. There are FIVE sites,
   in THREE kinds. Treat each kind differently.

   (a) ASSERT-tests — tests whose whole point is that deletion works. REWRITE to
       assert the route is gone (see the test list below):
       - backend/tests/admin.api.test.js:38 — "students: list, create, update,
         delete (full CRUD)"; the delete leg of it is lines 69, 87, 97.
       - backend/tests/admin.api.test.js:87 — "students: update/delete unknown id →
         404". See the note under TESTS about why this one is special.
       - backend/tests/studentmgmt.screens.test.js:174 — "deleting a student removes
         their login account".
       - backend/tests/studentmgmt.screens.test.js:188 — "a student with no login at
         all still deletes cleanly".

   (b) CLEANUP-calls that swallow errors — these are NOT tests of deletion; they only
       tidy up rows the test made. Most end in `.catch(() => {})`, so once the route
       is gone they will silently 404 and the suite will stay GREEN while cleanup
       stops happening. REPLACE each with a direct database delete, exactly as
       backend/tests/student.guardian.login.test.js:225 already does
       (`await prisma.student.delete({ where: { id } })`):
       - backend/tests/bulkadd.class.test.js:67 (inside `after()`).
       - backend/tests/studentmgmt.screens.test.js:39 (inside `after()`).
       - backend/tests/identity.duplicates.test.js:126.
       - backend/tests/identity.duplicates.test.js:135.
       - backend/tests/identity.duplicates.test.js:149.

   (c) CLEANUP-call that ASSERTS success — one site is a cleanup that also asserts
       `status === 200`:
       - backend/tests/identity.duplicates.test.js:94 (asserts the cleanup delete
         returns 200).
       Replace it with a `prisma.student.delete` as well. Do NOT simply delete the
       assertion and leave the HTTP call — that would leave a 404 being ignored.

5. Confirm that the tests which used the route to CLEAN UP now use prisma directly,
   so no test depends on the route existing in order to tidy up after itself.

TESTS
- The rewritten routes-are-gone test must target a REAL, EXISTING student id: create
  a student, capture its id, call DELETE on it, and assert 404. Do NOT test with an
  unknown id like 'stu-999' — an unregistered route and an unknown id both return
  404, so that test would pass for the wrong reason.
- A student row created through the API cannot be removed through the API by any
  other route (try the obvious alternatives; each must not remove it).
- The suite still passes. Report the count as BEFORE / AFTER, and name EVERY change
  that moved it — a test added, collapsed or rewritten — with its file and line.
  The suite currently reports 515 passing. Collapsing the two whole
  deletion-behaviour tests (studentmgmt.screens.test.js:174 and :188) into the one
  routes-are-gone test may legitimately move the number; a number that moves with no
  named cause is a test that went missing rather than one that was rewritten. If you
  cannot account for a single test, stop and say so.
- IMPORTANT: admin.api.test.js:87 ("update/delete unknown id → 404") will KEEP
  PASSING after this change, for the wrong reason — DELETE on an unregistered route
  404s, which is the same status the test asserts. Print its name in your summary so
  the reviewer knows it was not actually re-verified by this change; the real
  routes-are-gone test above is what proves the route is gone.

DO NOT
- Add a "soft delete", a "voided" flag, an "isDeleted" column, or any new field.
  This step adds no schema and no status.
- Remove the class-delete route, the employee-delete route, or the shared
  <ConfirmModal> that other flows rely on.
- Change any other behaviour.

WHAT THIS DOES NOT SOLVE, AND WHERE THOSE CASES GO
Removing delete leaves three ways a person might once have reached for it. Two are
already covered by tools that exist; name them in your summary so the reviewer can
see they were considered:
- A field typed wrong (misspelt name, wrong class) → Edit Student. Already works.
- A child entered twice → the existing duplicate rule refuses it at entry. Already
  works.
- A row created BY MISTAKE that should never have existed at all — an accidental
  "Add", or a bad row in a bulk upload → this one is NOT covered, because Edit
  Student can change a row but cannot un-create one. Do NOT invent a fix for it in
  this step. Do NOT add a soft delete, a voided status, or an isDeleted flag. Leave
  it and record it as an open case: today such a row is corrected with Edit Student
  where the data is wrong and otherwise left; the transfer-certificate path, when it
  lands, is where a genuinely never-should-have-existed child gets a proper leaving
  state. If you think it needs its own step, say so in your summary — do not build it.

Run the suite with `npm test` against the test database only (backend/.env.test,
schoolerp_test @ 127.0.0.1). Never point it at live Supabase.
```

---

## What Ritwik changed from my first draft, and why

| # | His finding | Status |
|---|---|---|
| 1 | Test section named one shape; there are five sites in three kinds, and the cleanup calls swallow 404s | **Fixed** — step 4 now splits (a) assert / (b) swallow-cleanup / (c) assert-cleanup, and names every file and line |
| 2 | Frontend files must be named, not searched — the shared `<ConfirmModal>` must be *narrowed*, and a blind search also hits the carved-out class/document deletes | **Fixed** — step 2 names lines 2, 34, 168-190, 516-522 and explicitly protects 163 / 620-630 |
| 3 | "Returns 404" is weak — unregistered route and unknown id are indistinguishable | **Fixed** — TESTS now require a real, existing id, and call out that `admin.api.test.js:87` keeps passing for the wrong reason |
| 4 | "What replaces it" has an unnamed hole: a row created by mistake that should never have existed | **Addressed** — named in the note below, routed to Edit Student today and the TC path later (no soft delete) |
| — | Minor: "do not hardcode anything" is boilerplate here | **Fixed** — dropped, and the suite count (515) named instead so a silent drop is noticed |

## One correction of my own, in Ritwik's favour

He listed `identity.duplicates.test.js:94` under the *swallow-cleanup* kind. It is actually a
third kind: a cleanup call that **asserts** `status === 200` (line 94-96). I have given it its
own category (c) so Nithin replaces it properly rather than deleting the assertion and leaving
an ignored 404. Everything else in his review checked out verbatim against the files.

## The unnamed hole, stated plainly (for the record)

Edit Student fixes wrong data. The duplicate rule catches repeats. Neither covers **a row
created by mistake that should never have existed** — an accidental "Add", or a bad bulk row —
because Edit cannot un-create a row. This step does **not** build a soft delete for that. The
position is:

- **Today:** such a row is corrected with Edit Student where the data is wrong, and otherwise
  left, or the school raises it with us. There is no delete, by rule.
- **When TC lands:** the TC path gives the child a proper leaving state, which is where a
  genuinely-never-should-have-existed row is dealt with.
- **Never:** an `isDeleted` flag, a voided status, or a recycle bin.

## For the next prompt (the admission number) — carry-forward

The delete step removes the route; it does not decide the *shape* of what replaces it. The
admission-number prompt must still respect: `admissionNo String? @unique` + `admittedOn
DateTime? @db.Date` in one migration; the backfill sets only `admissionYear`, never the number,
and does not invent an `admittedOn` for legacy rows; issued inside the same transaction in all
four create paths. None of that changes here.
