-- Academic years, and a student's class as a per-year HISTORY rather than one
-- overwritten value.
--
-- Before this, `Student.classId` was the only record of which class a child was
-- in. Promoting them overwrote it, so the year they spent in the previous class
-- ceased to exist anywhere: its register, its attendance totals and its mark
-- sheets had all been written against a class they no longer belonged to. There
-- was no way to answer "who was in 8-A last year", which is the question Class
-- History exists to answer.
--
-- Two tables, and the division between them is deliberate:
--
--   AcademicYear       the calendar spine. Its real content is the DATE RANGE.
--                      Attendance and marks belong to the year their own date
--                      falls in, which is DERIVED on read — so a record cannot
--                      disagree with the calendar about which year it is in,
--                      because it never stores that answer.
--   StudentEnrollment  the per-year membership, one row per (student, year).
--                      This is what promotion writes and what Class History reads.
--
-- `Student.classId` deliberately STAYS, as the current class, so the ~30 call
-- sites that ask "who is on this register today" (rosters, mark sheets,
-- timetables, circular targeting, class headcounts) remain one indexed column
-- instead of a join. It becomes NULLABLE, and that is what makes "passed out"
-- work at all: a student who finished the top class keeps every year of their
-- history on their enrollment rows and simply holds no current class, dropping out
-- of every current roster and headcount by construction rather than by a filter
-- somebody has to remember to write. It is written in exactly one place
-- (services/enrollment.js) inside the same transaction as the enrollment row.
--
-- `Exam.academicYearId` is a real column rather than a derivation from `date`
-- because `[classId, name]` cannot distinguish this year's "Unit Test 1" from
-- last year's — a backfilled historical exam would be unrecordable. It is also
-- why `Exam.date` becomes nullable: a register that records the year of an exam
-- but not its day must not have a fake day invented for it.

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'passed_out', 'left_school');
CREATE TYPE "RecordSource" AS ENUM ('live', 'promoted', 'historical');
CREATE TYPE "MatchConfidence" AS ENUM ('exact', 'partial', 'ambiguous', 'review');

-- ── AcademicYear ─────────────────────────────────────────────────────────────

CREATE TABLE "AcademicYear" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcademicYear_label_key" ON "AcademicYear"("label");
CREATE INDEX "AcademicYear_startDate_idx" ON "AcademicYear"("startDate");

-- A generous June-to-May window so the dropdowns have real history and a real
-- future to choose from, with `isCurrent` derived from the DATABASE clock rather
-- than written by hand — a current-year flag that could disagree with the calendar
-- is exactly the drift this schema avoids elsewhere.
--
-- The window is wide deliberately: narrowing it later is a DELETE of unused rows,
-- whereas having too few would mean a promotion into a year that does not exist.
INSERT INTO "AcademicYear" ("id", "label", "startDate", "endDate", "isCurrent", "createdAt")
SELECT
    'ay-' || y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0'),
    y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0'),
    make_date(y, 6, 1),
    make_date(y + 1, 5, 31),
    (make_date(y, 6, 1) <= CURRENT_DATE AND CURRENT_DATE <= make_date(y + 1, 5, 31)),
    CURRENT_TIMESTAMP
FROM generate_series(2015, 2035) AS y
ON CONFLICT ("id") DO NOTHING;

-- ── StudentEnrollment ────────────────────────────────────────────────────────

CREATE TABLE "StudentEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "rollNumber" TEXT,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "source" "RecordSource" NOT NULL DEFAULT 'live',
    "enrolledOn" DATE NOT NULL,
    "endedOn" DATE,
    "promotedFromClassId" TEXT,
    "matchConfidence" "MatchConfidence",
    -- Backfilled yearly attendance totals: all three null, or all three set, so
    -- "never backfilled" stays distinguishable from "backfilled as absent all term".
    "workingDays" INTEGER,
    "daysPresent" INTEGER,
    "daysAbsent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentEnrollment_pkey" PRIMARY KEY ("id")
);

-- One row per student per year: this is the constraint that makes a year of
-- registers trustworthy. It also makes "promote this class" idempotent — a
-- re-run cannot put one child in two classes at once.
CREATE UNIQUE INDEX "StudentEnrollment_studentId_academicYearId_key"
    ON "StudentEnrollment"("studentId", "academicYearId");
-- Class History's primary read: everyone in one class in one year.
CREATE INDEX "StudentEnrollment_academicYearId_classId_status_idx"
    ON "StudentEnrollment"("academicYearId", "classId", "status");
-- The Promote tab's read: who is in this class right now.
CREATE INDEX "StudentEnrollment_classId_idx" ON "StudentEnrollment"("classId");
CREATE INDEX "StudentEnrollment_promotedFromClassId_idx" ON "StudentEnrollment"("promotedFromClassId");

ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT on class and year, like every other Class reference in this schema:
-- a class with a year of history behind it is not a row that may vanish.
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_academicYearId_fkey"
    FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Student: current class becomes optional ─────────────────────────────────

-- This is the whole mechanism behind "Mark as Passed Out": the student keeps
-- every enrollment row and simply stops having a current class, so all eleven
-- `_count.students` headcount queries and every `where: { classId }` roster filter
-- exclude them with no code change at all.
ALTER TABLE "Student" ALTER COLUMN "classId" DROP NOT NULL;

-- "Find this child across years" leads with the name, so the name is indexed.
CREATE INDEX "Student_name_idx" ON "Student"("name");

-- ── Exam: a real academic year, and an optional date ─────────────────────────

