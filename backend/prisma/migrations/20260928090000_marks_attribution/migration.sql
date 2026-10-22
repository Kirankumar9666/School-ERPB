-- Marks gain attribution: who entered a mark and when, and who last changed it
-- and when. Until now a MarksEntry row carried no actor at all, so the Admin
-- Panel's Marks Entry could not say whether a mark came from the office or from
-- a teacher entering it in the Employee Portal.
--
-- Why four columns instead of one "last touched by/at" pair: "who entered" and
-- "who last changed" are genuinely different questions, and a correction should
-- never erase the fact of who first recorded the result. The read side shows
-- "entered by X, last changed by Y" when they differ and collapses to a single
-- line when they do not.
--
-- All four are optional with no default on the existing rows, so this is purely
-- additive: every mark already stored keeps working, and simply reads as having
-- no recorded author (the Admin Panel renders "—"). Same username-not-FK
-- convention as AttendanceConfirmation.markedBy — a staff member's login
-- username, not a hard reference, so deleting an employee never takes their
-- historical marks with it.
--
-- enteredAt deliberately does NOT get @default(now()): Prisma would stamp every
-- pre-existing row with the migration's run time, inventing a history that never
-- happened. It stays null until a row is actually (re)written by a saver.

-- AlterTable
ALTER TABLE "MarksEntry" ADD COLUMN "enteredBy" TEXT;
ALTER TABLE "MarksEntry" ADD COLUMN "enteredAt" TIMESTAMP(3);
ALTER TABLE "MarksEntry" ADD COLUMN "updatedBy" TEXT;
ALTER TABLE "MarksEntry" ADD COLUMN "updatedAt" TIMESTAMP(3);
