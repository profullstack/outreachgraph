-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  attempts bigint NOT NULL DEFAULT 0,
  max_attempts bigint NOT NULL DEFAULT 5,
  run_after text NOT NULL,
  last_error text,
  started_at text,
  finished_at text,
  dedupe_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_jobs_runnable ON jobs(status, run_after);

CREATE INDEX idx_jobs_workspace ON jobs(workspace_id, created_at DESC);

CREATE UNIQUE INDEX idx_jobs_dedupe
  ON jobs(workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');
