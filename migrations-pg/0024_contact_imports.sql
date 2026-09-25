-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

-- `status` carries its CHECK before its DEFAULT: the driver's DDL pass misreads
-- `DEFAULT 'x' CHECK (...)` as one expression.
create table contact_imports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  campaign_id text,
  created_by text,
  filename text,
  consent_basis text NOT NULL DEFAULT 'opt_in',
  consent_source text,
  consent_at text,
  total_rows bigint NOT NULL DEFAULT 0,
  imported bigint NOT NULL DEFAULT 0,
  merged bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('open', 'complete', 'failed')) DEFAULT 'open',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_contact_imports_ws ON contact_imports(workspace_id, created_at DESC);

create table contact_import_rejects (
  id text PRIMARY KEY,
  import_id text NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  row_number bigint,
  email text,
  reason text NOT NULL,
  detail text,
  created_at text NOT NULL
);

CREATE INDEX idx_contact_import_rejects_import ON contact_import_rejects(import_id, reason);

create table person_consent (
  person_id text PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  basis text NOT NULL,
  source text,
  import_id text,
  recorded_at text NOT NULL
);

CREATE INDEX idx_person_consent_ws ON person_consent(workspace_id);

create table person_emails (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  address text NOT NULL,
  dedupe_key text NOT NULL,
  source text NOT NULL DEFAULT 'import',
  verified bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX idx_person_emails_unique ON person_emails(workspace_id, dedupe_key);

CREATE INDEX idx_person_emails_person ON person_emails(person_id);
