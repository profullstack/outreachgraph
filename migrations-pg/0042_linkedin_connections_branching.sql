-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table cadence_steps add column if not exists run_condition text;

alter table cadence_steps add column if not exists wait_for_acceptance_hours bigint;

create table linkedin_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id text REFERENCES actions(id) ON DELETE SET NULL,
  profile_ref text NOT NULL,
  profile_urn text,
  status text NOT NULL,
  invited_at text,
  accepted_at text,
  last_checked_at text,
  next_check_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (workspace_id, person_id)
);

CREATE INDEX idx_linkedin_connections_due
  ON linkedin_connections(workspace_id, status, next_check_at);
