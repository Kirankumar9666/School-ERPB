-- Document downloads: the uploaded PDF bytes (validated at upload time) are
-- now stored on the document row so the authenticated download endpoints can
-- serve the real file back. Nullable — rows created before this migration are
-- metadata-only records with no stored file (the seed generates demo bytes
-- for its own document records).

ALTER TABLE "EmployeeDocument" ADD COLUMN "data" BYTEA;
ALTER TABLE "StudentDocument" ADD COLUMN "data" BYTEA;
