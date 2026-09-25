-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table interactions add column if not exists external_id text;

CREATE UNIQUE INDEX idx_interactions_external_id
  ON interactions(workspace_id, external_id)
  WHERE external_id IS NOT NULL;
