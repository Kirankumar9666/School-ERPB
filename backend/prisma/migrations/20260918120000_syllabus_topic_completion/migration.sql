-- SyllabusEntry.topics: string[] → JSONB [{ topic, done }]
-- Existing rows keep every topic, all marked done:false — the old subject-level
-- completedPercent is dropped and never re-derived by guessing (per spec).

ALTER TABLE "SyllabusEntry" ADD COLUMN "topicsJson" JSONB NOT NULL DEFAULT '[]';

UPDATE "SyllabusEntry" SET "topicsJson" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('topic', t, 'done', false))
  FROM unnest("topics") AS t
), '[]'::jsonb);

ALTER TABLE "SyllabusEntry" DROP COLUMN "topics";
ALTER TABLE "SyllabusEntry" DROP COLUMN "completedPercent";

ALTER TABLE "SyllabusEntry" RENAME COLUMN "topicsJson" TO "topics";
