-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table tracked_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id text REFERENCES actions(id) ON DELETE SET NULL,
  target_url text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX idx_tracked_links_person ON tracked_links(person_id, created_at DESC);

CREATE INDEX idx_tracked_links_ws ON tracked_links(workspace_id, created_at DESC);

create table link_clicks (
  id text PRIMARY KEY,
  tracked_link_id text NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  automated text,
  user_agent text,
  occurred_at text NOT NULL
);

CREATE INDEX idx_link_clicks_person ON link_clicks(person_id, occurred_at DESC);

CREATE INDEX idx_link_clicks_link ON link_clicks(tracked_link_id, occurred_at DESC);

alter table workspace_settings add column if not exists track_links bigint NOT NULL DEFAULT 0;

alter table workspace_settings add column if not exists tracking_origin text;
