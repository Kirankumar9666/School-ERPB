-- Announcement scheduling: each circular carries a show window and only
-- appears on the student/employee portals while today is inside it
-- (showFrom ≤ today ≤ showUntil, both inclusive).
--
-- Backfill rule for rows that predate scheduling (the agreed fallback, so
-- nothing silently disappears or stays visible forever during the migration):
--   showFrom  = the day the circular was posted (createdAt, UTC day)
--   showUntil = showFrom + 30 days
-- Admins can shorten/extend the window per circular from the admin panel.
ALTER TABLE "Announcement" ADD COLUMN "showFrom" DATE;
ALTER TABLE "Announcement" ADD COLUMN "showUntil" DATE;

UPDATE "Announcement" SET "showFrom" = ("createdAt" AT TIME ZONE 'UTC')::date;
UPDATE "Announcement" SET "showUntil" = "showFrom" + 30;

ALTER TABLE "Announcement" ALTER COLUMN "showFrom" SET NOT NULL;
ALTER TABLE "Announcement" ALTER COLUMN "showUntil" SET NOT NULL;
