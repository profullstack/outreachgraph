-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table if not exists audience_watches (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  network text NOT NULL,
  account text NOT NULL,
  mode text NOT NULL DEFAULT 'poll',
  kinds_json text NOT NULL DEFAULT '["follow","like","repost","reply","mention"]',
  poll_minutes bigint NOT NULL DEFAULT 30,
  lookback_posts bigint NOT NULL DEFAULT 10,
  per_run_cap bigint NOT NULL DEFAULT 100,
  enabled bigint NOT NULL DEFAULT 1,
  last_polled_at text,
  last_error text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_watches_account
  ON audience_watches(workspace_id, campaign_id, network, account);

CREATE INDEX IF NOT EXISTS idx_audience_watches_due
  ON audience_watches(workspace_id, enabled, mode, last_polled_at);

create table if not exists audience_engagements (
  id text PRIMARY KEY,
  watch_id text NOT NULL REFERENCES audience_watches(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  signal_id text REFERENCES signals(id) ON DELETE SET NULL,
  network text NOT NULL,
  kind text NOT NULL,
  actor_handle text NOT NULL,
  engagement_key text NOT NULL,
  subject_id text,
  subject_url text,
  occurred_at text,
  observed_at text NOT NULL,
  source text NOT NULL,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_engagements_key
  ON audience_engagements(watch_id, engagement_key);

CREATE INDEX IF NOT EXISTS idx_audience_engagements_person
  ON audience_engagements(workspace_id, person_id, observed_at);
