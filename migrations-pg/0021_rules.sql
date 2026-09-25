-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table automation_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL,
  condition_json text NOT NULL DEFAULT '{}',
  action text NOT NULL,
  action_json text NOT NULL DEFAULT '{}',
  enabled bigint NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_rules_ws ON automation_rules(workspace_id, enabled);

CREATE INDEX idx_rules_trigger ON automation_rules(workspace_id, trigger, enabled);

create table rule_runs (
  id text PRIMARY KEY,
  rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text REFERENCES people(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  detail text,
  occurred_at text NOT NULL,
  dedupe_key text NOT NULL
);

CREATE UNIQUE INDEX idx_rule_runs_once ON rule_runs(rule_id, dedupe_key);

CREATE INDEX idx_rule_runs_ws ON rule_runs(workspace_id, occurred_at DESC);
