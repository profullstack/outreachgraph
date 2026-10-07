-- 0055_planner.sql
--
-- The Outreach Planner: each month's plays launched by the worker.
--
-- planner_runs is one row per product, month and play: the idempotency key
-- (a play runs once per month however many ticks see it) and the record of
-- what the planner launched, into which campaign, for how many people.
-- play_key 'refresh_lists' records a month's list refresh.
--
-- offerings.planner_enabled is the per-product switch. On by default: the
-- planner launches campaigns in the same approval mode as the product's own,
-- so a product whose campaigns wait for approval gets cards, not sends.

CREATE TABLE IF NOT EXISTS planner_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id   TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,
  play_key      TEXT NOT NULL,
  campaign_id   TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  cadence_id    TEXT REFERENCES cadences(id) ON DELETE SET NULL,
  people        INTEGER NOT NULL DEFAULT 0,
  detail        TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_runs_key ON planner_runs(offering_id, period, play_key);
CREATE INDEX IF NOT EXISTS idx_planner_runs_ws ON planner_runs(workspace_id, created_at);

ALTER TABLE offerings ADD COLUMN planner_enabled INTEGER NOT NULL DEFAULT 1;
