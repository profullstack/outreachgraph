-- 0044_sender_pool.sql
-- Several sending accounts per network, each with its own cap and warm-up.
--
-- Until now a workspace had one mailbox, one LinkedIn session and one X
-- account, and connecting a second replaced the first. That capped a
-- workspace's volume at whatever one identity could safely send, and the only
-- way past it was to push that identity harder — the thing that gets mailboxes
-- junked and profiles restricted. The pool keeps every account a workspace
-- connects, spreads sends across them, and ramps each new one up slowly.
--
-- Every column is nullable or defaulted so an existing single-account
-- workspace reads exactly as it did: one active account, no warm-up, and a cap
-- no lower than the limit it was already running under (see the backfill).

-- A name a human chose ("Ana's mailbox", "sales@"), shown beside the handle.
ALTER TABLE integration_accounts ADD COLUMN label TEXT;

-- The most this account may send in a UTC day once warmed up. NULL means the
-- network default in `DEFAULT_DAILY_CAP` (packages/domain/src/sender-pool.ts).
ALTER TABLE integration_accounts ADD COLUMN daily_cap INTEGER;

-- Warm-up: while on, the day's cap is min(daily_cap, ramp(days since start)).
-- Off by default so existing accounts, which have been sending for months,
-- are not suddenly throttled to five a day; new connections switch it on.
ALTER TABLE integration_accounts ADD COLUMN warmup_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_accounts ADD COLUMN warmup_started_at TEXT;

-- Why the account is not active, in words a human can act on: the provider's
-- rejection text, or the bounce rate that stopped it.
ALTER TABLE integration_accounts ADD COLUMN status_reason TEXT;

-- When a human last cleared the account's health. Bounces before this instant
-- no longer count, so resuming a stopped mailbox is not undone by the very
-- bounces that stopped it.
ALTER TABLE integration_accounts ADD COLUMN health_reset_at TEXT;

-- Per-account configuration. Until now the mailbox's host, port and addresses
-- lived on the `integrations` row, which is unique per workspace and network
-- and so could only ever describe one mailbox. Two mailboxes need two.
ALTER TABLE integration_accounts ADD COLUMN config_json TEXT;

UPDATE integration_accounts
   SET config_json = (
     SELECT i.config_json FROM integrations i WHERE i.id = integration_accounts.integration_id
   )
 WHERE network = 'email' AND config_json IS NULL;

-- No existing mailbox gets a tighter limit than it was already running under.
-- The email default is 50 a day; a workspace that had raised its autopilot cap
-- or a campaign's `maxActionsPerDay` above that keeps the higher number as its
-- mailbox's cap, because with one mailbox those limits were that mailbox's.
UPDATE integration_accounts
   SET daily_cap = MAX(
     COALESCE((SELECT ws.autopilot_daily_cap FROM workspace_settings ws
                WHERE ws.workspace_id = integration_accounts.workspace_id), 0),
     COALESCE((SELECT MAX(CAST(json_extract(c.budget_json, '$.maxActionsPerDay') AS INTEGER))
                 FROM campaigns c
                WHERE c.workspace_id = integration_accounts.workspace_id
                  AND json_valid(c.budget_json)), 0)
   )
 WHERE network = 'email'
   AND daily_cap IS NULL
   AND MAX(
     COALESCE((SELECT ws.autopilot_daily_cap FROM workspace_settings ws
                WHERE ws.workspace_id = integration_accounts.workspace_id), 0),
     COALESCE((SELECT MAX(CAST(json_extract(c.budget_json, '$.maxActionsPerDay') AS INTEGER))
                 FROM campaigns c
                WHERE c.workspace_id = integration_accounts.workspace_id
                  AND json_valid(c.budget_json)), 0)
   ) > 50;

-- Which account an action went out from. The spine of the whole feature:
-- conversation continuity reads the last one used for a person, and each
-- account's "sent today" is a count over it. NULL for everything sent before
-- pools, and for the platform sender, which is not a workspace account.
ALTER TABLE actions ADD COLUMN sender_account_id TEXT;

CREATE INDEX idx_actions_sender_day ON actions(sender_account_id, created_at);
CREATE INDEX idx_actions_sender_person ON actions(workspace_id, person_id, network, created_at);

-- Things that happened to an account that bear on its health. Only bounces
-- and auth failures today. `external_id` is the bounce message's own id, so a
-- mailbox polled twice does not count one bounce twice.
CREATE TABLE sender_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  external_id   TEXT,
  detail        TEXT,
  occurred_at   TEXT NOT NULL
);

CREATE INDEX idx_sender_events_account ON sender_events(account_id, kind, occurred_at);
CREATE UNIQUE INDEX idx_sender_events_once
  ON sender_events(account_id, external_id)
  WHERE external_id IS NOT NULL;
