-- 0059_community_leads.sql (Postgres). See migrations/0059_community_leads.sql for the reasoning.

create table if not exists lead_monitors (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id text REFERENCES offerings(id) ON DELETE SET NULL,
  name text NOT NULL,
  url text,
  description text,
  keywords_json text NOT NULL DEFAULT '[]',
  subreddits_json text NOT NULL DEFAULT '[]',
  exclude_json text NOT NULL DEFAULT '[]',
  sources_json text NOT NULL DEFAULT '["reddit","hackernews","bluesky"]',
  enabled bigint NOT NULL DEFAULT 1,
  every_minutes bigint NOT NULL DEFAULT 360,
  min_intent bigint NOT NULL DEFAULT 60,
  digest bigint NOT NULL DEFAULT 1,
  last_scanned_at text,
  last_error text,
  last_result_json text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
create index if not exists idx_lead_monitors_ws on lead_monitors(workspace_id);

create table if not exists community_leads (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitor_id text NOT NULL REFERENCES lead_monitors(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  title text,
  excerpt text NOT NULL,
  author text NOT NULL,
  author_url text,
  container text,
  posted_at text NOT NULL,
  matched_term text,
  intent bigint NOT NULL DEFAULT 0,
  reason text,
  judged bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'new',
  reply_draft text,
  reply_drafted_at text,
  digested_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
create unique index if not exists idx_community_leads_post
  on community_leads(monitor_id, source, external_id);
create index if not exists idx_community_leads_ws
  on community_leads(workspace_id, status, intent, posted_at);
