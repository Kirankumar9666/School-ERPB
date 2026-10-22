-- Partial payroll payments.
--
-- 1. A real `PayrollPayment` table, so a month can be settled over several
--    transfers instead of one overwritten `paidOn` value.
-- 2. A BACKFILL: every month already marked paid had its single lump payment
--    turned into one payment row of the full net on the date it was recorded.
--    This is what makes the migration lossless — the sum of payments equals the
--    old net exactly, so every previously-paid month derives back to 'paid'
--    and nothing in the app changes state on the day this ships.
-- 3. `payrollRecord.paidOn` is left in place and NOT backfilled here, because
--    step 2 already sets it to the same value it held. It is now a derived cache
--    of the payment rows, recomputed on every write from here on.

-- CreateTable
CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL,
    "payrollRecordId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);

-- Backfill: one payment per already-paid month, for the full net salary.
-- `createdAt` is backdated to the payment date itself so the completion date
-- derived from (paidOn, createdAt) is stable rather than "today".
INSERT INTO "PayrollPayment" ("id", "payrollRecordId", "amount", "paidOn", "note", "createdAt")
SELECT
    'pay-' || pr."id",
    pr."id",
    pr."netSalary",
    pr."paidOn",
    'Migrated from the previous single-payment field',
    pr."paidOn"::timestamp
FROM "PayrollRecord" pr
WHERE pr."paidOn" IS NOT NULL;

-- CreateIndex
CREATE INDEX "PayrollPayment_payrollRecordId_paidOn_idx" ON "PayrollPayment"("payrollRecordId", "paidOn");

-- AddForeignKey
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
