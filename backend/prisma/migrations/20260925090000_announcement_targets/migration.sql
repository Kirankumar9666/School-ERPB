-- Announcements gain three things:
--   1. an optional real PDF attachment (bytes stored on the row, validated and
--      uploaded exactly like the EmployeeDocument/StudentDocument PDFs);
--   2. an explicit targeting scope, so an announcement can be addressed to a
--      single class's students or to every employee instead of only to a set of
--      role tags;
--   3. author attribution, so a circular a teacher pushed from the Employee
--      Portal is visibly theirs rather than the admin office's.
--
-- Everything is additive: existing rows keep working with targetScope = ROLES
-- and no attachment, so today's broad Audience-based circulars are untouched.

-- CreateEnum
CREATE TYPE "AnnouncementScope" AS ENUM ('ROLES', 'CLASS', 'EMPLOYEES');

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "pdfFileName" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "pdfData" BYTEA;
ALTER TABLE "Announcement" ADD COLUMN "targetScope" "AnnouncementScope" NOT NULL DEFAULT 'ROLES';
ALTER TABLE "Announcement" ADD COLUMN "targetClassId" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "attributedTo" TEXT;

-- Foreign keys for the new target / author references. ON DELETE SET NULL keeps a
-- deleted class or employee from taking its historical circulars with it — the
-- announcement stays on the recipients' feeds, just with no class/author label.
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_targetClassId_fkey"
  FOREIGN KEY ("targetClassId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Announcement_targetScope_idx" ON "Announcement"("targetScope");
CREATE INDEX "Announcement_targetClassId_idx" ON "Announcement"("targetClassId");
CREATE INDEX "Announcement_createdById_idx" ON "Announcement"("createdById");
