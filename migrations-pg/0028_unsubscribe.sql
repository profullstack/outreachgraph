-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table unsubscribe_tokens (
  token text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL,
  campaign_id text,
  contact_address text NOT NULL,
  created_at text NOT NULL,
  used_at text
);

CREATE INDEX idx_unsubscribe_tokens_person ON unsubscribe_tokens(person_id);

CREATE INDEX idx_unsubscribe_tokens_address ON unsubscribe_tokens(workspace_id, contact_address);
