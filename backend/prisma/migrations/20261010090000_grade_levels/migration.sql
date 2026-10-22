-- Named class levels (Nursery, LKG, UKG, 1, 2, … 10).
--
-- ADDITIVE ONLY: the table is created, rows are inserted, and one nullable column
-- is added to Class and backfilled. No existing row is deleted or rewritten, no
-- migrate reset and no --accept-data-loss.
--
-- WHY `order` MATCHES THE EXISTING `Class.grade` VALUES
-- `Class.grade` is left holding the level's order, so Class 5A keeps grade 5, its
-- id, its students, its attendance, its marks, its fees and its enrollments — all
-- untouched, and every existing query, index and sort keeps working. Pre-primary
-- levels simply sit below 1, which is exactly the order the school teaches them
-- in.

-- CreateTable
CREATE TABLE "GradeLevel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GradeLevel_name_key" ON "GradeLevel"("name");
CREATE UNIQUE INDEX "GradeLevel_order_key" ON "GradeLevel"("order");

-- The school's level list, as ordinary data rows. These are DATA, not constants:
-- the admin can add to them and the app reads the list back out of this table.
-- The orders are contiguous with the grades already on Class, so no class row
-- changes. Inserting a level between two others renumbers inside a transaction
-- (services/classes.js), which is why the value is the only internal part.
INSERT INTO "GradeLevel" ("id", "name", "order") VALUES
('gl-nursery', 'Nursery', -2),
('gl-lkg',      'LKG',      -1),
('gl-ukg',      'UKG',       0),
('gl-01',       '1',         1),
('gl-02',       '2',         2),
('gl-03',       '3',         3),
('gl-04',       '4',         4),
('gl-05',       '5',         5),
('gl-06',       '6',         6),
('gl-07',       '7',         7),
('gl-08',       '8',         8),
('gl-09',       '9',         9),
('gl-10',       '10',       10);

-- Link every existing class to the level whose order equals its grade. A class
-- whose grade has no matching level keeps NULL; scripts/audit-levels.js reports
-- any such row rather than silently leaving it unlinked.
ALTER TABLE "Class" ADD COLUMN "levelId" TEXT;

UPDATE "Class" c
SET "levelId" = g."id"
FROM "GradeLevel" g
WHERE g."order" = c."grade";

CREATE INDEX "Class_levelId_idx" ON "Class"("levelId");

ALTER TABLE "Class"
ADD CONSTRAINT "Class_levelId_fkey"
FOREIGN KEY ("levelId") REFERENCES "GradeLevel"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- The same uniqueness rule as [grade, section], expressed on the level.
CREATE UNIQUE INDEX "Class_levelId_section_key" ON "Class"("levelId", "section");