ALTER TABLE "Exam" ADD COLUMN "academicYearId" TEXT;
ALTER TABLE "Exam" ADD COLUMN "source" "RecordSource" NOT NULL DEFAULT 'live';
ALTER TABLE "Exam" ALTER COLUMN "date" DROP NOT NULL;

-- Assign each existing exam to the year containing its own date. Years are taken
-- from the table rather than computed, so an exam can never land outside the
-- calendar it belongs to. `isCurrent` is deliberately not consulted: the RANGE is
-- the authority, per AcademicYear's own note.
UPDATE "Exam" e
SET "academicYearId" = ay."id"
FROM "AcademicYear" ay
WHERE e."academicYearId" IS NULL
  AND e."date" IS NOT NULL
  AND e."date" >= ay."startDate"
  AND e."date" <= ay."endDate";

-- Safety net for exam dates outside the generated window (a school that has been
-- running longer than 2015, or a year added later): derive the missing year from
-- the date itself. March 2024 is in 2023-24, so the year is read from six months
-- before the date — the June-to-May boundary, not the calendar year.
--
-- The label is computed ONCE, in the subquery, and named: an inline concatenation
-- has no output column name (`?column?`), so DISTINCT ON / ORDER BY cannot refer
-- to it. `id` is 'ay-' + the same label, so it cannot disagree with the wide
-- window's ids.
INSERT INTO "AcademicYear" ("id", "label", "startDate", "endDate", "isCurrent", "createdAt")
SELECT DISTINCT ON (lbl)
    'ay-' || lbl,
    lbl,
    make_date(y, 6, 1),
    make_date(y + 1, 5, 31),
    false,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT
        EXTRACT(YEAR FROM e."date" - INTERVAL '5 months')::int AS y,
        EXTRACT(YEAR FROM e."date" - INTERVAL '5 months')::int::text || '-'
            || lpad(((EXTRACT(YEAR FROM e."date" - INTERVAL '5 months')::int + 1) % 100)::text, 2, '0') AS lbl
    FROM "Exam" e
    WHERE e."academicYearId" IS NULL
      AND e."date" IS NOT NULL
) yrs
ORDER BY lbl
ON CONFLICT ("id") DO NOTHING;

UPDATE "Exam" e
SET "academicYearId" = ay."id"
FROM "AcademicYear" ay
WHERE e."academicYearId" IS NULL
  AND e."date" IS NOT NULL
  AND e."date" >= ay."startDate"
  AND e."date" <= ay."endDate";

-- An exam with no date at all has no year to be derived from. The column is
-- NOT NULL in the schema, so refuse the migration loudly rather than dropping the
-- row or inventing a date for it — an operator can set a year by hand and re-run.
DO $$
DECLARE
    orphans INTEGER;
BEGIN
    SELECT count(*) INTO orphans FROM "Exam" WHERE "academicYearId" IS NULL;
    IF orphans > 0 THEN
        RAISE EXCEPTION
            'Cannot add Exam.academicYearId: % exam(s) have no date to derive a year from. '
            'Give each a date (or an academic year) and re-run.', orphans;
    END IF;
END $$;

ALTER TABLE "Exam" ALTER COLUMN "academicYearId" SET NOT NULL;

ALTER TABLE "Exam" ADD CONSTRAINT "Exam_academicYearId_fkey"
    FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Exam_academicYearId_idx" ON "Exam"("academicYearId");

-- The old key cannot tell two years' "Unit Test 1" apart.
DROP INDEX "Exam_classId_name_key";
CREATE UNIQUE INDEX "Exam_classId_academicYearId_name_key"
    ON "Exam"("classId", "academicYearId", "name");

-- ── Backfill: one current-year enrollment per existing student ────────────────

-- The only backfill that is honest. Every existing student demonstrably IS in
-- their class right now, so one 'active' row for the current year is a fact.
--
-- Their years BEFORE this one are NOT invented: the database does not know which
-- classes they passed through, and a migration that guessed would put fabricated
-- history in front of a school. Those years stay empty until the office either
-- promotes into them or backfills the real records through "Enter Past Data".
--
-- 'enr-<studentId>' makes these rows deterministic, so re-running is a no-op
-- rather than a duplicate.
INSERT INTO "StudentEnrollment"
    ("id", "studentId", "academicYearId", "classId", "rollNumber", "status", "source",
     "enrolledOn", "createdAt", "updatedAt")
SELECT
    'enr-' || s."id",
    s."id",
    cy."id",
    s."classId",
    s."rollNumber",
    'active',
    'live',
    s."enrolledAt",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Student" s
-- Joined on the RANGE, not on `isCurrent`: the calendar is the authority.
JOIN "AcademicYear" cy
  ON cy."startDate" <= CURRENT_DATE
 AND cy."endDate" >= CURRENT_DATE
WHERE s."classId" IS NOT NULL
ON CONFLICT ("studentId", "academicYearId") DO NOTHING;

-- Report rather than silently ignore: a student in a class with no current-year
-- enrollment is invisible to Class History and to promotion, and that is a bug
-- worth seeing in the migration output rather than discovering in the UI.
DO $$
DECLARE
    missing INTEGER;
BEGIN
    SELECT count(*) INTO missing
    FROM "Student" s
    WHERE s."classId" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM "StudentEnrollment" e
          JOIN "AcademicYear" ay ON ay."id" = e."academicYearId"
          WHERE e."studentId" = s."id"
            AND ay."startDate" <= CURRENT_DATE
            AND ay."endDate" >= CURRENT_DATE
      );
    IF missing > 0 THEN
        RAISE NOTICE 'Academic years added. % student(s) have no current-year enrollment.', missing;
    END IF;
END $$;
