-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table openprofiles (
  person_id text PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  markdown text NOT NULL,
  sources_json text NOT NULL DEFAULT '[]',
  published_url text,
  generated_at text NOT NULL
);
