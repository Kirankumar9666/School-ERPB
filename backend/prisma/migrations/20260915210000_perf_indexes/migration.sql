-- Performance indexes for ~1000-concurrent-user readiness (perf audit 2026-09-15).
-- Additive only: new indexes, no column/table changes, no data migration.
-- The GIN index cannot be expressed in the Prisma schema (scalar-list filter),
-- so it lives here alongside the schema-derived btree indexes.

-- LeaveRequest.employeeId — per-employee leave history reads
CREATE INDEX "LeaveRequest_employeeId_idx" ON "LeaveRequest"("employeeId");

-- EmployeeDocument.employeeId — per-employee document lists
CREATE INDEX "EmployeeDocument_employeeId_idx" ON "EmployeeDocument"("employeeId");

-- Achievement.studentId — per-student achievement lists
CREATE INDEX "Achievement_studentId_idx" ON "Achievement"("studentId");

-- TeachingAssignment.classId — class rosters / headcounts via class relation
CREATE INDEX "TeachingAssignment_classId_idx" ON "TeachingAssignment"("classId");

-- Announcement.targetRoles — `where: { targetRoles: { has: role } }` runs for
-- every user of every role on the announcements endpoints; a GIN index makes
-- the Postgres scalar-array containment check index-backed.
CREATE INDEX "Announcement_targetRoles_idx" ON "Announcement" USING GIN ("targetRoles");
