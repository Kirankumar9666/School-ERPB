-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "enrolledAt" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill enrollment for existing rows.
--
-- Two kinds of rows can be on file:
--   1. Mock-store fixtures (the seed preserves 'stu-001'-style ids — see the
--      schema.prisma header), whose admissionYear is their only real enrollment
--      signal; June 1 of that year is used so their seeded demo attendance
--      ("Sep 1–10") stays visible.
--   2. Students created through the API (single add / bulk upload): their
--      creation timestamp IS the day they were added, so that day becomes the
--      enrollment date — a student created today must not appear in rosters for
--      any earlier date.
-- The rule applies per row category using only real row data (id format,
-- admissionYear, createdAt) — no student name, id or date is special-cased.
UPDATE "Student"
SET "enrolledAt" = CASE
  WHEN "id" ~ '^stu-[0-9]{3}$' AND "admissionYear" IS NOT NULL
    THEN MAKE_DATE("admissionYear", 6, 1)
  ELSE DATE_TRUNC('day', "createdAt")::date
END;