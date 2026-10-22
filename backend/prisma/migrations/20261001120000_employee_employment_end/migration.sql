-- Employee termination (soft "End Employment") instead of a hard delete.
--
-- The `DELETE /admin/employees/:id` route is already correct in refusing to
-- delete an employee who has any dependent row — payroll, attendance, leave,
-- documents, teaching assignments, announcements — because the foreign keys say
-- so. What it cannot offer is the ordinary case: someone who has genuinely left.
-- This table is the timeline that makes that possible without touching a single
-- one of those dependent rows.
--
-- Deliberately additive and empty:
--   * No Employee column changes. `status` keeps its existing AccountStatus
--     (active | inactive) meaning, so every `status = 'active'` filter, badge and
--     login check in the app keeps working untouched, and the reason lives here
--     instead of being crammed into that shared two-value enum.
--   * No backfill. An employee who is currently on the staff list has no
--     termination to record, and inventing one would put a false "resigned" entry
--     on the seeded staff. Rows appear only when an admin ends an employment.
--
-- `lastWorkingDay` is the employee's own last day (payroll cutoff, may be
-- back-dated) and is deliberately distinct from `endedAt` (when the office
-- processed it). `reactivatedAt` is null on the spell that is currently closed;
-- reactivation stamps the same row, so a rehire never erases the record of the
-- previous ending.

-- CreateEnum
CREATE TYPE "EmploymentEndReason" AS ENUM ('resigned', 'terminated', 'retired', 'contract_ended', 'other');

-- CreateTable
CREATE TABLE "EmploymentEnd" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" "EmploymentEndReason" NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "description" TEXT,
    "endedBy" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reactivatedAt" TIMESTAMP(3),
    "reactivatedBy" TEXT,

    CONSTRAINT "EmploymentEnd_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmploymentEnd_employeeId_endedAt_idx" ON "EmploymentEnd"("employeeId", "endedAt");

-- AddForeignKey
-- ON DELETE CASCADE matches every other employee-owned table: a permanent
-- delete of a never-used duplicate should not be blocked by the termination
-- record itself, which has no value once the person is gone.
ALTER TABLE "EmploymentEnd" ADD CONSTRAINT "EmploymentEnd_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
