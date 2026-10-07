-- 0054_ab_results.sql
--
-- A/B tests on cadence steps decide themselves (Hunter's planner: 50+ per
-- arm, by reply rate, winners become the default).
--
-- One row per decided test. When a step's test is decided its winning angle
-- becomes the step's intent and its variants are cleared, so the row is the
-- only record of what was tried and why it lost. Later tests on the same
-- step count only runs after decided_at. The planner reads winners from here
-- as the default angle for the next campaign's plays.

CREATE TABLE IF NOT EXISTS ab_results (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cadence_id     TEXT NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  step_position  INTEGER NOT NULL,
  winner         TEXT NOT NULL,
  winner_intent  TEXT NOT NULL,
  basis          TEXT NOT NULL,
  reason         TEXT NOT NULL,
  arms_json      TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ab_results_cadence ON ab_results(cadence_id, step_position, decided_at);
CREATE INDEX IF NOT EXISTS idx_ab_results_workspace ON ab_results(workspace_id, decided_at);
