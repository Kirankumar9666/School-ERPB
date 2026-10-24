-- Pass-out undo timestamps.
--
-- `passedOutAt` records when the office passed the seat out. It is deliberately
-- separate from `endedOn` (the academic year's last day) and `updatedAt` (which
-- later edits move).
--
-- `recordedAt` records when an attendance row was last written. It stays NULL
-- for rows that predate this column: the undo guard treats those as pre-existing
-- and keeps the old conservative rule for pass-outs without a passedOutAt.

ALTER TABLE "StudentEnrollment" ADD COLUMN "passedOutAt" TIMESTAMP(3);

ALTER TABLE "StudentAttendance" ADD COLUMN "recordedAt" TIMESTAMP(3);
ALTER TABLE "StudentAttendance" ALTER COLUMN "recordedAt" SET DEFAULT CURRENT_TIMESTAMP;
