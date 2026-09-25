-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table invitations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL REFERENCES users(id),
  expires_at text NOT NULL,
  accepted_at text,
  accepted_by text REFERENCES users(id),
  revoked_at text,
  created_at text NOT NULL
);

CREATE INDEX idx_invitations_org ON invitations(organization_id, created_at);

CREATE UNIQUE INDEX idx_invitations_pending
  ON invitations(organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
