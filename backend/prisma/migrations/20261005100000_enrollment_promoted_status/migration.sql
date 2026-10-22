-- Two additions the Class Management write paths turned out to need.
--
-- 1. EnrollmentStatus gains 'promoted'.
--    The first migration gave a row only 'active' / 'passed_out' / 'left_school',
--    which reads fine right up to the moment a student is promoted: their old row
--    has to stop being current, but none of those three values says WHY, so Class
--    History could list them in their 2024-25 class while being unable to answer
--    the only question that matters about a former student — "where did they go?".
--    A fourth state costs one enum value and makes the timeline self-explaining.
--
-- 2. Per-(class, year) roll-number uniqueness on the enrollment.
--    `Student` has always had @@unique([classId, rollNumber]); the per-year roll
--    numbers that moved onto StudentEnrollment would otherwise be the only roll
--    numbers in the app with no uniqueness guarantee, even though they are the ones
--    most likely to collide (every class hands out '1', '2', '3' each year).
--    Postgres treats NULLs as distinct, so the many unenrolled rows a promotion
--    legitimately leaves behind (a fresh roll number is the office's to assign,
--    not something this feature invents) do not violate it.

ALTER TYPE "EnrollmentStatus" ADD VALUE 'promoted';

CREATE UNIQUE INDEX "StudentEnrollment_classId_academicYearId_rollNumber_key"
    ON "StudentEnrollment"("classId", "academicYearId", "rollNumber");