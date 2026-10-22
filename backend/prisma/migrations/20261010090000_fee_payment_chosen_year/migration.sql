-- FeePayment.chosenYear — which year a payment settled is already a fact about
-- the fee row it hangs off. This flag records the times the year was picked by
-- hand ("this is for last year's fee") instead of reached by the oldest-first
-- default, so the payment history can say which is which.
ALTER TABLE "FeePayment" ADD COLUMN "chosenYear" BOOLEAN NOT NULL DEFAULT false;
