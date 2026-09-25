-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table people add column if not exists avatar_url text;

alter table people add column if not exists avatar_source text;

alter table people add column if not exists photo_looked_up_at text;

CREATE INDEX IF NOT EXISTS idx_people_photo_lookup
  ON people(photo_looked_up_at) WHERE photo_looked_up_at IS NULL;

alter table campaigns add column if not exists reseeded_at text;
