-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

-- `status` carries its CHECK before its DEFAULT: the driver's DDL pass misreads
-- `DEFAULT 'x' CHECK (...)` as one expression.
create table email_candidates (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  person_id text NOT NULL,
  address text NOT NULL,
  pattern text NOT NULL,
  derived bigint NOT NULL DEFAULT 0,
  confidence double precision NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')) DEFAULT 'proposed',
  basis text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  decided_by text,
  decided_at text
);

CREATE UNIQUE INDEX idx_email_candidates_unique
  ON email_candidates(workspace_id, person_id, address);

CREATE INDEX idx_email_candidates_queue
  ON email_candidates(workspace_id, status, confidence DESC);

CREATE INDEX idx_email_candidates_person
  ON email_candidates(person_id, status);
