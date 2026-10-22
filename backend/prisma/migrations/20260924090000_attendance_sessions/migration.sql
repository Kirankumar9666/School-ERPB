-- Attendance becomes session-scoped: every day record is split into an FN/AN
-- pair so a student can be present in the forenoon and absent in the afternoon
-- (or vice versa). AttendanceConfirmation — the driver of the 1-hour edit
-- window — becomes per (kind, group, day, session) too, so confirming FN never
-- locks AN.
--
-- Backfill rule: existing rows are full-day records, so each one is kept as its
-- 'FN' twin and given an identical 'AN' twin (same status; employees keep the
-- same workingHours on each half). The read side merges those pairs back into
-- the exact day status they had before the split (present+present → present,
-- absent+absent → absent, …) — no historical number changes.

-- CreateEnum
CREATE TYPE "AttendanceSession" AS ENUM ('FN', 'AN');

-- AlterTable: add the column with a temporary default so the backfill INSERTs
-- below can run; the default is dropped at the end (every writer must say which
-- session it means).
ALTER TABLE "StudentAttendance" ADD COLUMN "session" "AttendanceSession" NOT NULL DEFAULT 'FN';
ALTER TABLE "EmployeeAttendance" ADD COLUMN "session" "AttendanceSession" NOT NULL DEFAULT 'FN';
ALTER TABLE "AttendanceConfirmation" ADD COLUMN "session" "AttendanceSession" NOT NULL DEFAULT 'FN';

-- Drop the per-day unique keys first: every FN row's AN twin shares the same
-- (studentId, date), so the old keys would reject the backfill INSERTs below.
DROP INDEX "StudentAttendance_studentId_date_key";
DROP INDEX "EmployeeAttendance_employeeId_date_key";
DROP INDEX "AttendanceConfirmation_kind_groupKey_date_key";

-- Backfill: twin every existing row into its AN half. cuid() ids never contain
-- '-', so appending '-AN' cannot collide with a real id.
-- Working hours are split across the halves FIRST (a full-day 8h present row
-- becomes FN 4h + AN 4h, a 7h late row 3.5 + 3.5), so the merged day totals
-- read back exactly as they did before the split.
UPDATE "EmployeeAttendance" SET "workingHours" = "workingHours" / 2 WHERE "session" = 'FN';
UPDATE "EmployeeAttendance" SET "workingHours" = 0 WHERE "workingHours" IS NULL AND "session" = 'FN';

INSERT INTO "StudentAttendance" ("id", "studentId", "date", "status", "session")
SELECT "id" || '-AN', "studentId", "date", "status", 'AN'
FROM "StudentAttendance" WHERE "session" = 'FN';

INSERT INTO "EmployeeAttendance" ("id", "employeeId", "date", "status", "workingHours", "session")
SELECT "id" || '-AN', "employeeId", "date", "status", "workingHours", 'AN'
FROM "EmployeeAttendance" WHERE "session" = 'FN';

INSERT INTO "AttendanceConfirmation" ("id", "kind", "groupKey", "date", "confirmedAt", "markedBy", "session")
SELECT "id" || '-AN', "kind", "groupKey", "date", "confirmedAt", "markedBy", 'AN'
FROM "AttendanceConfirmation" WHERE "session" = 'FN';

-- Re-create uniqueness per (entity, day, session).
CREATE UNIQUE INDEX "StudentAttendance_studentId_date_session_key" ON "StudentAttendance"("studentId", "date", "session");
CREATE UNIQUE INDEX "EmployeeAttendance_employeeId_date_session_key" ON "EmployeeAttendance"("employeeId", "date", "session");
CREATE UNIQUE INDEX "AttendanceConfirmation_kind_groupKey_date_session_key" ON "AttendanceConfirmation"("kind", "groupKey", "date", "session");

-- The backfill is complete — no implicit default from here on.
ALTER TABLE "StudentAttendance" ALTER COLUMN "session" DROP DEFAULT;
ALTER TABLE "EmployeeAttendance" ALTER COLUMN "session" DROP DEFAULT;
ALTER TABLE "AttendanceConfirmation" ALTER COLUMN "session" DROP DEFAULT;