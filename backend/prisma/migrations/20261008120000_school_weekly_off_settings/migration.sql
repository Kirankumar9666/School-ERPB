-- School-level settings — one row per setting, `value` a JSON blob.
--
-- The first tenant is the weekly-off configuration (`weeklyOffDays`, an array
-- of JS weekday numbers, 0 = Sunday). Every attendance calendar and working-day
-- calculation reads it, replacing the old hardcoded "Saturday + Sunday" weekend
-- so the school's real working week has exactly one definition. Default Sunday
-- only is written by the seed; a missing row is read as [0] too.
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
