-- Default salary structure per employee (₹, whole rupees): set on the employee
-- Add/Edit form, prefilled into each new PayrollRecord month. Additive only —
-- existing employees keep every component at 0 until the admin sets it.
ALTER TABLE "Employee" ADD COLUMN "basicPay" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "hra" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "transportAllowance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "medicalAllowance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "providentFund" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "professionalTax" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "tds" INTEGER NOT NULL DEFAULT 0;
