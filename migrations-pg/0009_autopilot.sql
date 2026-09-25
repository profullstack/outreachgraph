-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table campaigns add column if not exists seed_kind text;

alter table campaigns add column if not exists seed_value text;

alter table companies add column if not exists contact_email text;

create table workspace_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  notify_email text,
  instant_alerts bigint NOT NULL DEFAULT 1,
  daily_digest bigint NOT NULL DEFAULT 1,
  digest_hour_utc bigint NOT NULL DEFAULT 13,
  alert_min_opportunity bigint NOT NULL DEFAULT 60,
  autopilot_daily_cap bigint NOT NULL DEFAULT 25,
  reply_to_email text,
  last_digest_sent_on text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

create table notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  subject_key text NOT NULL,
  to_email text NOT NULL,
  sent_at text NOT NULL,
  error text
);

CREATE UNIQUE INDEX idx_notifications_once ON notifications(workspace_id, kind, subject_key);

CREATE INDEX idx_notifications_ws ON notifications(workspace_id, sent_at DESC);

create table lead_stage_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  stage text NOT NULL,
  occurred_at text NOT NULL
);

CREATE INDEX idx_lead_stage_person ON lead_stage_events(person_id, occurred_at);

CREATE INDEX idx_lead_stage_ws ON lead_stage_events(workspace_id, occurred_at DESC);

CREATE INDEX idx_lead_stage_campaign ON lead_stage_events(campaign_id, stage);
