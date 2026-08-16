-- 0009_autopilot.sql
-- Autopilot campaigns, contact addresses, and the notification ledger.
--
-- Three things the product needed before it could run unattended:
--
--   1. A campaign has to remember what it was started from — a URL or a
--      keyword — or the run is untraceable back to the thing the user typed.
--   2. Outreach needs an address. Until now nothing anywhere held one, so the
--      approval queue could only ever end in a human copying text elsewhere.
--   3. A notification that can fire twice is worse than one that never fires,
--      so every alert and digest is recorded and keyed for idempotency.

-- What the user typed to start this campaign. 'url' | 'keyword'.
ALTER TABLE campaigns ADD COLUMN seed_kind TEXT;
ALTER TABLE campaigns ADD COLUMN seed_value TEXT;

-- Role addresses (info@, sales@) belong to the company, not to a person: they
-- are a fallback for a company whose site names people but publishes no
-- personal address, and they are greeted differently because nobody named
-- Jane reads info@.
ALTER TABLE companies ADD COLUMN contact_email TEXT;

-- Per-workspace delivery settings. Its own table rather than columns on
-- `workspaces` because these are notification preferences with their own
-- lifecycle, and a workspace with no row still has working defaults.
CREATE TABLE workspace_settings (
  workspace_id           TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Where alerts and digests go. NULL means "the workspace owner's address",
  -- resolved at send time so a changed login address is not stale here.
  notify_email           TEXT,
  instant_alerts         INTEGER NOT NULL DEFAULT 1,
  daily_digest           INTEGER NOT NULL DEFAULT 1,
  -- Hour of the UTC day the digest is due. One send per calendar day.
  digest_hour_utc        INTEGER NOT NULL DEFAULT 13,
  -- A lead below this opportunity score is not worth interrupting anyone for.
  alert_min_opportunity  INTEGER NOT NULL DEFAULT 60,
  -- The backstop on unattended sending. Counted per UTC day, per workspace.
  autopilot_daily_cap    INTEGER NOT NULL DEFAULT 25,
  -- Reply-to on outbound outreach. NULL resolves to the owner, same as above.
  reply_to_email         TEXT,
  last_digest_sent_on    TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- Every notification the product has actually sent.
--
-- `subject_key` is what makes the send idempotent: the person id for a lead
-- alert, the UTC date for a digest. The unique index is the guard — a retried
-- job or a second worker cannot produce a second email.
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- lead_alert | daily_digest
  kind          TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  error         TEXT
);

CREATE UNIQUE INDEX idx_notifications_once ON notifications(workspace_id, kind, subject_key);
CREATE INDEX idx_notifications_ws ON notifications(workspace_id, sent_at DESC);

-- Every stage a lead has moved through, with when.
--
-- `campaign_people.status` holds the *current* state and overwrites the last
-- one, which answers "where is this lead now" and nothing else. A funnel needs
-- the other questions — how many reached each stage, how long they sat there,
-- what fell out and where — and none of those are answerable from a column
-- that keeps no history. This is that history.
--
-- `stage` is stored alongside `to_status` rather than derived on read because
-- the internal state machine has sixteen states and the funnel has six: if the
-- mapping is ever changed, past events keep the stage they were actually
-- reported under, and old charts do not silently rewrite themselves.
CREATE TABLE lead_stage_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  stage         TEXT NOT NULL,
  occurred_at   TEXT NOT NULL
);

CREATE INDEX idx_lead_stage_person ON lead_stage_events(person_id, occurred_at);
CREATE INDEX idx_lead_stage_ws ON lead_stage_events(workspace_id, occurred_at DESC);
CREATE INDEX idx_lead_stage_campaign ON lead_stage_events(campaign_id, stage);
