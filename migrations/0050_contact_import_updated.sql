-- 0050_contact_import_updated.sql: how many already-known people an import changed.
--
-- A re-import used to be a no-op past fifty rows a chunk and only ever filled
-- blanks. It now patches every known person with the row's newer data (see
-- planPatch in packages/pipeline/src/contact-import.ts), and this counts them,
-- so "6,204 already known" can say how many of those were actually updated.
ALTER TABLE contact_imports ADD COLUMN updated INTEGER NOT NULL DEFAULT 0;
