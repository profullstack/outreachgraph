-- 0049_ideas.sql (Postgres). See migrations/0049_ideas.sql for the reasoning.

create table if not exists idea_scans (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  subs_json text NOT NULL DEFAULT '[]',
  feeds_json text,
  enabled bigint NOT NULL DEFAULT 1,
  every_minutes bigint NOT NULL DEFAULT 360,
  build_at bigint NOT NULL DEFAULT 5,
  window_days bigint NOT NULL DEFAULT 60,
  last_scanned_at text,
  last_error text,
  last_result_json text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

create table if not exists ideas (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  named bigint NOT NULL DEFAULT 0,
  terms_json text NOT NULL DEFAULT '[]',
  rivals_json text NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'watching',
  first_at text NOT NULL,
  last_at text NOT NULL,
  flagged_at text,
  handoff_url text,
  handoff_at text,
  handoff_by text,
  notes text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id, status, last_at);

create table if not exists idea_asks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id text NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  post_id text NOT NULL,
  sub text NOT NULL,
  title text NOT NULL,
  body text,
  url text NOT NULL,
  author text NOT NULL,
  posted_at text NOT NULL,
  confidence double precision NOT NULL,
  kind text NOT NULL,
  wants_json text NOT NULL DEFAULT '[]',
  label text,
  judged bigint NOT NULL DEFAULT 0,
  post_score bigint,
  comments bigint,
  source text NOT NULL DEFAULT 'reddit',
  paid bigint NOT NULL DEFAULT 0,
  revenue text,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idea_asks_post ON idea_asks(workspace_id, post_id);
CREATE INDEX IF NOT EXISTS idx_idea_asks_idea ON idea_asks(idea_id);

create table if not exists idea_seen (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id text NOT NULL,
  seen_at text NOT NULL,
  PRIMARY KEY (workspace_id, post_id)
);
