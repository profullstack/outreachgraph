-- 0050_contact_import_updated.sql (Postgres). See migrations/0050_contact_import_updated.sql.
ALTER TABLE contact_imports ADD COLUMN IF NOT EXISTS updated bigint NOT NULL DEFAULT 0;
