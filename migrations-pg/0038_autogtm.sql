-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table api_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  created_at text NOT NULL,
  last_used_at text,
  revoked_at text
);

CREATE INDEX idx_api_keys_ws ON api_keys(workspace_id, created_at DESC);

alter table offerings add column if not exists daily_budget_usd double precision;

alter table offerings add column if not exists autopilot bigint NOT NULL DEFAULT 0;

alter table campaign_people add column if not exists note text;

alter table suppression_entries add column if not exists name text;

alter table suppression_entries add column if not exists kind text;

CREATE INDEX idx_suppression_entries_list
  ON suppression_entries(workspace_id, kind, name);
