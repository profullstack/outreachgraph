-- 0075_workflows.sql (Postgres). See migrations/0075_workflows.sql for the reasoning.
CREATE TABLE IF NOT EXISTS workflows (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt text NOT NULL,
  template_id text,
  definition_json text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  published_version bigint,
  trigger_kind text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'draft',
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  next_run_at text,
  last_run_at text,
  last_run_status text,
  created_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workflows_due ON workflows (status, next_run_at);

CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  definition_json text NOT NULL,
  prompt text NOT NULL,
  note text,
  created_by text,
  created_at text NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  version bigint NOT NULL,
  run_trigger text NOT NULL,
  status text NOT NULL,
  slot_key text NOT NULL,
  attempt bigint NOT NULL DEFAULT 1,
  retry_of text,
  retry_at text,
  started_at text NOT NULL,
  finished_at text,
  steps_json text NOT NULL DEFAULT '[]',
  summary_json text NOT NULL DEFAULT '{}',
  error text
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs (workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_retry ON workflow_runs (status, retry_at);

CREATE TABLE IF NOT EXISTS workflow_step_effects (
  idempotency_key text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  node_id text NOT NULL,
  result_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
