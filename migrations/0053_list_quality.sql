-- 0053_list_quality.sql
--
-- Verify before sending, and stop a campaign that bounces (Hunter's outreach
-- planner, run by the worker rather than remembered by a person).
--
-- email_verifications is the verdict on one address: valid, catch_all,
-- unverified (the domain takes mail but no server could be asked) or invalid.
-- Keyed by the lower-cased address and shared across workspaces, because
-- whether a mailbox exists is a fact about the mailbox. A bounce writes
-- `invalid` here, which is what keeps a bounced address from ever being sent to
-- again. checked_at is what the 90-day re-verify reads.
--
-- campaign_list_health holds a campaign's bounce gate. window_start is where
-- its bounce rate is counted from; paused_at is set when the rate passed 2%
-- over 50+ sends, and cleared (with window_start moved forward) once every
-- queued address has been re-verified since the pause.

CREATE TABLE IF NOT EXISTS email_verifications (
  address     TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  reason      TEXT,
  mx          TEXT,
  checked_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_list_health (
  campaign_id   TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_start  TEXT NOT NULL,
  paused_at     TEXT,
  paused_rate   REAL,
  resumed_at    TEXT,
  updated_at    TEXT NOT NULL
);
