-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table company_identities (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  network text NOT NULL,
  handle text,
  profile_url text,
  confidence double precision NOT NULL,
  source_url text,
  first_seen_at text NOT NULL,
  last_seen_at text NOT NULL
);

CREATE UNIQUE INDEX idx_company_identities_unique
  ON company_identities(company_id, network, handle);

CREATE INDEX idx_company_identities_company
  ON company_identities(company_id);
