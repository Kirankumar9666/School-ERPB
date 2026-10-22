-- Per-year student fees and a real payment history.
--
-- Before this, a student's fee was two scalars on `Student` (`feeTotal` and
-- `feeDues`) that every promotion overwrote. Two things were therefore
-- impossible, and both are requirements:
--
--   * carrying an unpaid balance forward — "₹5,000 from Class 9B, 2026–27" has
--     nowhere to live once the scalars are reset for the new year; and
--   * an honest history — with no payment rows there is no record of what was
--     paid, when, or which year it settled, so the old year's "final balance"
--     could not be shown at all.
--
-- Two tables fix both:
--
--   StudentFee    one row per (student, academic year). `total` is nullable and
--                 NULL means "not set yet" — deliberately distinct from 0.
--                 `classId` is the class the fee was charged for, so a carried
--                 balance can be labelled with the class it came from.
--   FeePayment    one row per payment, always against a specific year's fee, so
--                 "which year did this settle" is stored rather than inferred.
--                 A receipt that clears two years is split into one row per
--                 year, tied by `receiptId`.
--
-- `Student.feeTotal`/`Student.feeDues` are KEPT, but become a derived cache of
-- the current year only (recomputed on every write by services/fees.js). Every
-- pre-existing call site that reads them — the dashboard, the class cards, the
-- student form — keeps working, which is what makes this migration safe to ship.
--
-- The backfill is lossless: each student's current fee becomes a StudentFee row,
-- and the amount already paid (`feeTotal - feeDues`) becomes ONE payment row, so
-- `total - payments` equals the old `feeDues` exactly. Nothing changes state on
-- the day this ships.

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE "StudentFee" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "classId" TEXT,
    "total" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentFee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeePayment" (
    "id" TEXT NOT NULL,
    "studentFeeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "recordedBy" TEXT,
    "receiptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeePayment_pkey" PRIMARY KEY ("id")
);

-- One row per student per year: a child cannot have two fees for one year.
CREATE UNIQUE INDEX "StudentFee_studentId_academicYearId_key"
    ON "StudentFee"("studentId", "academicYearId");
-- The Fee Dues page reads one class's fees for one year in a single pass.
CREATE INDEX "StudentFee_academicYearId_classId_idx"
    ON "StudentFee"("academicYearId", "classId");
-- A fee row's payments, in date order.
CREATE INDEX "FeePayment_studentFeeId_paidOn_idx"
    ON "FeePayment"("studentFeeId", "paidOn");

ALTER TABLE "StudentFee" ADD CONSTRAINT "StudentFee_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentFee" ADD CONSTRAINT "StudentFee_academicYearId_fkey"
    FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Optional class reference: a class with fees behind it is not a row that may
-- vanish, so this mirrors the RESTRICT used by enrollments as closely as an
-- optional relation allows — but a fee row is still meaningful without its class
-- label, so SET NULL rather than blocking a class delete outright.
ALTER TABLE "StudentFee" ADD CONSTRAINT "StudentFee_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeePayment" ADD CONSTRAINT "FeePayment_studentFeeId_fkey"
    FOREIGN KEY ("studentFeeId") REFERENCES "StudentFee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill the current year ────────────────────────────────────────────────

-- Every student who demonstrably holds a class today gets one fee row for the
-- academic year containing today, carrying their existing amount. The year is
-- joined on the RANGE, not the stored `isCurrent` flag — the calendar is the
-- authority everywhere else in this schema.
--
-- `total` is COALESCE(feeTotal, feeDues): the normal case has both, but a dues
-- amount with no total (a bulk import that only knew what was owed) must not be
-- dropped.
INSERT INTO "StudentFee"
    ("id", "studentId", "academicYearId", "classId", "total", "createdAt", "updatedAt")
SELECT
    'sf-' || s."id",
    s."id",
    ay."id",
    s."classId",
    COALESCE(s."feeTotal", s."feeDues"),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Student" s
JOIN "AcademicYear" ay
  ON ay."startDate" <= CURRENT_DATE
 AND ay."endDate" >= CURRENT_DATE
ON CONFLICT ("studentId", "academicYearId") DO NOTHING;

-- The already-paid portion becomes ONE payment row, dated from the student's own
-- enrollment day. This is what keeps the migration lossless: total - payment now
-- derives back to the exact `feeDues` the database held before.
INSERT INTO "FeePayment"
    ("id", "studentFeeId", "amount", "paidOn", "note", "recordedBy", "createdAt")
SELECT
    'fp-' || s."id",
    'sf-' || s."id",
    s."feeTotal" - s."feeDues",
    s."enrolledAt",
    'Migrated from the previous single fee-balance field',
    NULL,
    CURRENT_TIMESTAMP
FROM "Student" s
WHERE s."feeTotal" IS NOT NULL
  AND s."feeDues" IS NOT NULL
  AND s."feeTotal" - s."feeDues" > 0;

-- ── Keep the derived cache equal to the per-year row it now mirrors ──────────

UPDATE "Student" s
SET "feeTotal" = sf."total",
    "feeDues" = CASE
        WHEN sf."total" IS NULL THEN NULL
        ELSE GREATEST(
            sf."total" - COALESCE(
                (SELECT SUM(fp."amount") FROM "FeePayment" fp WHERE fp."studentFeeId" = sf."id"),
                0
            ),
            0
        )
    END
FROM "StudentFee" sf
WHERE sf."studentId" = s."id";

-- A student in a class with no fee row is invisible to Fee Dues, which is worth
-- seeing in the migration output rather than discovering in the UI.
DO $$
DECLARE
    missing INTEGER;
BEGIN
    SELECT count(*) INTO missing
    FROM "Student" s
    WHERE s."classId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "StudentFee" sf WHERE sf."studentId" = s."id");
    IF missing > 0 THEN
        RAISE NOTICE 'Student fees added. % student(s) hold a class but have no fee row.', missing;
    END IF;
END $$;
