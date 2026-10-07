-- 0058_list_sources.sql (Postgres). See migrations/0058_list_sources.sql for the reasoning.
-- Two new, empty tables with indexes. Nothing existing is altered.

create table if not exists list_source_runs (
  offering_id text NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  kind text NOT NULL,
  period text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  items bigint NOT NULL DEFAULT 0,
  error text,
  ran_at text NOT NULL,
  PRIMARY KEY (offering_id, kind, period)
);

create table if not exists list_source_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id text NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  kind text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  company text,
  domain text,
  person text,
  role text,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at text NOT NULL
);

create unique index if not exists idx_list_source_items_url on list_source_items(offering_id, url);
create index if not exists idx_list_source_items_ws on list_source_items(workspace_id, created_at);
