-- The school's stored "final class".
--
-- ADDITIVE ONLY: one column is added with a NOT NULL DEFAULT false, so every
-- existing level becomes "not final" and the behaviour of a school that has not
-- set one is exactly what it is today (the app keeps its derived fallback).
-- No row is deleted, rewritten or renumbered.
--
-- WHY ON GradeLevel AND NOT ON Class
-- "Which class graduates" is a property of the LEVEL, not of one section: the
-- office thinks "Class 10 is our last year", and every section of it graduates
-- together. Putting it on the level also means a new section of the final class
-- inherits the fact instead of needing its own flag.
--
-- WHY A PARTIAL UNIQUE INDEX
-- "Only one level can be final" is a data rule, so it is enforced by the
-- database and not merely by the service: an UPDATE path that forgot to clear
-- the previous final would otherwise leave two, and the app would have to guess.
-- The predicate (`WHERE "isFinal" = true`) is what allows every other row to be
-- false — a plain UNIQUE("isFinal") would allow at most one false row too.
--
-- The service (services/classes.js `setFinalLevel`) also clears-then-sets inside
-- one transaction, so the ordinary path never trips this index. The index is the
-- guarantee; the transaction is the smooth interaction.

ALTER TABLE "GradeLevel" ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "GradeLevel_one_final_key" ON "GradeLevel" ("isFinal") WHERE "isFinal" = true;
