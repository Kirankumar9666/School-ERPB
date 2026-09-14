-- RollNumber uniqueness moves from global to per-class: two classes can each
-- have their own 'STU-2026-001' (the auto-generation in the bulk upload and
-- the API contract are class-scoped). Existing data is already globally
-- unique, so the composite index can be created safely.
DROP INDEX "Student_rollNumber_key";

CREATE UNIQUE INDEX "Student_classId_rollNumber_key" ON "Student"("classId", "rollNumber");