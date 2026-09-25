-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table jobs add column if not exists batch_id text;

CREATE INDEX idx_jobs_batch ON jobs(batch_id, created_at) WHERE batch_id IS NOT NULL;
