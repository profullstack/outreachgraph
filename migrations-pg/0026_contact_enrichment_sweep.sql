-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table people add column if not exists contact_enriched_at text;

CREATE INDEX idx_people_contact_enrichment
  ON people(contact_enriched_at) WHERE contact_enriched_at IS NULL;
