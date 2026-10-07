-- 0062_autopilot_holds.sql: the autopilot hold ledger survives a restart.
--
-- Autopilot writes a "Held back" event when a card's hold reason is new or
-- changes, and remembered the reasons in memory only. Every deploy emptied
-- that memory, so the next tick wrote every held card again: 35,847 rows in
-- two weeks for 1,080 people, in bursts that line up with the deploys to the
-- minute. The reason a card is held now lives here, keyed by the card.
CREATE TABLE IF NOT EXISTS autopilot_holds (
  recommendation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The reason with its numbers masked, which is what "the same hold" means.
  reason_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  held_since TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autopilot_holds_ws ON autopilot_holds (workspace_id);
