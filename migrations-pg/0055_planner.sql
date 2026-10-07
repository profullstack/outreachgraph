-- 0055_planner.sql (Postgres). See migrations/0055_planner.sql for the reasoning.
-- One new, empty table with its indexes, and one ADD COLUMN with a constant default (no rewrite).

create table if not exists planner_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id text NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  period text NOT NULL,
  play_key text NOT NULL,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  cadence_id text REFERENCES cadences(id) ON DELETE SET NULL,
  people bigint NOT NULL DEFAULT 0,
  detail text,
  created_at text NOT NULL
);

create unique index if not exists idx_planner_runs_key on planner_runs(offering_id, period, play_key);
create index if not exists idx_planner_runs_ws on planner_runs(workspace_id, created_at);

ALTER TABLE offerings ADD COLUMN IF NOT EXISTS planner_enabled bigint NOT NULL DEFAULT 1;
