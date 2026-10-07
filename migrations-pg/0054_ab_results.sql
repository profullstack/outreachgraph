-- 0054_ab_results.sql (Postgres). See migrations/0054_ab_results.sql for the reasoning.
-- One new, empty table and its indexes. Nothing existing is altered.

create table if not exists ab_results (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cadence_id text NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  step_position bigint NOT NULL,
  winner text NOT NULL,
  winner_intent text NOT NULL,
  basis text NOT NULL,
  reason text NOT NULL,
  arms_json text NOT NULL,
  decided_at text NOT NULL
);

create index if not exists idx_ab_results_cadence on ab_results(cadence_id, step_position, decided_at);
create index if not exists idx_ab_results_workspace on ab_results(workspace_id, decided_at);
