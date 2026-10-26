-- 0075_workflows.sql: custom workflows (Engineering Contract Outreach PRD §14).
--
-- A workflow is written in English and stored as a typed node graph
-- (packages/domain/src/workflow-graph.ts). Every edit is a new row in
-- `workflow_versions`; only the version named by `published_version` runs,
-- and only while `status = 'active'`. `trigger_kind` mirrors the published
-- schedule so the worker can find event-triggered workflows without parsing
-- JSON.
--
-- `workflow_runs` is the history and the error log: one row per execution,
-- dry runs included, with each step's outcome in `steps_json`. A failed run
-- is retried with backoff as a new row (`retry_of`, `attempt`) on the same
-- `slot_key`, and becomes `dead_letter` when the attempts run out.
--
-- `workflow_step_effects` is what makes a retry or a resume safe: a step that
-- changes state records its idempotency key (workflow, slot, step) here, and
-- a replay of the same slot finds it and does not act twice. The primary key
-- is the lock; two workers racing for one step cannot both insert it.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  template_id TEXT,
  definition_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER,
  trigger_kind TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'draft',
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workflows_due ON workflows (status, next_run_at);

CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  run_trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_of TEXT,
  retry_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs (workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_retry ON workflow_runs (status, retry_at);

CREATE TABLE IF NOT EXISTS workflow_step_effects (
  idempotency_key TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
