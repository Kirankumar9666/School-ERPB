-- AttendanceConfirmation — one row per (kind, group, day) each time a bulk
-- attendance save is confirmed; confirmedAt drives the 1-hour edit window.
-- kind: 'student' (groupKey = class id) or 'employee' (groupKey = designation).
-- CreateTable
CREATE TABLE "AttendanceConfirmation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedBy" TEXT,

    CONSTRAINT "AttendanceConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceConfirmation_kind_groupKey_date_key" ON "AttendanceConfirmation"("kind", "groupKey", "date");

-- CreateIndex
CREATE INDEX "AttendanceConfirmation_date_idx" ON "AttendanceConfirmation"("date");
