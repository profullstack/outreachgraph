-- 0062_autopilot_holds.sql (Postgres). See migrations/0062_autopilot_holds.sql for the reasoning.
CREATE TABLE IF NOT EXISTS autopilot_holds (
  recommendation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  held_since TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autopilot_holds_ws ON autopilot_holds (workspace_id);
