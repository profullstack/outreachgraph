-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table cadence_steps add column if not exists variants_json text;

alter table recommendations add column if not exists guidance text;

alter table recommendations add column if not exists variant text;

alter table cadence_step_runs add column if not exists variant text;

alter table workspace_settings add column if not exists track_opens bigint NOT NULL DEFAULT 0;

create table open_pixels (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id text REFERENCES actions(id) ON DELETE SET NULL,
  created_at text NOT NULL
);

CREATE INDEX idx_open_pixels_action ON open_pixels(action_id);

CREATE INDEX idx_open_pixels_ws ON open_pixels(workspace_id, created_at DESC);

create table email_opens (
  id text PRIMARY KEY,
  pixel_id text NOT NULL REFERENCES open_pixels(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  automated text,
  user_agent text,
  occurred_at text NOT NULL
);

CREATE INDEX idx_email_opens_pixel ON email_opens(pixel_id);

CREATE INDEX idx_email_opens_ws ON email_opens(workspace_id, occurred_at DESC);
